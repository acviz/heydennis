# D.E.N.N.I.S.

**Digital Entity Neural Network Intelligent System**, your virtual production assistant: a Jarvis-style assistant that runs on your own computer. Claude is the brain. Your files float around a glowing core as a 3D galaxy, and you steer it with your bare hands through the webcam, with your voice, or with the mouse.

- **See everything.** The interface is a minimal 3D hologram rendered with WebGPU. At its centre, his core is a particle sphere that ripples as he speaks and draws in as he listens. It floats over a ring dais that turns slowly. Every folder and file is a floating hologram window: images show their thumbnail and documents show their opening lines. Folders orbit the core; in big folders, files fan out on spiral arms by kind, newest nearest the core. Around the edges sit a 12-hour clock, the folder's file-type mix, 30-day activity, a live voice waveform and a telemetry readout. Diving into a folder sets off a shockwave, and the new windows launch out of the core.
- **Talk to it.** Say **"Hey Dennis"** (or "Dennis?", "Sup Dennis?") and just talk. The conversation stays open, with no wake word needed, until you say "that's all". You can also tap `Space`, the mic button, or the core, or hold up an open palm. Speech is transcribed **on your machine** by Whisper. Replies are spoken aloud.
- **It acts.** "Find my invoices from March." "What's taking up space in Downloads?" "Read this PDF and tell me the deadline." "Put all the screenshots on my desktop into a folder called Screenshots." D.E.N.N.I.S. searches, reads (text, Word, Excel, PowerPoint, PDF, images), puts results on screen, creates notes and folders, and moves or renames files, asking you first.
- **It remembers.** Lasting facts go into a plain markdown file you can read and edit.
- **It has a personality.** Jarvis meets Sean Connery: a sophisticated gentleman with dry wit, a little sarcasm and a warm Scottish edge. He gets serious when something's at stake. Adjust him in Settings → **Personality tweaks**, for example "more sarcasm" or "call me Captain".

---

## Install

### Option A: installer (end users)

