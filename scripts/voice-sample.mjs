// Makes the voice sample Chatterbox clones D.E.N.N.I.S.'s voice from: about fifteen seconds of
// Kokoro's British "Daniel" (Kokoro-82M, Apache 2.0 - a synthetic voice, nobody's real one).
//   node scripts/voice-sample.mjs <out.wav> [kokoro voice, default bm_daniel]
// Run by the voice setup (server/chatterbox.js) with Electron's own Node (ELECTRON_RUN_AS_NODE).
import fs from "node:fs";
import path from "node:path";
import { KokoroTTS } from "kokoro-js";

const out = process.argv[2];
const voice = process.argv[3] || "bm_daniel";
if (!out) { console.error("usage: voice-sample.mjs <out.wav> [voice]"); process.exit(2); }

// varied, calm, a little dry: questions, a list, a pause - what a cloned voice needs to hear
const TEXT = "Good evening. Everything is in order: the renders finished on schedule, the LED wall is calibrated, " +
  "and your files are precisely where you left them. Shall I bring up tomorrow's call sheet? " +
  "Or would you rather I kept quiet for a while, and simply looked after things?";

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" });
const audio = await tts.generate(TEXT, { voice, speed: 0.95 });
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
await audio.save(out);
const seconds = audio.audio.length / audio.sampling_rate;
console.log(JSON.stringify({ ok: true, out: path.resolve(out), seconds: Math.round(seconds * 10) / 10, voice }));
