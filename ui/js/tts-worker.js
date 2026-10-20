// Text-to-speech worker: Kokoro-82M, a small neural voice model, running locally via
// ONNX Runtime (WebAssembly). The model (~90 MB) downloads once from Hugging Face and
// is cached; text never leaves the machine.
import { KokoroTTS, env } from "/vendor/kokoro/kokoro.web.js";

env.wasmPaths = "/vendor/kokoro/";
env.numThreads = 1; // same reason as the speech-recognition worker: nested ORT threads stall in a worker

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null;
let device = "wasm";

function load(want) {
  if (!tts) {
    // On a GPU (WebGPU) Kokoro runs many times faster than real time; on one CPU thread it can't keep up.
    device = want || (self.navigator?.gpu ? "webgpu" : "wasm");
    tts = KokoroTTS.from_pretrained(MODEL, {
      dtype: device === "webgpu" ? "fp32" : "q8",
      device,
      progress_callback: (ev) => {
        if (ev.status === "progress" && ev.total) postMessage({ type: "progress", loaded: ev.loaded, total: ev.total, file: ev.file });
      },
    }).then((t) => { postMessage({ type: "ready", device }); return t; });
    tts.catch(() => { tts = null; });
  }
  return tts;
}

let queue = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "load") { load(m.device).catch((err) => postMessage({ type: "error", message: String(err?.message || err) })); return; }
  if (m.type === "speak") {
    queue = queue.then(async () => {
      try {
        const t = await load();
        const out = await t.generate(m.text, { voice: m.voice || "bm_george", speed: m.speed || 1 });
        const audio = out.audio instanceof Float32Array ? out.audio : new Float32Array(out.audio);
        postMessage({ type: "audio", id: m.id, audio, rate: out.sampling_rate }, [audio.buffer]);
      } catch (err) {
        postMessage({ type: "error", id: m.id, message: String(err?.message || err) });
      }
    });
  }
};
