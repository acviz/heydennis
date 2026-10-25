// The free brain. Ollama runs an open model on this computer, so D.E.N.N.I.S. can think without
// a paid API key: the "auto" brain (brains.js) uses Claude when there's a key and Ollama when
// there isn't. OllamaSetup gets it going in one step:
//   install   Windows: the official installer from ollama.com, checked to be signed by Ollama,
//             then run without questions (per user, no admin). Mac: the app into Applications.
//             Linux: the official script needs your password, so that step is yours.
//   start     its background service, if it isn't running
//   model     a model sized for this machine (by graphics memory, else RAM), downloaded once
//   dennis    a copy of it with a context window long enough for his instructions and tools
//             (Ollama's own default is too short and would cut them off)
// Progress goes to every open window ({ type: "ollama" }) and into the daily log.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { dlog } from "./log.js";

export const OLLAMA_HOST = "http://127.0.0.1:11434";
const INSTALLERS = { win32: "https://ollama.com/download/OllamaSetup.exe", darwin: "https://ollama.com/download/Ollama-darwin.zip" };
/** Models for the free brain, biggest that fits first: all with tool calling (qwen3, ollama.com/library/qwen3). */
export const MODEL_TIERS = [
  { minGb: 16, model: "qwen3:14b", size: "9.3 GB" },
  { minGb: 7, model: "qwen3:8b", size: "5.2 GB" },
  { minGb: 0, model: "qwen3:4b", size: "2.5 GB" },
];
export const NUM_CTX = 16384; // room for his instructions, ~40 tools and a conversation
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)*(:[a-z0-9._-]+)?$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTag = (m) => (String(m).includes(":") ? String(m) : `${m}:latest`).toLowerCase();
export const sameModel = (a, b) => withTag(a) === withTag(b);
/** "qwen3:8b" -> "dennis-qwen3-8b": the copy with his context window. */
export const dennisName = (base) => `dennis-${String(base).replace(/:latest$/i, "").replace(/[:/]+/g, "-").toLowerCase()}`;
const run = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 20_000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || ""), err: String(stderr || err?.message || "") })));

/** The model that fits: graphics memory (NVIDIA) when there's a card, unified memory on Apple chips, else part of the RAM. */
export async function machineBudget() {
  const ramGb = os.totalmem() / 2 ** 30;
  if (process.platform === "darwin") return { gb: ramGb * (process.arch === "arm64" ? 0.6 : 0.3), basis: `${Math.round(ramGb)} GB of memory` };
  const smi = await run("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], { timeout: 8000 });
  const vram = smi.ok ? Math.max(0, ...smi.out.split(/\r?\n/).map((l) => +l.trim() || 0)) / 1024 : 0;
  if (vram >= 4) return { gb: vram, basis: `${Math.round(vram)} GB of graphics memory` };
  return { gb: Math.min(ramGb * 0.35, 12), basis: `${Math.round(ramGb)} GB of RAM (no NVIDIA graphics card found, so it runs slower on the processor)` };
}
export const pickModel = (gb) => MODEL_TIERS.find((t) => gb >= t.minGb) || MODEL_TIERS[MODEL_TIERS.length - 1];

/** Where Ollama's program is, if it's installed. */
export function findOllama() {
  const home = os.homedir(), exe = process.platform === "win32" ? "ollama.exe" : "ollama";
  const places = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "Ollama", exe), path.join(process.env.ProgramFiles || "C:\\Program Files", "Ollama", exe)]
    : process.platform === "darwin" ? ["/Applications/Ollama.app/Contents/Resources/ollama", path.join(home, "Applications/Ollama.app/Contents/Resources/ollama"), "/usr/local/bin/ollama", "/opt/homebrew/bin/ollama"]
    : ["/usr/local/bin/ollama", "/usr/bin/ollama"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) places.push(path.join(dir, exe));
  return places.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** One setup at a time, with its progress. */
class Job {
  constructor(broadcast) { this.broadcast = broadcast; this.abort = new AbortController(); this.phase = "starting"; this.text = "Setting up Ollama"; this.pct = null; this.sent = 0; this.loggedPhase = ""; }
  step(phase, text, pct = null) {
    this.phase = phase; this.text = text; this.pct = pct;
    const now = Date.now();
    if (pct == null || now - this.sent > 700 || pct >= 100) { this.sent = now; this.broadcast({ type: "ollama", ...this.view() }); }
    if (phase !== this.loggedPhase) { this.loggedPhase = phase; dlog("BRAIN", `Ollama setup: ${text}`); }
  }
  view() { return { phase: this.phase, text: this.text, pct: this.pct == null ? null : Math.round(this.pct) }; }
}

export class OllamaSetup {
  constructor({ config, broadcast = () => {}, fetchImpl = (...a) => fetch(...a), downloadsDir, platformName = process.platform }) {
    this.config = config;
    this.broadcast = broadcast;
    this.fetch = fetchImpl;
    this.downloads = downloadsDir || path.join(process.env.DENNIS_HOME || path.join(os.homedir(), ".dennis"), "downloads");
    this.platformName = platformName;
    this.job = null;
    this.last = null; // the last setup's outcome: { ok, text }
    this.budget = null;
  }

