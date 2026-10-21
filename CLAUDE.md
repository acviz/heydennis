# D.E.N.N.I.S. - notes for Claude Code

Electron app + local Node server + browser UI. Claude (`claude-opus-5-5`, official `@anthropic-ai/sdk`) is the agent brain. Plain ESM JavaScript; there is no build step except `npm install` (which vendors browser libs into `ui/vendor/` and renders `build/icon.png`).

## Layout
- `electron/main.mjs`: app shell. Starts the server in-process, sets camera/mic permissions, safeStorage key encryption, global summon shortcut, and the `DENNIS_SMOKE=out.png` screenshot hook.
- `server/index.js`: HTTP API on 127.0.0.1 (cookie + Host + X-Dennis checks) and SSE chat stream. `server/cli.mjs` runs it without Electron (`--mock`, `--port`, `--home`).
- `server/agent.js`: the streaming tool-use loop. The personality (Jarvis meets Sean Connery) is the `# Personality` block in `systemPrompt()`; the user's Settings → Personality tweaks text is appended there and takes priority. **History is append-only for a conversation.** Never edit earlier messages, the system prompt, or the tool list mid-conversation; per-message context goes in the new user message. Settings changes start a fresh conversation.
- `server/tools.js`: every tool runs through `ctx.safe()` (paths.js root gate) and `validate()`. Approval-gated tools declare `approval`. There is deliberately no delete tool, nothing overwrites, and executables never launch, except the user's authorized apps (below).
- `server/fsindex.js`: background crawl, search, and folder totals. `server/mock.js`: the no-key demo brain.
- Capabilities (UI in `ui/js/caps.js`, the star icon):
  - `server/skills.js`: SKILL.md skills in `~/.dennis/skills`. Their names and descriptions go into the system prompt; `use_skill` loads the full instructions. Skill scripts never run.
  - `server/mcp.js`: `McpHub`, an MCP client over stdio and HTTP. Server tools become `mcp__<server>__<tool>`; anything not marked `readOnlyHint` needs approval. A change in connected tools starts a fresh conversation (`conv.mcpVersion`).
  - `server/minions.js`: `MinionManager` runs worker agents in the background using `agent.callModel` / `runTool`, with scoped toolsets (`TOOLSETS` / `TOOLSET_OF` in tools.js). Their approvals and progress go to every window over `/api/events`. Finished reports are injected into Dennis's next user message as `<minion_report>`.
  - Document skills: `docSkills` in the config adds the code-execution tool, `container.skills` and the `code-execution-2025-08-25` beta (`agent.params`). `save_generated_file` downloads sandbox output through the Files API. If the key can't use the sandbox, `callModel` turns document skills off and carries on.