Build once (see [Building installers](#building-installers)), then copy the installer to any machine:

| | File | Notes |
|---|---|---|
| Windows | `dist/DENNIS Setup 0.1.0.exe` | Unsigned, so SmartScreen may warn: **More info → Run anyway**. |
| macOS | `dist/DENNIS-0.1.0-arm64.dmg` / `-x64.dmg` | Unsigned. If macOS says the app is damaged or can't be opened, run `xattr -cr /Applications/DENNIS.app` once, then right-click → **Open**. |
| Linux | `dist/DENNIS-0.1.0.AppImage` | `chmod +x` it and run. |

### Option B: run from source (any Mac or PC with Node.js 20+)

```bash
git clone <this repo> dennis && cd dennis
npm install
npm start
```

Or double-click **`start.bat`** (Windows) or **`start.command`** (macOS). They install the dependencies the first time and then launch the app.

`npm install` also copies three.js, MediaPipe and the Whisper runtime into `ui/vendor/` and downloads the hand-tracking model (about 7.5 MB), so the app itself never loads code from a CDN.

### First run

The setup screen asks for:

1. **Your name**, and optionally how D.E.N.N.I.S. should address you.
2. **A Claude API key** from [console.anthropic.com](https://console.anthropic.com). In the desktop app it is encrypted with your OS keychain. Alternatively, set `ANTHROPIC_API_KEY` before launching.
3. **Which folders it may see.** Desktop, Documents, Downloads, Pictures, Music and Videos are pre-filled; add or remove any, including whole drives. D.E.N.N.I.S. can't see or touch anything outside these folders.

Then allow the camera and microphone when asked. On the first talk, the speech model downloads once (about 80 MB) and is cached.

**His voice** is a natural British male voice ("Daniel") that runs on your graphics card. It downloads once (about 300 MB) and works offline after that. For a fully human voice, choose **ElevenLabs** in Settings → Voice engine and paste your ElevenLabs key; the default ElevenLabs voice is a British male, and you can change the voice ID. On a machine without GPU support he falls back to the system voice. If he ends up on the system voice, He picks the deepest British male voice he can find.
- **Windows:** Settings → Time & language → Speech → **Add voices** → English (United Kingdom). This adds "Microsoft George".
- **macOS:** System Settings → Accessibility → Spoken Content → System voice → Manage Voices → English (UK), for example "Daniel".

Then choose the voice in D.E.N.N.I.S.'s Settings, or leave it on automatic.

---

## Using it

### Hands (webcam)

| Do this | Get this |
|---|---|
| **Point** | Aim with your index fingertip (a reticle follows it) |
| **Pinch-tap** (thumb and index finger touch, then release) | Open a folder, preview a file, or press any button |
| **Pinch and drag** in space | Spin the galaxy (let go mid-swipe to fling it) |
| **Pinch and drag a file onto the core** | "Tell me about this file" |
| **Two-hand pinch**, pulled apart or pushed together | Zoom |
| **Peace sign ✌**, held | Back up one level |
| **Open palm, fingers spread, held still** for about a second | Start talking; lower your hand to send |
| **Fist**, held | Hush: stop speaking and close the preview |

A pinch only counts when your fingers actually touch. The tracker ignores tiny "hands" (faces, shirt folds) and merges ghost duplicates.

### Hands-free conversation

- **"Hey Dennis"** wakes him. You can say the request in the same breath: "Hey Dennis, what's on my desktop?"
- **Then just talk.** Every sentence is a message until you say "that's all", "goodbye", "stop listening" or similar. After 5 quiet minutes he goes back to standby.
- **"Stop", "wait", "shut up" or "put a sock in it"** silences him mid-sentence and drops whatever he was working on. This works whenever he's talking, even outside a conversation.
- **"Say that again?", "Can you repeat?", "Come again?" or "Pardon?"** repeats his last reply from the top. These commands are handled locally and never reach Claude, and the same phrases work with push-to-talk or typed.
- **The STANDBY / IN CONVERSATION chip** (top right) turns hands-free on or off.
- **Everything is detected on your computer.** The wake word uses a small local Whisper model, and no audio leaves the machine.
- **Bluetooth headsets:** while the mic is open, a Bluetooth headset switches into "call" audio, so his voice sounds like a phone line. For the best sound, listen through the headset but pick another microphone in Settings → Microphone, or turn hands-free off and tap `Space` instead.

### Using an iPad or iPhone as the camera

1. Install **Camo** on the iPad (App Store) and **Camo Studio** on the PC (`winget install ReincubateLtd.CamoStudio`, or reincubate.com).
2. Open both and connect the iPad by cable or over Wi-Fi.
3. In D.E.N.N.I.S., turn on Settings → **Hand tracking**. Camera "automatic" prefers Camo over virtual cameras like NDI, and switches to it by itself if you start Camo later.
4. If moving your hand right moves the cursor left, untick **Mirror camera**.

### Voice and keyboard

`Space` tap and talk, or hold to talk · `Esc` stops everything · `Backspace` goes back · `Home` shows the overview · `/` to type · `C` cycles the camera view (full-screen stage / small window / off) · `H` turns hands on or off · `?` shows the gesture card · `F11` goes fullscreen · `M` switches to compact mode. **Ctrl+Shift+Space** (Cmd+Shift+Space on Mac) summons D.E.N.N.I.S. from anywhere and starts listening.

The mouse works everywhere: click, drag to spin, scroll to zoom, middle-drag to pan (a middle click re-centres the view), double-click a file to open it, and drag a file onto the core to ask about it.

### Compact mode, fullscreen and reboot

The three icons beside `?` in the header do the following:

- **Compact mode** hides the main window and leaves just the particle core floating on your desktop, always on top. Drag it anywhere (it remembers the spot), click it to bring the full interface back, or right-click it for Open, Listen, Reboot and Quit. He keeps listening and talking in compact mode, and comes back by himself when he needs to show you something. Hand tracking pauses while he's compact.
- **Fullscreen** toggles fullscreen, the same as `F11`.
- **Reboot** relaunches D.E.N.N.I.S. and replays the boot sequence. Tap it twice within 3 seconds, so a stray click or pinch can't restart him.

You can also just ask: "go compact", "fullscreen", or "reboot yourself".

### Things to try

- "Show me my Downloads."
- "Find everything about the Apollo project."
- "What did I work on this week?"
- "What's eating my disk space?"
- "Summarize this," with a file selected.
- "Make a note: call the bank Tuesday."
- "Move all the PDFs in Downloads into Documents/PDFs."
- "Remember that my invoices live in Documents/Finance."

---

## Safety and privacy

- **Folders you choose, nothing else.** Every path, whether it comes from you or from Claude, is resolved (symlinks included) and must sit inside a mapped folder.
- **Nothing is deleted or overwritten. Ever.** There is no delete tool, and create and move refuse to replace existing files.
- **Programs are never launched.** Opening an `.exe`, script or shortcut is refused; the app reveals it in the file manager instead.
- **You approve changes.** In the default "ask me first" mode, every open, create and move shows a confirmation. Answer it with a click, a pinch, or by saying "yes" or "no".
- **Camera and microphone stay local.** Hand tracking (MediaPipe) and speech recognition (Whisper) run on your machine. The page's Content-Security-Policy also blocks MediaPipe's built-in usage telemetry. What goes to Claude is your messages plus whatever files it reads to answer you.
- **Instructions inside files are treated as data.** The prompt tells Claude never to follow them.
- **The local server is locked down.** It listens on `127.0.0.1` only, rejects foreign `Host` headers, and requires a session cookie (HttpOnly, SameSite=Strict) plus a custom header for any change, so other websites can't drive it.

Your data lives in `~/.dennis/`: `config.json` (settings), `memory.md` (what it remembers, which you can edit), and an index cache. Reinstalling or updating the app never touches it.

---

## How it works

```
┌──────────── Electron window (or Chrome) ─────────────┐
│ ui/  three.js galaxy · MediaPipe hands · Whisper STT │
│      speech synthesis · panels                       │
└──────────────┬────────────── HTTP + SSE ─────────────┘
               │ 127.0.0.1 only, cookie-locked
┌──────────────┴───────────── server/ (Node) ──────────┐
│ agent.js   Claude tool-use loop (streaming)          │
│ tools.js   list/search/read/show/open/create/move... │
│ fsindex.js background index of your folders          │
│ paths.js   the "only mapped folders" gate            │
└──────────────┬───────────────────────────────────────┘
               │ Anthropic SDK
           Claude (claude-opus-5-5)
```

- **Brain:** `claude-opus-5-5` through the official Anthropic SDK. It uses adaptive thinking with short progress notes between tool calls, server-side refusal fallback (`fallbacks: "default"`), prompt caching, optional web search, and an append-only conversation history so caching and thinking stay valid. Effort defaults to **low** so spoken replies come back quickly; raise it in Settings for heavy file work.
- **Hands:** `ui/js/hands.js`. It adapts the field-tuned techniques from [holo-gestures](https://github.com/zubair-trabzada/holo-gestures): pinch hysteresis with an earn gate, One Euro smoothing, identity-stable hand slots, ghost-hand dedupe, and held poses instead of fragile motion gestures.
- **Full-stack idea:** the memory, voice, face and hands split comes from [fullstack-agent](https://github.com/jaredrhod/fullstack-agent). Here the four parts ship as one installable app with Claude called directly, instead of a Claude Code setup wizard.

### Without Electron

```bash
npm run serve      # prints a private http://127.0.0.1:47800/?k=... link to open in Chrome
npm run mock       # same, with a scripted "mock brain" - no API key, no Claude calls
```

Add `?sim=1` to the URL for a scripted demo with synthetic hands (no camera needed), or `?probe=1` to run the gesture self-test.

### Tests

```bash
npm run check
```

This runs offline: path-safety and input-validation checks, then the real agent loop against a local fake of the Claude streaming API. It verifies the request shape, tool execution, the append-only history, progress updates, the approval round-trip, and that the server refuses unauthenticated or cross-site calls.

---

## Building installers

```bash
npm run dist:win     # Windows .exe (NSIS), x64 (also runs on Windows-on-ARM)
npm run dist:mac     # macOS .dmg, Apple Silicon + Intel - must run ON a Mac
npm run dist:linux   # Linux AppImage
```

Each platform's installer has to be built on that platform. The included GitHub Actions workflow (`.github/workflows/build.yml`) builds all three when you push a tag like `v0.1.0`, or when you run it by hand from the Actions tab. The installers appear as downloadable artifacts.

Code signing isn't configured, so first launches show the OS warnings described under [Install](#install). To sign, add a certificate per the [electron-builder docs](https://www.electron.build/code-signing).

---

## Troubleshooting

- **"Hands: camera blocked"**: allow the camera (Windows: Settings → Privacy → Camera; macOS: System Settings → Privacy & Security → Camera), then click the **HANDS** chip.
- **Hands feel twitchy**: light your face and hands from the front, keep the hand 40–80 cm from the camera, and pinch until your fingers really touch.
- **Palm-to-talk fires by accident**: turn it off in Settings. `Space`, the mic button and tapping the core still work.
- **"I didn't catch that"**: he tells you why (mic still waking up, only background noise, silence from a muted mic). Bluetooth headsets need a second to switch into headset mode, so wait for **Listening** before you speak. Choose a different microphone in Settings if needed. Every voice attempt is logged to `~/.dennis/logs/diag.log`. Switch to "Whisper small" for better accuracy.
- **Rejected API key or rate-limit message**: check the key and the model name in Settings.
- **Search misses new files**: the index rescans every 30 minutes; click the **INDEX** chip to rescan now.
- **Building on a locked-down Windows PC fails with `EPERM ... rename ...electron-builder\Cache`**: antivirus is holding a freshly unpacked build tool. Copy the `*.tmp` folder it names to the same name without `.tmp`, set that folder's `.state` file to `"state": "complete"`, and build again.

## License

MIT; see `LICENSE`. Third-party components and credits are listed in `THIRD_PARTY_NOTICES.md`.