  get wanted() { return String(this.config.get("brains")?.ollama?.model || "").trim(); }

  async recommended() {
    this.budget ||= await machineBudget();
    return { ...pickModel(this.budget.gb), basis: this.budget.basis };
  }

  /** What's there: installed? running? which models? is the one he's set to use downloaded? */
  async status() {
    const exe = findOllama();
    let running = false, version = "", models = [];
    try {
      const r = await this.fetch(`${OLLAMA_HOST}/api/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { running = true; version = (await r.json()).version || ""; }
    } catch { /* not running */ }
    if (running) {
      try { models = ((await (await this.fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(4000) })).json()).models || []).map((m) => ({ name: m.name, bytes: m.size || 0 })); } catch { /* none listed */ }
    }
    const want = this.wanted;
    return {
      installed: !!exe || running, running, version, exe, models,
      model: want, hasModel: !!want && models.some((m) => sameModel(m.name, want)),
      recommended: await this.recommended(), busy: this.job ? this.job.view() : null, last: this.last,
      canInstall: this.platformName === "win32" || this.platformName === "darwin",
    };
  }

  /** Ready to think with: running, and his model is downloaded. */
  async ready() { const s = await this.status(); return s.running && s.hasModel; }

  /** Everything, in the background: install, start, download a model, make his copy, switch the brain to it. */
  setup({ model } = {}) {
    if (this.job) return { ok: true, already: true, ...this.job.view() };
    if (model && !MODEL_NAME.test(model)) return { ok: false, error: `"${model}" isn't a model name Ollama would know.` };
    const job = (this.job = new Job(this.broadcast));
    dlog("BRAIN", `Ollama setup started${model ? ` for ${model}` : ""}`);
    (async () => {
      try {
        let st = await this.status();
        if (!st.installed) { await this.install(job); st = await this.status(); }
        if (!st.running) { await this.start(job); st = await this.status(); }
        const base = model || (st.model && !st.model.startsWith("dennis-") ? st.model : st.recommended.model);
        if (!st.models.some((m) => sameModel(m.name, base))) await this.pull(base, job);
        const name = await this.makeDennisCopy(base, job);
        const brains = this.config.get("brains") || {};
        this.config.update({ brains: { ...brains, ollama: { ...(brains.ollama || {}), model: name, baseUrl: `${OLLAMA_HOST}/v1` } } });
        this.last = { ok: true, text: `Ollama is ready: I'm thinking with ${base}, on this computer.`, model: name, base };
        job.step("done", this.last.text, 100);
      } catch (e) {
        const text = job.abort.signal.aborted ? "Ollama setup cancelled." : String(e?.message || e);
        this.last = { ok: false, text };
        job.step("failed", text, null);
        dlog(job.abort.signal.aborted ? "BRAIN" : "ERROR", `Ollama setup: ${text}`);
      } finally {
        this.job = null;
        this.broadcast({ type: "ollama", phase: this.last?.ok ? "done" : "failed", text: this.last?.text || "", pct: this.last?.ok ? 100 : null, final: true });
      }
    })();
    return { ok: true, ...job.view() };
  }

  cancel() { if (!this.job) return false; this.job.abort.abort(); return true; }

  /** Installed but stopped: start it without any fuss (he needs it for this message). */
  async wake() { await this.start({ step: () => {}, abort: new AbortController() }); }

  // ---- 1. install
  async install(job) {
    const url = INSTALLERS[this.platformName];
    if (!url) throw new Error("On Linux, install Ollama with its official script - curl -fsSL https://ollama.com/install.sh | sh (it asks for your password) - then press SET UP OLLAMA again.");
    await fsp.mkdir(this.downloads, { recursive: true });
    const file = path.join(this.downloads, path.basename(new URL(url).pathname));
    await this.download(url, file, job);
    if (this.platformName === "win32") {
      job.step("verify", "Checking the installer is signed by Ollama");
      const sig = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`]);
      const [state, subject = ""] = sig.out.trim().split("|");
      if (state !== "Valid" || !/ollama/i.test(subject)) throw new Error(`The downloaded installer isn't validly signed by Ollama (${state || sig.err.slice(0, 120) || "no signature"}), so I didn't run it.`);
      job.step("install", "Installing Ollama (its own window shows the progress)");
      const r = await new Promise((resolve) => {
        const p = spawn(file, ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], { windowsHide: false });
        const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve({ code: "timeout" }); }, 15 * 60_000);
        p.on("error", (e) => { clearTimeout(t); resolve({ code: e.code || e.message }); });
        p.on("exit", (code) => { clearTimeout(t); resolve({ code }); });
        job.abort.signal.addEventListener("abort", () => { try { p.kill(); } catch { /* gone */ } }, { once: true });
      });
      if (r.code !== 0) throw new Error(r.code === "EPERM" || r.code === "EACCES" ? "Windows wouldn't let me run the Ollama installer - your company may block new programs. Ask IT to install Ollama, then press SET UP OLLAMA again." : `The Ollama installer stopped (${r.code}).`);
    } else {
      job.step("install", "Putting Ollama in your Applications folder");
      const r = await run("ditto", ["-x", "-k", file, "/Applications"], { timeout: 5 * 60_000 });
      if (!r.ok) throw new Error(`Couldn't unpack Ollama: ${r.err.slice(0, 200)}`);
      const sig = await run("codesign", ["--verify", "--deep", "/Applications/Ollama.app"], { timeout: 60_000 });
      if (!sig.ok) throw new Error("The Ollama app didn't pass macOS's signature check, so I didn't open it.");
    }
    for (let i = 0; i < 30 && !findOllama(); i++) await sleep(1000);
    if (!findOllama()) throw new Error("The installer finished, but Ollama isn't where it should be.");
  }

  async download(url, file, job) {
    job.step("download", "Downloading Ollama", 0);
    const res = await this.fetch(url, { redirect: "follow", signal: job.abort.signal });
    if (!res.ok || !res.body) throw new Error(`Couldn't download Ollama (${res.status})${res.status === 403 ? " - your network may block it" : ""}.`);
    const total = +res.headers.get("content-length") || 0;
    const tmp = `${file}.part`;
    const out = fs.createWriteStream(tmp);
    let got = 0;
    try {
      for await (const chunk of res.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        job.step("download", `Downloading Ollama${total ? ` (${Math.round(total / 2 ** 20)} MB)` : ""}`, total ? (got / total) * 100 : null);
      }
      await new Promise((r, no) => out.end((e) => (e ? no(e) : r())));
    } catch (e) { out.destroy(); throw e; }
    if (total && got < total) throw new Error("The Ollama download was cut short.");
    await fsp.rename(tmp, file);
  }

  // ---- 2. start
  async start(job) {
    job.step("start", "Starting Ollama");
    const exe = findOllama();
    if (!exe) throw new Error("Ollama isn't installed.");
    if (this.platformName === "darwin") await run("open", ["-a", "Ollama"]);
    else {
      const tray = path.join(path.dirname(exe), "ollama app.exe");
      const [cmd, args] = this.platformName === "win32" && fs.existsSync(tray) ? [tray, []] : [exe, ["serve"]];
      try { spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch (e) { throw new Error(`Couldn't start Ollama: ${e.message}`); }
    }
    for (let i = 0; i < 40; i++) {
      if (job.abort.signal.aborted) throw new Error("cancelled");
      try { if ((await this.fetch(`${OLLAMA_HOST}/api/version`, { signal: AbortSignal.timeout(1500) })).ok) return; } catch { /* not yet */ }
      await sleep(750);
    }
    throw new Error("Ollama didn't start. Try opening it from the Start menu, then press SET UP OLLAMA again.");
  }

  // ---- 3. the model
  async pull(model, job) {
    if (!MODEL_NAME.test(model)) throw new Error(`"${model}" isn't a model name Ollama would know.`);
    job.step("pull", `Downloading the ${model} model`, 0);
    const res = await this.fetch(`${OLLAMA_HOST}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: true }), signal: job.abort.signal });
    if (!res.ok || !res.body) throw new Error(`Ollama couldn't download ${model} (${res.status}).`);
    const layers = new Map();
    const dec = new TextDecoder();
    let buf = "", ok = false;
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.error) throw new Error(`Ollama couldn't download ${model}: ${j.error}`);
        if (j.digest && j.total) layers.set(j.digest, { total: j.total, done: j.completed || 0 });
        const total = [...layers.values()].reduce((a, l) => a + l.total, 0), done = [...layers.values()].reduce((a, l) => a + l.done, 0);
        if (j.status === "success") ok = true;
        job.step("pull", `Downloading the ${model} model${total ? ` (${(total / 2 ** 30).toFixed(1)} GB)` : ""}`, total ? (done / total) * 100 : null);
      }
    }
    if (!ok) throw new Error(`The ${model} download didn't finish.`);
  }

  /** His copy of the model, with a context window that fits his instructions and tools. */
  async makeDennisCopy(base, job) {
    const name = dennisName(base);
    job.step("tune", `Making my own copy of ${base} with room for my instructions`);
    try {
      const r = await this.fetch(`${OLLAMA_HOST}/api/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name, from: base, parameters: { num_ctx: NUM_CTX }, stream: false }), signal: job.abort.signal });
      if (r.ok) return name;
      dlog("BRAIN", `Ollama couldn't make ${name} (${r.status}); using ${base} as it is`);
    } catch (e) { if (job.abort.signal.aborted) throw e; dlog("BRAIN", `Ollama couldn't make ${name}: ${e.message}; using ${base} as it is`); }
    return base; // an older Ollama: the model as it is (its shorter window may cut his instructions)
  }
}