- Helpers: `server/brains.js` (OpenAI-compatible brains: GPT, Gemini, Ollama, custom; `callCompat` turns their stream into the same events as Claude's), `undo.js` (every create/move is recorded; undo moves things back or parks them in `~/.dennis/undone`, never deletes), `reminders.js`, `watcher.js` (folder watcher: batches of new files and low disk space, with cooldowns, quiet hours and DND), `office.js`.
- UI round trip: `ctx.uiAsk(event)` (agent.js toolContext) emits a `ui` event with a `reply` id and waits for `POST /api/ui-reply`. `show_diagram` uses it: the window renders the Mermaid (`ui/js/diagram.js`, Mermaid vendored to `ui/vendor/mermaid/`), then answers with ok/error (and the PNG/SVG when saving).
- `ui/js/themes.js`: the looks (reactor, spiral, neural, grid). Each scenery is procedural three.js (TSL shaders, instanced sprites, line segments), built when chosen and disposed when left. Never dispose a Sprite's geometry (three shares one across all sprites, the core's particles included) or the shared `tex.glow`. `galaxy.setTheme` crossfades; `THEMES[name].base` sets how much of the grid, stars, floor and dais shows. Keep sceneries dim, with no white glows: the core and windows must stay the brightest things.
- Messaging (`server/remote.js` = `RemoteHub`; `whatsapp.js`, `teams.js`): a phone message from an allowlisted sender becomes `agent.turn` with `context.input = "remote"`; the reply is sent back. Approvals go to the chat (buttons / YES) and to the desk; `onEvent` forwards finished minions and minion approvals, index.js forwards reminders and watcher notices (only while away: `/api/presence` heartbeats). WhatsApp runs its own listener (only `/whatsapp`, HMAC-checked with the app secret) for a tunnel; Teams polls one chat via Graph (device-code sign-in, refresh token as a secret). Tokens are secrets (`setSecret`), never in `publicView`. Tested against fakes in the selftest.
- Continuous conversation: `handsfree.setContinuous()` makes the conversation state sticky (entered without the wake word, never idles out; `stop()` clears it). The app's `setContinuous()` owns `S.continuous` (persisted as `voice.continuous`); toggles: CONVO chip, L, instant commands, thumbs-up (`hands.js` `thumbUp`, kept apart from `fist`), the orb's menu, `control_interface`.
- Apps and the browser:
  - `server/apps.js`, `AppLauncher`: the user's authorized apps (`config.apps`, cleaned by `cleanApps`), the only things `open_app` launches. A web app (`page`, plus optional `run` and `ready`) is opened if it answers; otherwise `run` starts it and `watch()` polls, then broadcasts `{type:"app", phase:"ready"|"failed"}`.
  - `add_app` calls `ctx.requestApproval` inside its own `run`, so auto mode can't skip it.
  - The `browser` tool drives `<webview>` windows (`fillWeb` in app.js, kind `"web"`, flat and still via `galaxy.openWindow(..., { flat })`). It reads and captures them through `dennisShell.webRead/webLook` → `main.mjs` IPC.
  - `main.mjs` locks guests down: partition `persist:dennis-web`, no preload or Node, http(s) only, never our own origin, permissions denied, plain-Chrome user agent.
  - Testing webviews:
    - `webContents.sendInputEvent` doesn't reach them; use the debugger (`Input.dispatchMouseEvent`).
    - A page that failed to load draws over DOM placed on it, so the failure notice hides the webview.
- `ui/js/galaxy.js` (three.js scene), `hands.js` (MediaPipe + gesture engine; thresholds in `TUNING`), `voice.js` + `stt-worker.js` (TTS + local Whisper, single-threaded on purpose), `app.js` (controller: one input model for mouse, hands and voice).
- `ui/js/reader.js`: the document reader in file windows. PDF (PDF.js legacy build, vendored to `ui/vendor/pdfjs/`, pages drawn on canvases as they scroll into view and released when far away), .docx (mammoth), .xlsx/.csv/.tsv (own zip + XML reader: merged cells, number formats, sheet tabs), .pptx (own: slides rebuilt from master, layout and slide shapes with PowerPoint's style inheritance), Markdown (marked; raw HTML stays text). Everything renders from `/api/raw` bytes in the page: keep the raw-file sandbox CSP and the page's cross-origin isolation as they are (Chromium's own PDF viewer can't run under them). Converted HTML goes through `sanitize()`; web links open in the real browser. `.pbody` stays the scroll container so pinch-drag scrolls documents.

## Checks before calling a change done
- `npm run check`: offline self-test (paths, validation, the agent loop against a fake Claude API, server auth).
- UI: `npm run mock`, open the printed link; add `?probe=1` for the gesture battery (expect 11/11), `?sim=1` for synthetic hands.
- Desktop: `DENNIS_SMOKE=shot.png npm start -- --mock` writes a screenshot and quits.
- Themes and diagrams are visual: check them in the running app (screenshot every theme after a change, and watch the console for WebGPU validation errors).

## Environment quirks on the original dev PC (Windows, locked down)
- PowerShell runs in constrained language mode, so `npm` through PowerShell breaks. Use Git Bash or `npm.cmd`.
- electron-builder can hit `EPERM rename ... Cache\...tmp` (antivirus). Workaround in README → Troubleshooting.
