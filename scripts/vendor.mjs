// Copies the browser-side libraries D.E.N.N.I.S. needs out of node_modules into
// ui/vendor, so the UI never loads code from a CDN (offline machines, ad-blockers
// and flaky networks can't break hand tracking or speech). Runs on `npm install`.
//
//   three.js                      -> ui/vendor/three/
//   MediaPipe Tasks Vision + wasm -> ui/vendor/mediapipe/
//   hand_landmarker.task model    -> ui/vendor/mediapipe/ (downloaded once, ~7.5 MB)
//   transformers.js + ORT wasm    -> ui/vendor/transformers/ (local Whisper speech-to-text)
//   Mermaid (ESM build + chunks)  -> ui/vendor/mermaid/ (the diagrams he draws)
//   PDF.js + fonts/cmaps/wasm     -> ui/vendor/pdfjs/ (the document reader's PDF pages)
//   mammoth (browser build)       -> ui/vendor/mammoth/ (Word documents as formatted pages)
//   marked (ESM)                  -> ui/vendor/marked/ (Markdown as formatted text)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NM = path.join(ROOT, "node_modules");
const OUT = path.join(ROOT, "ui", "vendor");
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let warnings = 0;
const warn = (msg) => { warnings++; console.warn(`  ! ${msg}`); };

function copy(fromRel, toRel) {
  const from = path.join(NM, fromRel);
  const to = path.join(OUT, toRel);
  if (!fs.existsSync(from)) return warn(`missing ${fromRel} (run a full "npm install")`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function copyLicense(pkg, toDir) {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    const p = path.join(NM, pkg, name);
    if (fs.existsSync(p)) {
      fs.mkdirSync(path.join(OUT, toDir), { recursive: true });
      fs.copyFileSync(p, path.join(OUT, toDir, "LICENSE"));
      return;
    }
  }
}

console.log("D.E.N.N.I.S. vendor: copying browser libraries into ui/vendor");

// three.js: the WebGPU renderer (falls back to WebGL 2 by itself), its shader-node
// library (TSL), bloom, the CSS label renderer, and the CSS 3D renderer (floating file windows)
copy("three/build/three.core.js", "three/three.core.js");
copy("three/build/three.webgpu.js", "three/three.webgpu.js");
copy("three/build/three.tsl.js", "three/three.tsl.js");
copy("three/examples/jsm/renderers/CSS2DRenderer.js", "three/addons/renderers/CSS2DRenderer.js");
copy("three/examples/jsm/renderers/CSS3DRenderer.js", "three/addons/renderers/CSS3DRenderer.js");
copy("three/examples/jsm/tsl/display/BloomNode.js", "three/addons/tsl/display/BloomNode.js");
copyLicense("three", "three");
// These files import bare specifiers ("three", "three/webgpu", "three/tsl"); point them at
// the vendored files so the page needs no import map (an inline one would need a CSP exception).
const rewrite = (rel, map) => {
  const p = path.join(OUT, rel);
  if (!fs.existsSync(p)) return;
  let src = fs.readFileSync(p, "utf8");
  for (const [spec, to] of Object.entries(map)) src = src.replace(new RegExp(`from\\s+['"]${spec}['"]`, "g"), `from '${to}'`);
  fs.writeFileSync(p, src);
};
rewrite("three/three.tsl.js", { "three/webgpu": "./three.webgpu.js" });
rewrite("three/addons/renderers/CSS2DRenderer.js", { three: "../../three.webgpu.js" });
rewrite("three/addons/renderers/CSS3DRenderer.js", { three: "../../three.webgpu.js" });
rewrite("three/addons/tsl/display/BloomNode.js", { "three/webgpu": "../../../three.webgpu.js", "three/tsl": "../../../three.tsl.js" });
fs.rmSync(path.join(OUT, "three", "three.module.js"), { force: true }); // the WebGL-only build is no longer used

// MediaPipe hand tracking
copy("@mediapipe/tasks-vision/vision_bundle.mjs", "mediapipe/vision_bundle.mjs");
copy("@mediapipe/tasks-vision/wasm", "mediapipe/wasm");
copyLicense("@mediapipe/tasks-vision", "mediapipe");

// The released wasm glue calls dbg() on a warning path without ever defining it,
// which turns a harmless warning into an init crash. Same fix holo-gestures ships.
const SHIM = 'var dbg = dbg || function(){ try { console.warn.apply(console, ["[mediapipe]"].concat([].slice.call(arguments))); } catch(e){} }; /* DENNIS SHIM: undefined dbg() in MediaPipe wasm glue */\n';
const wasmDir = path.join(OUT, "mediapipe", "wasm");
if (fs.existsSync(wasmDir)) {
  for (const f of fs.readdirSync(wasmDir).filter((f) => f.endsWith(".js"))) {
    const p = path.join(wasmDir, f);
    const src = fs.readFileSync(p, "utf8");
    if (src.includes("dbg(") && !src.includes("DENNIS SHIM") && !/function dbg\b|var dbg\b/.test(src)) {
      fs.writeFileSync(p, SHIM + src);
    }
  }
}

// transformers.js (fully bundled browser build) + the ONNX Runtime wasm it loads
copy("@huggingface/transformers/dist/transformers.min.js", "transformers/transformers.min.js");
copy("onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs", "transformers/ort-wasm-simd-threaded.asyncify.mjs");
copy("onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm", "transformers/ort-wasm-simd-threaded.asyncify.wasm");
copyLicense("@huggingface/transformers", "transformers");

// Kokoro: the local neural voice (British male voices bm_george / bm_fable / bm_lewis / bm_daniel).
// Its web build bundles its own transformers.js 3.x, so it needs the ONNX Runtime wasm of
// that generation (kokoro-js's nested copy), not the newer one used for Whisper.
const kokoroDir = path.join(NM, "kokoro-js");
if (fs.existsSync(kokoroDir)) {
  const out = path.join(OUT, "kokoro");
  fs.mkdirSync(out, { recursive: true });
  let src = fs.readFileSync(path.join(kokoroDir, "dist", "kokoro.web.js"), "utf8");
  // expose numThreads next to wasmPaths: multi-threaded ONNX Runtime stalls inside a module worker
  const patched = src.replace(/(const \w+=\{)(set wasmPaths\(e\)\{(\w+)\.backends\.onnx\.wasm\.wasmPaths=e\})/, "$1set numThreads(e){$3.backends.onnx.wasm.numThreads=e},$2");
  if (patched === src) warn("kokoro.web.js layout changed - could not add the numThreads switch");
  fs.writeFileSync(path.join(out, "kokoro.web.js"), patched);
  const ortDirs = [path.join(kokoroDir, "node_modules", "onnxruntime-web", "dist"), path.join(NM, "onnxruntime-web", "dist")];
  const ortDir = ortDirs.find((d) => fs.existsSync(path.join(d, "ort-wasm-simd-threaded.jsep.wasm")));
  if (!ortDir) warn("ONNX Runtime wasm for Kokoro not found");
  else for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) fs.copyFileSync(path.join(ortDir, f), path.join(out, f));
  const lic = path.join(kokoroDir, "LICENSE");
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(out, "LICENSE"));
} else warn("kokoro-js missing - the natural voice will be unavailable (system voice still works)");

