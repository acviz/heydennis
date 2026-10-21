// Voice in and out.
//   out: sentence by sentence as the reply streams, through one of three engines:
//        "kokoro"     a natural neural voice running on this machine's GPU (default)
//        "elevenlabs" ElevenLabs' cloud voices, via the local server (needs your key)
//        "system"     the OS speech synthesizer (robotic, but always available)
//   in:  push-to-talk recording -> local Whisper (stt-worker.js); if the speech
//        model can't load and the browser has Web Speech recognition, that's used
//        as a fallback (Chrome only - Electron has no Web Speech backend)
// A deep British male voice suits him best; first match wins.
const PREFERRED_VOICES = [
  /Ryan.*Natural/i, /Thomas.*Natural/i, /^Microsoft George/i, /^Daniel/i, /^Arthur/i, /^Oliver/i,
  /Google UK English Male/i, /Guy.*Natural/i, /George/i, /Microsoft David/i, /en-GB/i,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanForSpeech(t) {
  return t
    .replace(/```[\s\S]*?```/g, " (code on screen) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>|~]+/g, " ")
    .replace(/D\.E\.N\.N\.I\.S\.?/g, "Dennis")
    .replace(/([A-Za-z]:)?(?:[\\/][^\\/\s]+){3,}[\\/]([^\\/\s]+)/g, "$2") // long paths -> just the name
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- languages ----------
// A rough guess at a reply's language, to pick a voice that can say it. Scripts settle
// Arabic, Japanese and Chinese; for Latin text, a few telltale everyday words separate
// French and Tagalog from English.
const EN_WORDS = new Set("the and is are you your to of a in it that i for on with this be have not what can will do my at me so all was we they there".split(" "));
const FR_WORDS = new Set("le la les de des et est vous je un une que qui pour pas dans sur avec votre nous ce ça c'est très bien mais oui merci bonjour bonsoir".split(" "));
const TL_WORDS = new Set("ang ng mga sa ako ikaw ka ko mo siya po na ay hindi oo ito iyon kayo tayo natin namin para may wala lang din rin ba naman salamat".split(" "));
export function textLanguage(t) {
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u3040-\u30FF]/.test(t)) return "ja"; // kana
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh"; // han and no kana
  const words = String(t).toLowerCase().match(/[a-zà-ÿ']+/g) || [];
  const hits = (set) => words.filter((w) => set.has(w)).length;
  const en = hits(EN_WORDS), fr = hits(FR_WORDS), tl = hits(TL_WORDS);
  if (fr >= 2 && fr > en) return "fr";
  if (tl >= 2 && tl > en) return "tl";
  return "en";
}
const SYSTEM_LANG = { tl: ["fil", "tl"], zh: ["zh"], ja: ["ja"], ar: ["ar"], fr: ["fr"] }; // speechSynthesis voice.lang prefixes
const LANG_NAME = { ar: "Arabic", tl: "Tagalog", fr: "French", ja: "Japanese", zh: "Chinese" };

export class Voice {
  constructor({ onSpeaking, onLevel, onStatus, onWord } = {}) {
    this.onSpeaking = onSpeaking || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onWord = onWord || (() => {});
    this.synth = window.speechSynthesis || null;
    this.cfg = { speak: true, voiceName: "", rate: 0.96, pitch: 0.85, sttModel: "Xenova/whisper-base.en", micId: "", engine: "kokoro", kokoroVoice: "bm_daniel", elevenOk: false };
    this.playQueue = [];
    this.gen = 0; // bumped by stopSpeaking: anything synthesized for an older generation is dropped
    this.kokoro = { worker: null, ready: false, failed: false, waits: new Map(), id: 0 };
    this.buf = "";
    this.queue = 0;
    this.speakingNow = false;
    this.worker = null;
    this.sttReady = false;
    this.sttFailed = false;
    this.reqId = 0;
    this.waiters = new Map();
    this.recording = null;
    if (this.synth) {
      this.pickVoice();
      this.synth.onvoiceschanged = () => this.pickVoice();
    }
  }

  configure(cfg = {}) {
    const before = this.sttModel;
    // the local voice is the main one, or the stand-in while ElevenLabs has no key
    const standIn = cfg.engine === "elevenlabs" && !(cfg.elevenOk ?? this.cfg.elevenOk);
    if ((cfg.engine === "kokoro" || standIn) && !this.kokoro.worker && (cfg.speak ?? this.cfg.speak)) setTimeout(() => this.loadKokoro(), 0);
    if ("micId" in cfg && cfg.micId !== this.cfg.micId) this.closeMic();
    if ("elevenOk" in cfg && cfg.elevenOk !== this.cfg.elevenOk) this.warnedLang = null; // a key was added or removed: explain afresh
    Object.assign(this.cfg, cfg);
    this.pickVoice();
    if (this.sttModel !== before && this.worker) { this.sttReady = false; this.preload(); } // a new model, or English <-> multilingual
  }

  voices() { return this.synth ? this.synth.getVoices().filter((v) => /^en/i.test(v.lang)) : []; }

  pickVoice() {
    const vs = this.voices();
    this.voice = (this.cfg.voiceName && vs.find((v) => v.name === this.cfg.voiceName)) || null;
    if (!this.voice) for (const re of PREFERRED_VOICES) { this.voice = vs.find((v) => re.test(v.name) || re.test(v.lang)); if (this.voice) break; }
    if (!this.voice) this.voice = vs[0] || null;
  }

  // ---------- speaking ----------
  /** Feed streamed reply text; complete sentences are spoken as they arrive. */
  feed(delta) {
    if (!this.cfg.speak) return;
    this.buf += delta;
    // a sentence ends at . ! ? ؟ followed by whitespace (so "report.pdf" and "3.5" don't split), at the
    // full-width 。！？ that Japanese and Chinese use without spaces, or at a newline
    for (let m; (m = /[.!?\u061F]+["')\]]*\s|[\u3002\uFF01\uFF1F]+[\u300D\u300F\uFF09]*|\n/.exec(this.buf));) {
      const end = m.index + m[0].length;
      this.say(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
    }
  }

  flush() {
    const rest = this.buf;
    this.buf = "";
    if (rest.trim()) this.say(rest);
  }

  /** Which engine speaks right now: the chosen one if it's usable, else the system voice. */
  engineNow() {
    if (this.cfg.engine === "kokoro" && this.kokoro.ready) return "kokoro";
    if (this.cfg.engine === "elevenlabs" && this.cfg.elevenOk && !this.elevenFailed) return "elevenlabs";
    if (this.cfg.engine === "elevenlabs" && this.kokoro.ready) return "kokoro"; // no key yet, or ElevenLabs is down: the local voice stands in
    return "system";
  }

  /** The local British voice only speaks English: other languages go to ElevenLabs if it's set up, else the system voice. */
  engineFor(text) {
    const e = this.engineNow();
    if (e !== "kokoro" || textLanguage(text) === "en") return e;
    return this.cfg.elevenOk && !this.elevenFailed ? "elevenlabs" : "system";
  }

  say(text) {
    if (!this.cfg.speak) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    const engine = this.engineFor(clean);
    if (engine !== "system") return this.sayNeural(clean, engine);
    this.saySystem(clean);
  }

  saySystem(clean) {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(clean);
    const lang = textLanguage(clean);
    const native = lang !== "en" && this.synth.getVoices().find((v) => (SYSTEM_LANG[lang] || [lang]).some((p) => v.lang.toLowerCase().startsWith(p)));
    if (lang !== "en" && !native) {
      // no voice on this computer can say it: leave it on screen rather than mangle it, and say why (once per language)
      if (!this.warnedLang?.has(lang)) {
        (this.warnedLang ||= new Set()).add(lang);
        const name = LANG_NAME[lang] || "that language", keyed = this.cfg.elevenOk;
        this.onStatus(keyed ? `ElevenLabs isn't answering, so ${name} replies are shown, not spoken - check the key in Settings → Voice`
          : `${name} replies are shown, not spoken - add your ElevenLabs key in Settings → Voice to hear them`);
        this.say(keyed ? `That one's in ${name}, but ElevenLabs isn't answering, so I can't say it aloud. Check the key in Settings.`
          : `That one's in ${name}, and I can't say ${name} aloud yet. Add your ElevenLabs key in Settings, under Voice, and I will.`);
      }
      return;
    }
    if (native) { u.voice = native; u.lang = native.lang; } // a system voice that speaks the reply's language
    else if (this.voice) u.voice = this.voice;
    u.rate = this.cfg.rate || 0.96;
    u.pitch = this.cfg.pitch ?? 0.85;
    this.queue++;
    u.onstart = () => this.setSpeaking(true);
    u.onboundary = () => this.onWord();
    u.onend = u.onerror = () => { this.queue = Math.max(0, this.queue - 1); if (!this.queue) this.setSpeaking(false); };
    this.synth.speak(u);
  }

  setSpeaking(on) {
    if (this.speakingNow === on) return;
    this.speakingNow = on;
    this.onSpeaking(on);
  }

  stopSpeaking() {
    this.buf = "";
    this.queue = 0;
    this.gen++;
    this.playQueue = [];
    try { this.current?.stop(); } catch { /* already ended */ }
    this.current = null;
    try { this.synth?.cancel(); } catch { /* nothing to cancel */ }
    this.setSpeaking(false);
  }

  // ---------- neural voices: synthesize ahead, play in order ----------
  ensureOut() {
    if (this.out) return;
    this.out = new AudioContext();
    this.outAn = this.out.createAnalyser();
    this.outAn.fftSize = 512;
    this.outAn.connect(this.out.destination);
    this.outBuf = new Float32Array(this.outAn.fftSize);
  }

  sayNeural(text, engine) {
    this.ensureOut();
    if (this.out.state === "suspended") this.out.resume().catch(() => {});
    // synthesis starts now, so sentence 2 renders while sentence 1 plays
    const audio = engine === "kokoro" ? this.kokoroSpeak(text) : this.elevenSpeak(text);
    audio.catch(() => {});
    this.playQueue.push({ text, audio, engine });
    this.queue++;
    if (!this.playing) this.playLoop(this.gen);
  }

  async playLoop(gen) {
    this.playing = true;
    try {
      while (this.playQueue.length && gen === this.gen) {
        const job = this.playQueue.shift();
        let buf = null;
        try { buf = await job.audio; }
        catch (e) {
          console.warn(`[voice] ${job.engine} failed:`, e);
          if (job.engine === "elevenlabs") { this.elevenFailed = true; this.onStatus(`ElevenLabs voice failed (${e.message}) - using the local voice`, true); }
          if (gen === this.gen) this.queue = Math.max(0, this.queue - 1);
          if (gen === this.gen) this.saySystem(job.text); // say it some other way rather than skip it
          continue;
        }
        if (gen !== this.gen) break;
        await new Promise((resolve) => {
          const src = this.out.createBufferSource();
          src.buffer = buf;
          src.connect(this.outAn);
          src.onended = resolve;
          this.current = src;
          this.setSpeaking(true);
          src.start();
          this.meterOut(src);
        });
        if (gen === this.gen) this.queue = Math.max(0, this.queue - 1);
      }
    } finally {
      this.playing = false;
      this.current = null;
      if (gen === this.gen && !this.playQueue.length && !this.synth?.speaking) this.setSpeaking(false);
    }
  }

  /** Drive the core's glow from what he is actually saying. */
  meterOut(src) {
    const tick = () => {
      if (this.current !== src) return;
      this.outAn.getFloatTimeDomainData(this.outBuf);
      let s = 0;
      for (const v of this.outBuf) s += v * v;
      this.onLevel(Math.min(1, Math.sqrt(s / this.outBuf.length) * 6));
      setTimeout(tick, 40);
    };
    tick();
  }

  // Kokoro (local, GPU). Without WebGPU it renders slower than real time, so the
  // system voice is used instead unless you insist ("kokoro-cpu" isn't offered in the UI).
  loadKokoro() {
    const k = this.kokoro;
    if (k.worker || k.failed) return;
    if (!navigator.gpu) { k.failed = true; this.onStatus("no GPU voice support here - using the system voice"); return; }
    k.worker = new Worker("/js/tts-worker.js", { type: "module" });
    k.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") this.onStatus(`downloading voice ${Math.round((m.loaded / m.total) * 100)}%`);
      else if (m.type === "ready") {
        // one throwaway sentence compiles the GPU shaders, so the first real reply is quick
        this.kokoroRaw("Ready.").then(() => { k.ready = true; this.onStatus("natural voice ready"); }).catch(() => { k.ready = true; });
      } else if (m.type === "audio" || m.type === "error") {
        const w = k.waits.get(m.id);
        if (w) { k.waits.delete(m.id); m.type === "audio" ? w.resolve(m) : w.reject(new Error(m.message)); }
        else if (m.type === "error") { k.failed = true; this.onStatus(`natural voice unavailable (${m.message}) - using the system voice`, true); }
      }
    };
    k.worker.onerror = (e) => { k.failed = true; console.warn("[voice] kokoro worker", e.message); };
    k.worker.postMessage({ type: "load", device: "webgpu" });
  }

  kokoroRaw(text) {
    const k = this.kokoro;
    const id = ++k.id;
    return new Promise((resolve, reject) => {
      k.waits.set(id, { resolve, reject });
      k.worker.postMessage({ type: "speak", id, text, voice: this.cfg.kokoroVoice || "bm_daniel", speed: Math.max(0.7, Math.min(1.3, (this.cfg.rate || 1) * 1.02)) });
    });
  }

  async kokoroSpeak(text) {
    const m = await this.kokoroRaw(text);
    const buf = this.out.createBuffer(1, m.audio.length, m.rate);
    buf.copyToChannel(m.audio, 0);
    return buf;
  }

  async elevenSpeak(text) {
    const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json", "X-Dennis": "1" }, body: JSON.stringify({ text, lang: textLanguage(text) }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return this.out.decodeAudioData(await res.arrayBuffer());
  }

  get speaking() { return this.speakingNow; }

  // ---------- listening ----------
  /** The speech model in use: the multilingual sibling of the chosen model when you speak more than English. */
  get sttModel() {
    const m = this.cfg.sttModel || "Xenova/whisper-base.en";
    return (this.cfg.language || "en") !== "en" ? m.replace(/\.en$/i, "") : m;
  }
  /** The languages Whisper may hear: ["en"], one fixed language, or your list for auto-detection. */
  get sttLanguages() {
    const l = this.cfg.language || "en";
    if (l === "auto") return (this.cfg.languages && this.cfg.languages.length ? this.cfg.languages : ["en"]).slice(0, 12);
    return [l];
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker("/js/stt-worker.js", { type: "module" });
    this.readyModels = this.readyModels || new Set();
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") this.onStatus(`downloading speech model ${Math.round((m.loaded / m.total) * 100)}%`);
      else if (m.type === "ready") {
        this.readyModels.add(m.model);
        if (m.model === this.sttModel) { this.sttReady = true; this.onStatus("speech model ready"); }
      } else if (m.type === "result" || m.type === "error") {
        if (m.type === "error") { console.warn("[stt]", m.message); if (m.model === this.sttModel && !this.sttReady) this.sttFailed = true; }
        const w = this.waiters.get(m.id);
        if (w && m.type === "result" && w.main) this.lastLang = m.language || "en"; // the language you last spoke (not the wake-word pass)
        if (w) { this.waiters.delete(m.id); m.type === "result" ? w.resolve(m.text) : w.reject(new Error(m.message)); }
        else if (m.type === "error") this.onStatus(`speech model failed: ${m.message}`, true);
      }
    };
    this.worker.onerror = (e) => { console.warn("[stt] worker error", e.message); this.sttFailed = true; this.onStatus("speech model unavailable", true); };
  }

  /** Start fetching a speech model in the background so the first talk is fast. */
  preload(model = this.sttModel) {
    this.ensureWorker();
    this.worker.postMessage({ type: "load", model });
  }

  /** Transcribe 16 kHz mono samples. The buffer is handed to the worker (pass a copy to keep it). */
  transcribe(audio, model = this.sttModel) {
    this.ensureWorker();
    const id = ++this.reqId;
    const main = model === this.sttModel;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject, main });
      this.worker.postMessage({ type: "transcribe", id, audio, model, languages: main ? this.sttLanguages : ["en"] }, [audio.buffer]);
    });
  }

  /** Whisper's habit over silence: "[BLANK_AUDIO]", "(music)", "you", "Thank you." */
  static isNoise(text) {
    const t = String(text || "").trim();
    return !t || /^[[(].*[\])]$/.test(t) || /^(you|thank you\.?|thanks for watching!?|\.+)$/i.test(t);
  }

  webSpeechAvailable() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition) && !navigator.userAgent.includes("Electron");
  }

  // ---------- microphone ----------
  /**
   * Open the mic and wait until it really delivers sound. Bluetooth headsets need a
   * second or two to switch into headset mode and send pure silence until then, so
   * "listening" is only announced once samples flow - otherwise the first words vanish.
   */
  async openMic(onConnecting) {
    clearTimeout(this.micIdle);
    const live = this.mic?.stream.getAudioTracks()[0]?.readyState === "live";
    if (live) return this.mic;
    if (this.micOpening) return this.micOpening; // push-to-talk and hands-free may ask at the same moment
    this.micOpening = this.reallyOpenMic(onConnecting).finally(() => { this.micOpening = null; });
    return this.micOpening;
  }

  async reallyOpenMic(onConnecting) {
    this.closeMic();
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: this.cfg.micId ? { ...base, deviceId: { exact: this.cfg.micId } } : base });
    } catch (e) {
      if (!this.cfg.micId || (e.name !== "OverconstrainedError" && e.name !== "NotFoundError")) throw e;
      stream = await navigator.mediaDevices.getUserMedia({ audio: base }); // the chosen mic is gone: use the default
    }
    const ac = new AudioContext();
    if (ac.state === "suspended") await ac.resume().catch(() => {});
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    const src = ac.createMediaStreamSource(stream);
    src.connect(an);
    this.mic = { stream, ac, an, src, buf: new Float32Array(an.fftSize), label: stream.getAudioTracks()[0]?.label || "" };
    onConnecting?.();
    const t0 = performance.now();
    while (performance.now() - t0 < 3000 && this.rms() < 0.0003) await sleep(40);
    this.mic.warmMs = Math.round(performance.now() - t0);
    return this.mic;
  }

  rms() {
    const m = this.mic;
    if (!m) return 0;
    m.an.getFloatTimeDomainData(m.buf);
    let s = 0;
    for (const v of m.buf) s += v * v;
    return Math.sqrt(s / m.buf.length);
  }

  // Close soon after use: while a Bluetooth mic is open the headset stays in low-quality
  // "call" audio, which would make the spoken reply sound like a phone line.
  // (Hands-free mode sets keepMic: the wake word needs the mic open all the time.)
  releaseMicSoon(ms = 1500) {
    clearTimeout(this.micIdle);
    if (this.keepMic) return;
    this.micIdle = setTimeout(() => this.closeMic(), ms);
  }
  closeMic() {
    const m = this.mic;
    this.mic = null;
    if (!m) return;
    for (const t of m.stream.getTracks()) t.stop();
    m.ac.close().catch(() => {});
    this.onMicClosed?.();
  }

  /** Microphones for the Settings picker (names appear once mic permission was granted). */
  async microphones() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications"); }
    catch { return []; }
  }

  /**
   * Start recording. Resolves once the mic is live. With `auto`, recording ends by itself
   * (onAutoStop) after you stop talking, or if nothing is heard at all.
   */
  async startListening({ auto = false, onAutoStop, onConnecting } = {}) {
    if (this.recording) return;
    this.stopSpeaking();
    if (this.sttFailed && this.webSpeechAvailable()) return this.startWebSpeech();
    this.ensureWorker();
    if (!this.sttReady) this.worker.postMessage({ type: "load", model: this.sttModel });
    const pending = { cancelled: false };
    this.recording = { pending }; // "listening" while the mic connects, so a key release can cancel it
    let mic;
    try { mic = await this.openMic(onConnecting); }
    catch (e) { this.recording = null; throw e; }
    if (pending.cancelled) { this.releaseMicSoon(); return; }
    const rec = new MediaRecorder(mic.stream);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const r = { rec, chunks, mic, t0: performance.now(), peak: 0, quiet: Infinity, smooth: 0, speechMs: 0, lastLoud: 0, warmMs: mic.warmMs };
    this.recording = r;
    rec.start(200);
    let last = performance.now();
    const meter = () => {
      if (this.recording !== r) return;
      const now = performance.now(), dt = now - last;
      last = now;
      const level = this.rms();
      r.smooth = r.smooth * 0.7 + level * 0.3;
      r.peak = Math.max(r.peak, level);
      if (r.smooth > 0.0003) r.quiet = Math.min(r.quiet, r.smooth);
      const threshold = Math.max(0.012, (Number.isFinite(r.quiet) ? r.quiet : 0.004) * 3.5);
      if (r.smooth > threshold) { r.speechMs += dt; r.lastLoud = now; }
      this.onLevel(Math.min(1, level * 5));
      if (onAutoStop && (typeof auto === "function" ? auto() : auto)) {
        const heard = r.speechMs > 250;
        if (heard && now - r.lastLoud > 1300) return onAutoStop("done talking");
        if (!heard && now - r.t0 > 7000) return onAutoStop("heard nothing");
        if (now - r.t0 > 30000) return onAutoStop("30s limit");
      }
      setTimeout(meter, 40);
    };
    meter();
  }

  /** Stop recording and return the transcript ("" for silence or a too-short press). `lastDiag` says why. */
  async stopListening() {
    const r = this.recording;
    if (!r) return "";
    if (r.web) return this.stopWebSpeech();
    if (r.pending) { r.pending.cancelled = true; this.recording = null; this.lastDiag = { reason: "released before the microphone was ready" }; return ""; }
    this.recording = null;
    this.onLevel(0);
    const stopped = new Promise((res) => (r.rec.onstop = res));
    r.rec.stop();
    await stopped;
    this.releaseMicSoon();
    const dur = performance.now() - r.t0;
    const diag = (this.lastDiag = {
      ms: Math.round(dur), warmMs: r.warmMs, peak: +r.peak.toFixed(4), floor: Number.isFinite(r.quiet) ? +r.quiet.toFixed(4) : null,
      speechMs: Math.round(r.speechMs), mic: r.mic.label, model: this.sttModel,
    });
    if (dur < 300) { diag.reason = "too short"; return ""; }
    if (r.peak < 0.004) { diag.reason = "microphone delivered no sound"; return ""; }
    const blob = new Blob(r.chunks, { type: r.rec.mimeType || "audio/webm" });
    const dc = new AudioContext({ sampleRate: 16000 });
    let audio;
    try { audio = (await dc.decodeAudioData(await blob.arrayBuffer())).getChannelData(0); }
    catch (e) { diag.reason = `audio decode failed: ${e.message}`; return ""; }
    finally { dc.close(); }
    diag.seconds = +(audio.length / 16000).toFixed(2);
    this.onStatus(this.sttReady ? "transcribing" : "loading speech model (first time only)");
    const t1 = performance.now();
    const text = await this.transcribe(audio);
    diag.sttMs = Math.round(performance.now() - t1);
    diag.raw = text;
    if (Voice.isNoise(text)) { diag.reason = "only background noise"; return ""; }
    diag.reason = "ok";
    return text;
  }

  cancelListening() {
    const r = this.recording;
    if (!r) return;
    this.recording = null;
    this.onLevel(0);
    if (r.pending) { r.pending.cancelled = true; return; }
    if (r.web) { try { r.web.abort(); } catch { /* already stopped */ } return; }
    try { r.rec.stop(); } catch { /* already stopped */ }
    this.releaseMicSoon(0);
  }

  get listening() { return !!this.recording; }

  startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const web = new SR();
    web.lang = "en-US";
    web.interimResults = false;
    web.continuous = true;
    let text = "";
    const done = new Promise((resolve) => { web.onend = () => resolve(text.trim()); });
    web.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript + " "; };
    web.onerror = () => {};
    web.start();
    this.recording = { web, done };
  }

  async stopWebSpeech() {
    const r = this.recording;
    this.recording = null;
    try { r.web.stop(); } catch { /* already stopped */ }
    return r.done;
  }
}
