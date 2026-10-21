// Speech-to-text worker: Whisper running locally via transformers.js + ONNX
// Runtime (WebAssembly). Models download once from Hugging Face and are cached by
// the browser; audio never leaves the machine. Several models can be loaded at
// once (a tiny one for spotting the wake word, a better one for what you say).
//
// Languages: the ".en" models are English-only. With a multilingual model, the
// language is detected first - Whisper scores its language tokens for the audio, and
// we take the best of the languages you speak (asking it to pick from a short list is
// far more reliable than letting it choose among all 99) - then transcribed in it.
// (transformers.js would otherwise quietly assume English.)
import { pipeline, env, Tensor } from "/vendor/transformers/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = "/vendor/transformers/";
// One thread: ONNX Runtime's multi-threaded build spawns nested workers that can
// stall inside a module worker. Single-threaded Whisper is still well under real time.
env.backends.onnx.wasm.numThreads = 1;

const models = new Map(); // model id -> Promise<pipeline>
const multilingual = (model) => !/\.en$/i.test(model);

// On the GPU when there is one (several times faster, which multilingual models need);
// otherwise, or if the GPU build fails, the CPU (WebAssembly).
const GPU = { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } };
const CPU = { device: "wasm", dtype: "q8" };
let gpuOk = !!self.navigator?.gpu;

function load(model) {
  if (!models.has(model)) {
    const progress_callback = (ev) => {
      if (ev.status === "progress" && ev.total) postMessage({ type: "progress", model, file: ev.file, loaded: ev.loaded, total: ev.total });
    };
    const build = (where) => pipeline("automatic-speech-recognition", model, { ...where, progress_callback });
    const p = (gpuOk ? build(GPU).catch((err) => { console.warn("[stt] GPU unavailable, using the CPU:", err?.message || err); gpuOk = false; return build(CPU); }) : build(CPU))
      .then((pipe) => { postMessage({ type: "ready", model, device: gpuOk ? "webgpu" : "wasm" }); return pipe; });
    p.catch(() => models.delete(model)); // allow a retry after a failed download
    models.set(model, p);
  }
  return models.get(model);
}

/**
 * Which of `candidates` (ISO codes) is being spoken: one decoder step, compare the language
 * tokens. Also returns that step's encoder pass, so transcription needn't repeat it.
 */
async function detectLanguage(pipe, audio, candidates) {
  const gc = pipe.model.generation_config || {};
  const langToId = gc.lang_to_id || {}; // Whisper's own map: { "<|en|>": 50259, ... }
  const sot = gc.decoder_start_token_id;
  const langs = candidates.map((c) => [c, langToId[`<|${c}|>`]]).filter(([, id]) => id != null);
  if (!langs.length || sot == null) return { language: candidates[0] || "en" };
  const { input_features } = await pipe.processor(audio.length > 480000 ? audio.subarray(0, 480000) : audio); // the first 30 s is plenty
  const out = await pipe.model({ input_features, decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(sot)]), [1, 1]) });
  const logits = out.logits.data; // [1, 1, vocab]
  let best = langs[0][0], score = -Infinity;
  for (const [code, id] of langs) if (logits[id] > score) { score = logits[id]; best = code; }
  return { language: best, input_features, encoder_outputs: out.encoder_outputs };
}

/** Transcribe a clip of up to 30 s reusing the encoder pass from detection. */
async function transcribeWithEncoder(pipe, det) {
  const ids = await pipe.model.generate({ inputs: det.input_features, encoder_outputs: det.encoder_outputs, language: det.language, task: "transcribe" });
  return pipe.tokenizer.batch_decode(ids, { skip_special_tokens: true })[0] || "";
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
        const opts = { chunk_length_s: 30, stride_length_s: 5 };
        let language = "en", text = null;
        if (multilingual(msg.model)) {
          const langs = Array.isArray(msg.languages) && msg.languages.length ? msg.languages : ["en"];
          if (langs.length > 1) {
            const det = await detectLanguage(pipe, msg.audio, langs);
            language = det.language;
            // a short clip (any command) is transcribed from the same encoder pass; longer ones go through the chunking pipeline
            if (det.encoder_outputs && msg.audio.length <= 480000) {
              try { text = await transcribeWithEncoder(pipe, det); } catch (err) { console.warn("[stt] single-pass transcription failed, retrying:", err?.message || err); }
            }
          } else language = langs[0];
          Object.assign(opts, { language, task: "transcribe" });
        }
        if (text == null) text = (await pipe(msg.audio, opts))?.text || "";
        postMessage({ type: "result", id: msg.id, text: text.trim(), language });
      } catch (err) {
        postMessage({ type: "error", id: msg.id, model: msg.model, message: String(err?.message || err) });
      }
    });
  }
};