// Mermaid: the diagrams D.E.N.N.I.S. draws (show_diagram). Its ESM build loads each diagram
// type it needs as a chunk, on demand; the source maps stay behind.
copy("mermaid/dist/mermaid.esm.min.mjs", "mermaid/mermaid.esm.min.mjs");
{
  const from = path.join(NM, "mermaid", "dist", "chunks", "mermaid.esm.min");
  if (!fs.existsSync(from)) warn("missing mermaid chunks (run a full \"npm install\")");
  else fs.cpSync(from, path.join(OUT, "mermaid", "chunks", "mermaid.esm.min"), { recursive: true, filter: (src) => !src.endsWith(".map") });
  copyLicense("mermaid", "mermaid");
}

// The document reader (ui/js/reader.js): PDF.js renders PDF pages (its fonts, character maps,
// colour profiles and image decoders come along so scanned and CJK PDFs work offline),
// mammoth turns Word files into formatted HTML, marked renders Markdown.
// the "legacy" build carries polyfills for the newest JS it uses (Map.getOrInsertComputed and co.),
// so it runs on Electron's Chromium and on browsers a few versions back alike
copy("pdfjs-dist/legacy/build/pdf.min.mjs", "pdfjs/pdf.min.mjs");
copy("pdfjs-dist/legacy/build/pdf.worker.min.mjs", "pdfjs/pdf.worker.min.mjs");
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) copy(`pdfjs-dist/${dir}`, `pdfjs/${dir}`);
copyLicense("pdfjs-dist", "pdfjs");
copy("mammoth/mammoth.browser.min.js", "mammoth/mammoth.browser.min.js");
copyLicense("mammoth", "mammoth");
copy("marked/lib/marked.esm.js", "marked/marked.esm.js");
copyLicense("marked", "marked");

// The hand model is not on npm; fetch it once and keep it.
const modelPath = path.join(OUT, "mediapipe", "hand_landmarker.task");
if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 1_000_000) {
  const local = process.env.DENNIS_HAND_MODEL;
  if (local && fs.existsSync(local)) {
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.copyFileSync(local, modelPath);
    console.log("  hand model copied from DENNIS_HAND_MODEL");
  } else {
    try {
      console.log("  downloading hand_landmarker.task (~7.5 MB)...");
      const res = await fetch(HAND_MODEL_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(modelPath), { recursive: true });
      fs.writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      warn(`could not download the hand model (${e.message}). Hand tracking will try the online copy at runtime.`);
    }
  }
}

console.log(warnings ? `vendor done with ${warnings} warning(s)` : "vendor done");
