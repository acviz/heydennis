// D.E.N.N.I.S.'s own voice, free and on this computer: Chatterbox (Resemble AI, MIT licence).
//
// It runs in its own Python, in ~/.dennis/voice (nothing touches the system's Python):
//   venv/                 Python 3.11, PyTorch (CUDA when there's an NVIDIA card) and chatterbox-tts
//   hf/                   the models, downloaded once from Hugging Face (about 4 GB)
//   dennis-voice.wav      the voice it clones: ~15 s of Kokoro's synthetic British "Daniel" (or your own sample)
// server/voice/chatterbox_server.py is the voice server: started when he first speaks, on 127.0.0.1
// with a token only he knows, and gone when he is (it watches his process). English goes to the fast Turbo model; Arabic,
// French, Japanese, Chinese and the rest go to the multilingual one.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dlog } from "./log.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const unpacked = (p) => p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1"); // Python can't read inside Electron's archive
const SERVER_PY = unpacked(path.join(HERE, "voice", "chatterbox_server.py"));
const SAMPLE_JS = path.join(HERE, "..", "scripts", "voice-sample.mjs");
const BASE_PORT = 47850;
export const CHATTERBOX_LANGS = new Set(["ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 20e6, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || err?.message || "") })));

/** uv (astral.sh) if it's on this computer: the quickest way to a private Python. */
function findUv() {
  const home = os.homedir(), exe = process.platform === "win32" ? "uv.exe" : "uv";
  const places = String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe));
  places.push(path.join(home, ".local", "bin", exe), path.join(home, ".cargo", "bin", exe));
  if (process.platform === "win32") {
    const pk = path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Microsoft", "WinGet", "Packages");
    try { for (const d of fs.readdirSync(pk)) if (/^astral-sh\.uv/i.test(d)) places.push(path.join(pk, d, exe)); } catch { /* no winget */ }
  }
  return places.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

class Job {
  constructor(broadcast) { this.broadcast = broadcast; this.abort = new AbortController(); this.phase = "starting"; this.text = "Setting up the Chatterbox voice"; this.pct = null; }
  step(phase, text, pct = null) {
    if (phase !== this.phase || text !== this.text) dlog("VOICE", `Chatterbox setup: ${text}`);
    this.phase = phase; this.text = text; this.pct = pct;
    this.broadcast({ type: "chatterbox", ...this.view() });
  }
  view() { return { phase: this.phase, text: this.text, pct: this.pct }; }
}

export class ChatterboxVoice {
  constructor({ config, broadcast = () => {}, fetchImpl = (...a) => fetch(...a), home }) {
    this.config = config;
    this.broadcast = broadcast;
    this.fetch = fetchImpl;
    this.dir = path.join(home || process.env.DENNIS_HOME || path.join(os.homedir(), ".dennis"), "voice");
    this.token = crypto.randomBytes(18).toString("hex");
    this.child = null;
    this.port = 0;
    this.starting = null;
    this.job = null;
    this.last = null;
  }

  get py() { return path.join(this.dir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"); }
  get marker() { return path.join(this.dir, ".installed"); }
  get installed() { return fs.existsSync(this.py) && fs.existsSync(this.marker); }
  get sample() {
    const own = String(this.config.get("voice")?.chatterboxSample || "").trim();
    return own && fs.existsSync(own) ? own : path.join(this.dir, "dennis-voice.wav");
  }
  get english() { return this.config.get("voice")?.chatterboxEnglish === "multilingual" ? "multilingual" : "turbo"; }

  async health() {
    if (!this.port) return null;
    try {
      const r = await this.fetch(`http://127.0.0.1:${this.port}/health`, { headers: { "X-Dennis-Voice": this.token }, signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  async status() {
    const h = this.child ? await this.health() : null;
    return { installed: this.installed, running: !!h, loaded: h?.loaded || [], device: h?.device || "", gpu: h?.gpu || "", sample: this.sample, hasSample: fs.existsSync(this.sample), english: this.english, busy: this.job ? this.job.view() : null, last: this.last };
  }

  /** The voice server, started if it isn't running (and its models loading in the background). */
  async ensure() {
    if (await this.health()) return;
    if (!this.installed) throw new Error("The Chatterbox voice isn't set up yet - Settings > Voice engine > SET UP CHATTERBOX.");
    this.starting ||= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    this.stop();
    // a free port of our own (an old copy, or something else, may hold the first one)
    for (let p = BASE_PORT; p < BASE_PORT + 10; p++) {
      const taken = await this.fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
      if (!taken) { this.port = p; break; }
    }
    if (!this.port) throw new Error("No free port for the voice server.");
    const logFile = path.join(path.dirname(this.dir), "logs", "voice-server.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try { if (fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, `${logFile}.old`); } catch { /* new log */ }
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`\n--- ${new Date().toISOString()} starting on port ${this.port}\n`);
    const child = spawn(this.py, [SERVER_PY, "--port", String(this.port), "--parent", String(process.pid), "--sample", this.sample, "--warm", this.english === "turbo" ? "turbo,multilingual" : "multilingual"], {
      env: { ...process.env, DENNIS_VOICE_TOKEN: this.token, HF_HOME: path.join(this.dir, "hf"), PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    this.child = child;
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("exit", (code) => { if (this.child === child) { this.child = null; dlog("VOICE", `the Chatterbox voice server stopped (${code})`); } log.end(); });
    for (let i = 0; i < 120; i++) {
      if (!this.child) throw new Error("The voice server stopped as it started - its log is in ~/.dennis/logs/voice-server.log.");
      if (await this.health()) { dlog("VOICE", `the Chatterbox voice server is up (port ${this.port})`); return; }
      await sleep(500);
    }
    throw new Error("The voice server didn't start within a minute.");
  }

  stop() { try { this.child?.kill(); } catch { /* gone */ } this.child = null; }

  /** One line spoken: WAV audio, in his voice, in the language given (English if it's one Chatterbox lacks). */
  async speak(text, lang = "en") {
    await this.ensure();
    const r = await this.fetch(`http://127.0.0.1:${this.port}/tts`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Dennis-Voice": this.token },
      body: JSON.stringify({ text: String(text).slice(0, 1500), lang: CHATTERBOX_LANGS.has(lang) ? lang : "en", sample: this.sample, english: this.english }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `the voice server answered ${r.status}`);
    return { audio: Buffer.from(await r.arrayBuffer()), took: +r.headers.get("x-took") || 0, seconds: +r.headers.get("x-seconds") || 0, model: r.headers.get("x-model") || "" };
  }

  // ---------------------------------------------------------------- setup: a private Python with Chatterbox, his voice sample, the models
  setup() {
    if (this.job) return { ok: true, already: true, ...this.job.view() };
    const job = (this.job = new Job(this.broadcast));
    dlog("VOICE", "Chatterbox setup started");
    (async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true });
        if (!fs.existsSync(this.py)) await this.makePython(job);
        await this.installPackages(job);
        if (!fs.existsSync(path.join(this.dir, "dennis-voice.wav"))) await this.makeSample(job);
        job.step("models", "Downloading the voice models (about 4 GB, once) and loading them");
        fs.writeFileSync(this.marker, new Date().toISOString());
        await this.ensure();
        const r = await this.fetch(`http://127.0.0.1:${this.port}/warm`, { method: "POST", headers: { "Content-Type": "application/json", "X-Dennis-Voice": this.token }, body: JSON.stringify({ models: this.english === "turbo" ? ["turbo", "multilingual"] : ["multilingual"] }), signal: AbortSignal.any([job.abort.signal, AbortSignal.timeout(60 * 60_000)]) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `loading the models failed (${r.status})`);
        this.last = { ok: true, text: "My Chatterbox voice is ready." };
        job.step("done", this.last.text, 100);
      } catch (e) {
        if (!this.installed) try { fs.rmSync(this.marker, { force: true }); } catch { /* none */ }
        this.last = { ok: false, text: job.abort.signal.aborted ? "Chatterbox setup cancelled." : String(e?.message || e) };
        job.step("failed", this.last.text);
      } finally {
        this.job = null;
        this.broadcast({ type: "chatterbox", phase: this.last?.ok ? "done" : "failed", text: this.last?.text || "", pct: null, final: true });
      }
    })();
    return { ok: true, ...job.view() };
  }

  cancel() { if (!this.job) return false; this.job.abort.abort(); return true; }

  async makePython(job) {
    job.step("python", "Making a private Python for the voice");
    const uv = findUv();
    if (uv) {
      const r = await run(uv, ["venv", path.join(this.dir, "venv"), "--python", "3.11"], { cwd: this.dir });
      if (!r.ok) throw new Error(`Couldn't make the voice's Python: ${r.err.slice(-300)}`);
      return;
    }
    // no uv: the system's Python 3.10 or later
    const tries = process.platform === "win32" ? [["py", ["-3.11", "-m", "venv"]], ["py", ["-3.12", "-m", "venv"]], ["python", ["-m", "venv"]]] : [["python3.11", ["-m", "venv"]], ["python3", ["-m", "venv"]]];
    for (const [cmd, args] of tries) {
      const r = await run(cmd, [...args, path.join(this.dir, "venv")]);
      if (r.ok && fs.existsSync(this.py)) return;
    }
    throw new Error("The Chatterbox voice needs Python 3.11 (python.org) or uv (astral.sh/uv). Install either, then press SET UP CHATTERBOX again.");
  }

  async pip(args, job) {
    const uv = findUv();
    const [cmd, full] = uv ? [uv, ["pip", "install", "--python", this.py, ...args]] : [this.py, ["-m", "pip", "install", ...args]];
    const r = await new Promise((resolve) => {
      const p = spawn(cmd, full, { cwd: this.dir, windowsHide: true });
      let err = "";
      p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
      p.stdout.on("data", () => {});
      job.abort.signal.addEventListener("abort", () => { try { p.kill(); } catch { /* gone */ } }, { once: true });
      p.on("error", (e) => resolve({ ok: false, err: e.message }));
      p.on("exit", (code) => resolve({ ok: code === 0, err }));
    });
    if (!r.ok) throw new Error(job.abort.signal.aborted ? "cancelled" : `Installing ${args.find((a) => !a.startsWith("-")) || "packages"} failed: ${r.err.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  }

  async installPackages(job) {
    const nvidia = await run("nvidia-smi", ["-L"], { timeout: 8000 });
    const cuda = nvidia.ok && /GPU/.test(nvidia.out) && process.platform !== "darwin";
    job.step("torch", `Installing PyTorch${cuda ? " for your NVIDIA card (about 2.5 GB)" : ""}`);
    await this.pip(["torch==2.6.0", "torchaudio==2.6.0", ...(cuda ? ["--index-url", "https://download.pytorch.org/whl/cu124"] : [])], job);
    job.step("chatterbox", "Installing Chatterbox");
    await this.pip(["chatterbox-tts", "setuptools<80"], job); // its watermarker still needs pkg_resources
  }

  /** His voice to clone: Kokoro's "Daniel", made with Electron's own Node (or Node, outside the app). */
  async makeSample(job) {
    job.step("sample", "Recording the voice I'll speak in");
    const voice = this.config.get("voice")?.kokoroVoice || "bm_daniel";
    const r = await run(process.execPath, [SAMPLE_JS, path.join(this.dir, "dennis-voice.wav"), voice], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10 * 60_000 });
    if (!r.ok || !fs.existsSync(path.join(this.dir, "dennis-voice.wav"))) throw new Error(`Couldn't make the voice sample: ${r.err.slice(-300)}`);
  }

  /** Your own voice sample (a .wav of 10-20 seconds of clear speech, of a voice you may use). */
  useSample(file) {
    if (!file) { this.config.update({ voice: { chatterboxSample: "" } }); return this.sample; }
    if (!/\.(wav|mp3|flac|ogg)$/i.test(file) || !fs.existsSync(file)) throw new Error("Choose a .wav, .mp3, .flac or .ogg file.");
    const dest = path.join(this.dir, `your-voice${path.extname(file).toLowerCase()}`);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.copyFileSync(file, dest);
    this.config.update({ voice: { chatterboxSample: dest } });
    dlog("VOICE", `Chatterbox will clone the voice in ${path.basename(file)}`);
    return dest;
  }

  close() { this.cancel(); this.stop(); }
}
