# D.E.N.N.I.S. - notes for Claude Code

Electron app + local Node server + browser UI. Claude (`claude-opus-5-5`, official `@anthropic-ai/sdk`) is the agent brain. Plain ESM JavaScript; there is no build step except `npm install` (which vendors browser libs into `ui/vendor/` and renders `build/icon.png`).

## Layout
- `electron/main.mjs`: app shell. Starts the server in-process, sets camera/mic permissions, safeStorage key encryption, global summon shortcut, and the `DENNIS_SMOKE=out.png` screenshot hook.
- `server/index.js`: HTTP API on 127.0.0.1 (cookie + Host + X-Dennis checks) and SSE chat stream. `server/cli.mjs` runs it without Electron (`--mock`, `--port`, `--home`).
- `server/agent.js`: the streaming tool-use loop. The personality (Jarvis meets Sean Connery) is the `# Personality` block in `systemPrompt()`; the user's Settings → Personality tweaks text is appended there and takes priority. **History is append-only for a conversation.** Never edit earlier messages, the system prompt, or the tool list mid-conversation; per-message context goes in the new user message. Settings changes start a fresh conversation.
- `server/tools.js`: every tool runs through `ctx.safe()` (paths.js root gate) and `validate()`. Approval-gated tools declare `approval`. There is deliberately no delete tool, nothing overwrites, and executables never launch.
- `server/fsindex.js`: background crawl, search, and folder totals. `server/mock.js`: the no-key demo brain.
- `ui/js/galaxy.js` (three.js scene), `hands.js` (MediaPipe + gesture engine; thresholds in `TUNING`), `voice.js` + `stt-worker.js` (TTS + local Whisper, single-threaded on purpose), `app.js` (controller: one input model for mouse, hands and voice).

## Checks before calling a change done
- `npm run check`: offline self-test (paths, validation, the agent loop against a fake Claude API, server auth).
- UI: `npm run mock`, open the printed link; add `?probe=1` for the gesture battery (expect 10/10), `?sim=1` for synthetic hands.
- Desktop: `DENNIS_SMOKE=shot.png npm start -- --mock` writes a screenshot and quits.

## Environment quirks on the original dev PC (Windows, locked down)
- PowerShell runs in constrained language mode, so `npm` through PowerShell breaks. Use Git Bash or `npm.cmd`.
- electron-builder can hit `EPERM rename ... Cache\...tmp` (antivirus). Workaround in README → Troubleshooting.
