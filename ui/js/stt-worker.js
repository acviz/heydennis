// Speech-to-text worker: Whisper running locally via transformers.js + ONNX
// Runtime (WebAssembly). Models download once from Hugging Face and are cached by
// the browser; audio never leaves the machine. Several models can be loaded at
// once (a tiny one for spotting the wake word, a better one for what you say).
import { pipeline, env } from "/vendor/transformers/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = "/vendor/transformers/";
// One thread: ONNX Runtime's multi-threaded build spawns nested workers that can
// stall inside a module worker. Single-threaded Whisper is still well under real time.
env.backends.onnx.wasm.numThreads = 1;

const models = new Map(); // model id -> Promise<pipeline>

function load(model) {
  if (!models.has(model)) {
    const p = pipeline("automatic-speech-recognition", model, {
      device: "wasm",
      dtype: "q8",
      progress_callback: (ev) => {
        if (ev.status === "progress" && ev.total) postMessage({ type: "progress", model, file: ev.file, loaded: ev.loaded, total: ev.total });
      },
    }).then((pipe) => { postMessage({ type: "ready", model }); return pipe; });
    p.catch(() => models.delete(model)); // allow a retry after a failed download
    models.set(model, p);
  }
  return models.get(model);
}

// one transcription at a time, in arrival order
let queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "load") {
    load(msg.model).catch((err) => postMessage({ type: "error", model: msg.model, message: String(err?.message || err) }));
    return;
  }
  if (msg.type === "transcribe") {
    queue = queue.then(async () => {
      try {
        const pipe = await load(msg.model);
        const out = await pipe(msg.audio, { chunk_length_s: 30, stride_length_s: 5 });
        postMessage({ type: "result", id: msg.id, text: (out?.text || "").trim() });
      } catch (err) {
        postMessage({ type: "error", id: msg.id, model: msg.model, message: String(err?.message || err) });
      }
    });
  }
};
