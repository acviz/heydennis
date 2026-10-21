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

**Continuous conversation** keeps him listening all the time, with no wake word and no key to press: just talk, and every sentence goes to him. To switch it on or off:
- click the speech-bubble button in the header (lit green while it's on)
- press `L`
- say or type "continuous mode" / "continuous mode off"
- hold a **thumbs-up** 👍
- right-click the compact orb → *Continuous conversation*

"That's all" ends it too. While he's speaking he only listens for "stop" and "say that again", so he never answers himself. `Esc` silences him without ending the mode. It stays on across restarts until you switch it off (Settings has the same switch).

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

`Space` tap and talk, or hold to talk · `Esc` stops everything · `Backspace` goes back · `Home` shows the overview · `/` to type · `C` cycles the camera view (full-screen stage / small window / off) · `H` turns hands on or off · `?` shows the gesture card · `F11` goes fullscreen · `M` switches to compact mode · `T` switches to the next theme · `Ctrl+Z` undoes his last change to your files. **Ctrl+Shift+Space** (Cmd+Shift+Space on Mac) summons D.E.N.N.I.S. from anywhere and starts listening.

The mouse works everywhere: click, drag to spin, scroll to zoom, middle-drag to pan (a middle click re-centres the view), double-click a file to open it, and drag a file onto the core to ask about it.

### File windows

Opening a file puts it in a floating hologram window that grows out of its card. You can open several, up to eight.

- **Move:** drag a window by its title bar and it stays where you drop it. Until then it follows its card.
- **Resize:** drag the grip in the bottom-right corner.
- **Switch:** with two or more windows open, a tab strip appears under the header. Click a tab, scroll the wheel over the strip, or press `Ctrl+Tab` (`Ctrl+Shift+Tab` to go back).
- **Full screen:** `F` or the expand button. `Esc` brings it back, then closes the front window.
- **Keep:** windows stay open when you change folders.

**Documents open in the window itself**, readable without leaving D.E.N.N.I.S.:

| File | What you see |
|---|---|
| PDF | The real pages, with a page counter and zoom (`−` / `FIT` / `+`) |
| Word (`.docx`) | The formatted document: headings, lists, tables, pictures, links |
| Excel (`.xlsx`), `.csv`, `.tsv` | A grid with column letters and row numbers, merged cells, number and date formats, and a tab for each sheet |
| PowerPoint (`.pptx`) | Each slide laid out with its text, pictures, shapes and tables |
| Markdown (`.md`) | Formatted text |
| Images, video, audio, code and text | As before |

Pinch-drag scrolls any document, in any direction, and the toolbar buttons respond to a pinch-tap. Older `.doc`, `.xls` and `.ppt` files have no preview; **OPEN** hands them to your usual app. Everything is drawn on your computer, and nothing in a document can run code.

### Languages

Settings → **Languages you speak** sets this. Choose *Auto* for English, Arabic, Tagalog, French, Japanese and Chinese, or pick one language.

- He detects which of your languages you're speaking, transcribes it on your computer, and replies in the same language.
- Speech recognition runs on the graphics card when there is one: about a second per command with the base model, or about 2.5 s with *small*, which is more accurate for Arabic, Japanese, Chinese and Tagalog.
- To hear replies in those languages in the same voice, use the ElevenLabs voice (Settings → Voice engine, plus an ElevenLabs key). Its fast multilingual model speaks all six. Without it, the local voice handles English, and replies in other languages are spoken by a matching Windows voice if one is installed, or shown on screen.

### Compact mode, fullscreen and reboot

The compact and fullscreen icons in the header, and the arc-reactor logo at the top left, do the following:

- **Compact mode** hides the main window and leaves just the particle core floating on your desktop, always on top, brightened and with a soft glow and shadow so it stands out on any wallpaper. Drag it anywhere (it remembers the spot), click it to bring the full interface back, or right-click it for Open, Listen, Reboot and Quit. He keeps listening and talking in compact mode, and comes back by himself when he needs to show you something. Hand tracking pauses while he's compact.
- **Fullscreen** toggles fullscreen, the same as `F11`.
- **Reboot** is the arc-reactor logo next to the name: it relaunches D.E.N.N.I.S. and replays the boot sequence. Tap it twice within 3 seconds (it turns amber after the first tap), so a stray click or pinch can't restart him. Clicking the name itself starts a new conversation.

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
- "Draw the signal flow from the media server to the LED wall."
- "Look at my screen - what's this error?"
- "Remind me at three to check the LED calibration."
- "Take notes" at the start of a meeting, "stop taking notes" at the end.
- "Switch to the neural theme."

### Themes

Four looks for the scene around the core. Switch with the orbit icon in the header, the `T` key, **Settings → Theme** (it previews as you pick), or by asking ("switch to the spiral theme", "next theme").

- **Reactor**, the original: blueprint grid, arc-reactor rings, a quiet starfield.
- **Spiral**: a tilted spiral galaxy, with long light trails orbiting a soft blue nucleus.
- **Neural**: a glowing neuron, with fine filaments reaching out and sparks running along them.
- **Grid**: cyberspace, with circuit traces and data walls and light pulses streaming into the core.

Every theme is drawn live in the 3D scene; none of them play a video. The scenery speeds up while he thinks and swells when he talks. It's kept dim enough that the core and your file windows stay the brightest things on screen, and the HUD tints to match. Themes crossfade over about a second, and your choice is remembered.

### Diagrams

Ask for a picture and he draws one in a floating window: signal flow and wiring, camera-tracking setups, pipelines, shoot schedules, who-does-what. Examples: "draw how the LED processors connect to the wall", "show the tracking data path as a sequence diagram", "make a Gantt chart of next week's shoot".

- He writes the diagram in [Mermaid](https://mermaid.js.org) and it lays itself out. Flowcharts, sequence diagrams, Gantt charts, timelines, mind maps and state diagrams all work, and the window styles them to match the HUD and theme.
- If a diagram has a mistake, the window tells him what's wrong and he fixes it himself.
- Each diagram window has **Save** (SVG and PNG into `~/.dennis/diagrams`, then shows you the file), **Copy Mermaid** (the source, to paste into docs, Notion or GitHub), full screen, and the usual move, resize and tabs.
- "Save it to the project folder" puts a copy in your folders, after you approve. It can be undone like any other change.

## Everyday helpers

### Instant commands and undo

Everyday commands happen the moment you finish speaking, with no thinking time: "go home", "back", "open Downloads", "full screen", "compact", "close it", "close all", "next window", "what time is it", "switch theme", "do not disturb".

**Undo** works the same way. "Undo that", "put it back" or `Ctrl+Z` reverses his last change to your files, including changes his minions made. A moved or renamed file goes back where it was. A file or folder he created goes to `~/.dennis/undone`, because nothing is ever deleted.

### Looking at your screen

"Look at my screen", "what's this error?", "read me that render queue": he takes a screenshot (his own window steps aside first) and reads it. This only happens when you ask, and the screen flashes so you know. "Look at both screens" captures every display.

### Meeting notes

Say "take notes" and he transcribes the room on your computer until you say "stop taking notes". He stays silent meanwhile. Afterwards he writes up the decisions, action items and owners. The raw transcript is kept in `~/.dennis/notes`.

### Reminders and the daily briefing

- "Remind me at three to check the LED calibration", "every weekday at 9, remind me to back up the cards". Reminders chime and speak when they're due, and ones that came due while he was closed are announced as missed.
- **Brief me** gives today's reminders, what changed in your folders since yesterday, disk space, minion news and the weather (set your city in Settings). Tick *Brief me at the first start each day* to get it automatically.

### The folder watcher

He keeps an eye on your mapped folders and speaks up once when it matters. If a batch of new files lands (a night's renders, a card dump, a delivery), he says something like "Twelve new videos just landed in Renders. Shall I sort them?". He also warns when a drive is running low.

Downloads still in progress, temp files, and Unreal and other cache folders are ignored. There's a cooldown per folder, quiet hours (Settings, 22:00 to 07:00 by default) and a do-not-disturb switch: "do not disturb" / "you can disturb me again".

### What's taking the space

"What's eating my disk space?" gives a storage report:

- free space on each drive
- the biggest folders and files
- likely duplicate files
- caches that are safe to clear, such as Unreal's DerivedDataCache, Intermediate and Saved, DaVinci's render cache, Adobe's media cache, and proxies

He never deletes anything. To free space he offers to move things into a "To review" folder, which can be undone.

### Other brains: GPT, Gemini, Ollama

Claude is the default and recommended brain. **Settings → Brain** can swap in OpenAI (GPT), Google Gemini, a local open-source model through [Ollama](https://ollama.com), or any OpenAI-compatible server.

- He keeps his personality and all his file tools on any brain.
- Claude-only extras, such as the document skills, the cloud sandbox and Claude's web search, switch off on the others.
- Each brain's key is stored like the Claude key. **List models** (next to Model) shows what that brain offers.

---

## Capabilities: skills, minions, connected apps, documents

The star icon in the header (or **Settings → Capabilities**) opens the panel for everything below.

### Skills

A skill is packaged know-how for one kind of job: a folder holding a `SKILL.md` (a short `name` and `description` in its frontmatter, then the instructions), plus any reference files such as templates or checklists. It's the same format as Claude's Agent Skills, so skills written for Claude work here too.

- **Install** a folder, a `.zip`, or a lone `SKILL.md` from the Skills tab, or drop folders into `~/.dennis/skills`. Reinstalling a skill updates it.
- D.E.N.N.I.S. sees every skill's name and description, and reads a skill's full instructions only when a request needs them. Having many installed costs little.
- **Teach him:** "save that as a skill" writes a new skill from what you just showed him, once you approve it.
- Switch a skill off without removing it. Removed skills move to `~/.dennis/skills-removed`, so they can be restored.
- Scripts inside a skill are never run on your computer. He follows the instructions with his own tools.

### Minions

Minions are worker agents he sends off on tasks while he carries on with you. Several can work at once.

- **Built in:** Scout (research on the web and in your files), Archivist (surveys and tidies folders) and Scribe (drafts documents, decks and sheets). Make more in the Minions tab, or just ask: "create a minion called Gaffer that checks DMX patch sheets".
- **Deploy one:** "send Scout to find LED processors that do 7680 Hz", "have Archivist survey Downloads for duplicates". The MINIONS widget (top left) shows who's out and what each one is doing. Click one to read its report.
- **Same rules as Dennis.** Minions use only the toolsets you gave them (files, write, web, skills, docs, mcp). Anything that changes your files still asks you first, with the minion's name in the dialog. They can't drive the interface, touch his memory, or send minions of their own.
- **When one finishes,** its report goes in the Comms log, and he briefs you in a sentence or two as soon as he's free. Turn that off in the Minions tab if you'd rather ask.

### Connected apps (MCP)

MCP servers let other apps lend D.E.N.N.I.S. their tools, for example Blender, Unreal, Slack or Google Drive. Add them in the Connected Apps tab using the same format as Claude Desktop's `claude_desktop_config.json`:

```json
{ "mcpServers": {
    "blender": { "command": "uvx", "args": ["blender-mcp"] },
    "remote":  { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
} }
```

- **Import from Claude Desktop** copies in the servers you already use there, for you to review before saving.
- Each server's status and tools are shown live. Tools the server marks read-only run straight away; everything else asks you first.
- Local servers run as programs on your computer, so only add ones you trust. Keys in this config are stored as plain text in your data folder, as Claude Desktop does. Each server's error output goes to `~/.dennis/logs/mcp-<name>.log`.

### Documents

With document skills on (the Documents tab), he can make real Word, PowerPoint, Excel and PDF files using Anthropic's document skills: "make a one-page call sheet for tomorrow as a Word doc", "turn this shot list into a deck".

- He builds each file in Anthropic's cloud sandbox and saves it into your folders once you approve.
- The sandbox can't see your files; he reads what's needed and brings it in.
- Sandbox time is billed with your Claude API usage.
- If your API key can't use the sandbox, he switches document skills off by himself and says so.

## Messaging: WhatsApp and Teams

Message D.E.N.N.I.S. from your phone and he answers there. It's the same conversation, with the same tools and the same rules: "what's new in Renders?", "move the client's PDFs into Deliveries", "send Scout to find a 2.6 mm LED panel", "message me when the renders land". Set it up under **Capabilities → Messaging**.

- **Only you.** Messages from any other number or person are ignored.
- **Same safety rules.** Anything that changes your files still needs your yes. He asks in the chat: tap **Allow** (WhatsApp) or reply **YES** / **NO**. "Stop" cancels what he's doing.
- **Updates come to you.** Reminders, finished minions, new files landing, low disk space, and minions asking for approval reach your phone. By default that only happens while you're away from the computer: no activity for 10 minutes, or no window open. He can also message you himself when you ask him to ("text me the summary").
- **What you say on your phone shows in COMMS too,** so the conversation is in one place.
- **Your computer must be on** with D.E.N.N.I.S. running for him to answer. Set Windows not to sleep while you rely on it.

### WhatsApp (Meta's official WhatsApp Business Platform)

Setup takes about half an hour, once.

1. **Make a Meta app.** At [developers.facebook.com/apps](https://developers.facebook.com/apps), create an app with the WhatsApp use case. Meta gives it a free test number.
2. **Note the Phone number ID.** In the app's WhatsApp → API Setup, note the **Phone number ID**. Under *To*, add your own WhatsApp number and confirm it with the code Meta sends.
3. **Get an access token.** The token on API Setup works for 24 hours, which is fine for a first try. For keeps, go to Meta Business Settings → System users, add one, give it your app and WhatsApp account, and generate a token that never expires. It needs the `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
4. **Find the App ID and App secret.** Both are in App settings → Basic. D.E.N.N.I.S. uses the secret to check that every incoming call really comes from Meta, and the ID to keep the webhook pointed at him.
5. **Choose a tunnel.** Meta needs a public HTTPS address to deliver your messages to. The tunnel only reaches a small listener that answers `/whatsapp` and checks Meta's signature on every call. The rest of D.E.N.N.I.S. stays private on `127.0.0.1`.
   - **Cloudflare quick tunnel (recommended).** It's free and needs no account. Install Cloudflare's small tunnel app once:
     ```bash
     winget install --id Cloudflare.cloudflared
     ```
     Then choose *Cloudflare quick tunnel* in D.E.N.N.I.S. and he runs it himself. The tunnel's address changes each time it starts, and D.E.N.N.I.S. tells Meta the new one through your App ID, so it keeps working after restarts.
   - **Your own tunnel.** For example, [ngrok](https://ngrok.com) with its free static domain: `ngrok http --url=YOUR-NAME.ngrok-free.app 47820`. Choose *My own tunnel* in D.E.N.N.I.S. and enter its address.
   - **On a company network:** many company firewalls block tunnels outright. That's a deliberate security control, so don't try to get around it. Ask your IT team, or run WhatsApp from a computer on a network that allows it. If the Messaging tab says a firewall is blocking tunnels, use **Teams** on that computer instead: it needs no tunnel, because D.E.N.N.I.S. only talks out to Microsoft.
6. **Fill in D.E.N.N.I.S.** In Capabilities → Messaging → WhatsApp:
   - tick *Connect WhatsApp*
   - paste the Phone number ID, your number, the token, the App ID and the App secret
   - choose the tunnel (and, for your own, enter its address)
   - click **SAVE & CONNECT**, then **CHECK TUNNEL**
7. **Connect Meta to D.E.N.N.I.S. (once).** Back in Meta, go to WhatsApp → Configuration → Webhook → Edit:
   - paste the **Callback URL** and **Verify token** that D.E.N.N.I.S. shows, then click Verify and save
   - under webhook fields, subscribe to **messages**
   - with the Cloudflare quick tunnel, he updates the callback URL himself from then on
8. **Say hello.** Message the test number from your phone, and he answers.

**The 24-hour rule.** WhatsApp lets a business write to you freely only within 24 hours of your last message. After a quiet day, his updates wait until you next write, then arrive together under "While you were away". If you want them straight away, create a Utility template in WhatsApp Manager → Message templates, for example *dennis_update* with the body "Update from D.E.N.N.I.S.: {{1}}". Once Meta approves it, enter its name in D.E.N.N.I.S.; template messages are charged by Meta. To use a real number instead of the test number, add one in WhatsApp Manager.

### Microsoft Teams

There are two ways to connect Teams:

**A. Two-way, in a chat (recommended).** He signs in as you once, and watches one chat every few seconds. The best chat is your "chat with yourself". No public address is needed.

1. At [entra.microsoft.com](https://entra.microsoft.com), go to App registrations → **New registration**. Name it "D.E.N.N.I.S.", choose this organisation only, and register it.
2. Copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. Under Authentication, turn on **Allow public client flows** and save.
4. Under API permissions, add Microsoft Graph → **Delegated** → `Chat.ReadWrite` and `User.Read`. If your company requires it, ask IT to grant admin consent.
5. In D.E.N.N.I.S. (Capabilities → Messaging → Teams), tick *Connect Teams*, paste both IDs and click **SIGN IN TO TEAMS**. Open the link, enter the code, and sign in with your work account. No password passes through D.E.N.N.I.S.
6. Pick the chat (*Notes to self* when your Teams has it), then click **SAVE & CONNECT**. Write to him in that chat.

His replies appear in the chat as messages from you, marked "🤖 D.E.N.N.I.S.", so use a chat nobody else is in. On many company accounts, registering an app needs IT. If that's not possible, use B.

**B. Updates only, through a Teams Workflow.** In Teams, open a chat or channel, then ⋯ → **Workflows** → *Post to a chat when a webhook request is received* (or the channel version). Copy the URL into D.E.N.N.I.S.'s *Workflow URL* field and click **SEND A TEST MESSAGE**. You'll get his updates there, but you can't reply to him through it.

## Safety and privacy

- **Folders you choose, nothing else.** Every path, whether it comes from you or from Claude, is resolved (symlinks included) and must sit inside a mapped folder.
- **Nothing is deleted or overwritten. Ever.** There is no delete tool, and create and move refuse to replace existing files.
- **Programs are never launched.** Opening an `.exe`, script or shortcut is refused; the app reveals it in the file manager instead.
- **You approve changes.** In the default "ask me first" mode, every open, create and move shows a confirmation. Answer it with a click, a pinch, or by saying "yes" or "no".
- **Camera and microphone stay local.** Hand tracking (MediaPipe) and speech recognition (Whisper) run on your machine. The page's Content-Security-Policy also blocks MediaPipe's built-in usage telemetry. What goes to Claude is your messages plus whatever files it reads to answer you.
- **Instructions inside files are treated as data.** The prompt tells Claude never to follow them.
- **Your screen is only captured when you ask** ("look at my screen"), and the screen flashes when it happens.
- **The local server is locked down.** It listens on `127.0.0.1` only, rejects foreign `Host` headers, and requires a session cookie (HttpOnly, SameSite=Strict) plus a custom header for any change, so other websites can't drive it.

Your data lives in `~/.dennis/`: `config.json` (settings; the API keys and messaging tokens in it are encrypted by your operating system), `memory.md` (what it remembers, which you can edit), `reminders.json`, `notes/` (meeting transcripts), `diagrams/` (saved diagrams), `undone/` (whatever undo took away), `remote-state.json` (when you last messaged him, and updates waiting for WhatsApp's window), and an index cache. Reinstalling or updating the app never touches it.

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

- **Brain:** `claude-opus-5-5` through the official Anthropic SDK (other brains go through `server/brains.js`, an OpenAI-compatible adapter). It uses adaptive thinking with short progress notes between tool calls, server-side refusal fallback (`fallbacks: "default"`), prompt caching, optional web search, and an append-only conversation history so caching and thinking stay valid. Effort defaults to **low** so spoken replies come back quickly; raise it in Settings for heavy file work.
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
