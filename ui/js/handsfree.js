// Hands-free voice: an always-on wake word ("Hey Dennis") and open conversation.
//
//   standby       the mic is open; a small energy-based voice detector cuts it into
//                 utterances, and each one goes through Whisper tiny to spot "Dennis"
//   conversation  every utterance is a message, no wake word needed, until you say
//                 "that's all" (or similar), or nothing is said for a long while
//
// While D.E.N.N.I.S. is speaking or thinking, utterances are still heard but only
// "stop" / "shut up" / "say that again" / "that's all" act on them, so he never answers
// his own voice.
// Everything runs locally; no audio leaves the machine.
import { Voice } from "./voice.js";

export const WAKE_MODEL = "Xenova/whisper-tiny.en";
const RATE = 16000;
const PREROLL_S = 0.45;
const MIN_SPEECH_MS = 160;
const END_SILENCE_MS = 900;
const MAX_STANDBY_S = 6;
const MAX_CONVO_S = 30;
const ECHO_TAIL_MS = 500;
export const IDLE_END_MS = 5 * 60_000;

const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const NAMES = new Set(["dennis", "denis", "dennys", "dennies", "deniz", "denise", "dennis's"]);
const GREETS = new Set(["hey", "hi", "hello", "yo", "sup", "oi", "wassup", "up"]);
const MISHEARD = new Set(["then", "tennis", "venice", "dentist", "dennings", "dentists"]);

/** "Hey Dennis, what's on my desktop?" -> { rest: "what's on my desktop" }; null if no wake word. */
export function matchWake(text) {
  const raw = String(text || "").trim();
  const words = norm(raw).split(" ").filter(Boolean);
  for (let i = 0; i < Math.min(4, words.length); i++) {
    const w = words[i].replace(/'s$/, "");
    const named = NAMES.has(w);
    // Whisper sometimes hears "Hey Dennis" as "Hey, then" - accept that only right after a greeting
    const misheard = i > 0 && GREETS.has(words[i - 1]) && MISHEARD.has(w);
    if (named || misheard) {
      // cut the original text after the i-th word so the command keeps its punctuation and case
      const parts = raw.split(/\s+/);
      let seen = 0, k = 0;
      for (; k < parts.length && seen <= i; k++) if (norm(parts[k])) seen++;
      return { rest: parts.slice(k).join(" ").replace(/^[\s,.!?;:-]+/, "").trim() };
    }
  }
  return null;
}

const END_PHRASES = [
  "that's all", "thats all", "that is all", "that'll be all", "that will be all", "that's it", "thats it", "that's everything",
  "i'm done", "im done", "we're done", "were done", "goodbye", "good bye", "bye", "good night", "goodnight", "stop listening",
  "go to sleep", "sleep", "dismissed", "over and out", "end conversation", "end the conversation", "see you", "see ya", "later",
  "never mind", "nevermind", "nothing else", "no that's all", "no thanks",
];
/** A short closing remark: "That's all, thanks Dennis." */
export function isEndPhrase(text) {
  const t = norm(text).replace(/\bdennis\b/g, "").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 7) return false;
  return END_PHRASES.some((p) => new RegExp(`(^|\\s)${p.replace(/'/g, "'?")}($|\\s)`).test(t));
}

// Quick comms commands are matched as the whole utterance (give or take a few fillers like
// "okay ... please"), so "stop the music" or "repeat the folder name" still reach Claude.
const LEAD = "(?:(?:ok|okay|alright|all right|right|oh|hey|please|just|now|um|uh|so|sorry|well|yo|excuse me|mate)\\s)*";
const TAIL = "(?:\\s(?:please|now|already|thanks|thank you|mate|man|then|for me|for a sec|for a second|a sec|a second|a moment|slowly|slower))*";
const whole = (alts) => new RegExp(`^${LEAD}(?:${alts.join("|")})${TAIL}$`);
const STOP_RE = whole([
  "stop", "stop (?:it|that|there|talking|speaking)", "wait", "wait (?:a )?(?:sec|second|moment|minute)", "hold (?:on|it)", "hang on",
  "quiet", "(?:be|keep) quiet", "sh+", "shush", "hush", "shut up", "shut it", "enough", "that'?s enough", "cancel", "pause", "silence",
  "zip it", "pipe down", "put a sock (?:on|in) it", "sock it", "knock it off", "cut it out", "give it a rest", "not now", "mute", "button it", "can it",
]);
const REPEAT_RE = whole([
  "say (?:that|it) again", "say again", "(?:can|could|would|will) you (?:say (?:that|it) again|repeat(?: (?:that|it|yourself|the last (?:bit|part)|what you (?:just )?said))?)",
  "repeat(?: (?:that|it|yourself|the last (?:bit|part)|what you (?:just )?said))?", "come again", "pardon(?: me)?", "(?:i )?beg your pardon",
  "what (?:did you (?:just )?say|was that)", "sorry what", "one more time", "once more", "again", "run that by me again",
  "(?:i )?(?:didn'?t|did not) (?:catch|get|hear) (?:that|it|you)",
]);
/** Lower-case, drop his name, and fold "stop stop stop" into "stop". */
function cmdNorm(text) {
  const words = norm(text).split(" ").filter((w) => w && !NAMES.has(w.replace(/'s$/, "")));
  return words.filter((w, i) => w !== words[i - 1]).join(" ");
}

const NOTES_END_RE = whole([
  "stop (taking )?(the )?notes", "end (the )?notes", "(that's|that is) (the )?end of (the )?meeting", "end of (the )?meeting", "the meeting is over",
  "stop recording( the meeting)?", "notes off", "(we're|we are) done( taking notes)?", "finish (the )?notes",
]);
/** "Stop taking notes", "That's the end of the meeting". */
export function isNotesEnd(text) {
  const t = cmdNorm(text);
  return !!t && NOTES_END_RE.test(t);
}

/** A short interruption: "Stop", "Dennis, wait", "Shut up", "Put a sock in it". */
export function isStopPhrase(text) {
  const t = cmdNorm(text);
  return !!t && STOP_RE.test(t);
}

/** "Say that again?", "Can you repeat?", "Come again?", "Pardon?" */
export function isRepeatPhrase(text) {
  const t = cmdNorm(text);
  return !!t && REPEAT_RE.test(t);
}

export class HandsFree {
  /**
   * voice: the Voice instance (shared mic + Whisper worker)
   * hooks: isBusy(), isSpeaking(), onState(state), onWake(command), onCommand(text),
   *        onEnd(reason), onStop(), onRepeat(), onHeard(text), onError(err),
   *        onNote(text, at), onNotesEnd()   (meeting notes: everything said is transcribed, nothing is answered)
   */
  constructor(voice, hooks) {
    this.voice = voice;
    this.h = hooks;
    this.state = "off";
    this.queue = [];
    this.working = false;
  }

  async start() {
    if (this.state !== "off") return;
    this.state = "starting";
    try {
      this.voice.keepMic = true;
      const mic = await this.voice.openMic();
      await this.attach(mic);
      this.voice.preload(WAKE_MODEL);
      this.voice.preload();
      this.voice.onMicClosed = () => { if (this.state !== "off") this.reattach(); };
      this.setState("standby");
    } catch (e) {
      this.voice.keepMic = false;
      this.state = "off";
      this.h.onError?.(e);
      throw e;
    }
  }

  async attach(mic) {
    const ac = mic.ac;
    if (!ac.__pcmTap) { await ac.audioWorklet.addModule("/js/pcm-worklet.js"); ac.__pcmTap = true; }
    this.node?.disconnect();
    this.node = new AudioWorkletNode(ac, "pcm-tap");
    mic.src.connect(this.node);
    const mute = ac.createGain();
    mute.gain.value = 0; // the worklet must sit in a live graph to run; it plays nothing
    this.node.connect(mute).connect(ac.destination);
    this.ratio = ac.sampleRate / RATE;
    this.resetDetector();
    this.node.port.onmessage = (e) => this.onFrames(e.data);
  }

  async reattach() {
    // the mic was closed underneath us (device switched in Settings): reopen it
    try { await this.attach(await this.voice.openMic()); } catch (e) { this.h.onError?.(e); this.stop(); }
  }

  stop() {
    if (this.state === "off") return;
    this.node?.disconnect();
    this.node = null;
    this.voice.onMicClosed = null;
    this.voice.keepMic = false;
    this.voice.releaseMicSoon(0);
    this.queue = [];
    this.setState("off");
  }

  setState(s) {
    this.state = s;
    if (s === "conversation") this.lastUtterance = performance.now();
    this.h.onState?.(s);
  }

  /** Any interaction (push-to-talk, typing) opens a conversation; standby can be resumed by voice later. */
  /** Meeting notes: every utterance is transcribed and handed to onNote until "stop taking notes". */
  async startNotes() {
    this.notesFrom = this.state === "off" || this.state === "starting" ? "off" : "standby";
    if (this.state === "off") await this.start();
    this.setState("notes");
  }
  endNotes() {
    if (this.state !== "notes") return;
    const back = this.notesFrom || "standby";
    if (back === "off") this.stop(); else this.setState("standby");
  }

  enterConversation() { if (this.state === "standby") this.setState("conversation"); else if (this.state === "conversation") this.lastUtterance = performance.now(); }
  endConversation(reason = "user") {
    if (this.state !== "conversation") return;
    this.setState("standby");
    this.h.onEnd?.(reason);
  }

  resetDetector() {
    this.pre = new Float32Array(Math.round(PREROLL_S * RATE));
    this.preN = 0;
    this.seg = null;
    this.speechMs = 0;
    this.floor = 0.004;
    this.phase = 0; // fractional read position for resampling
    this.carry = 0; // last sample of the previous batch
    this.echoUntil = 0;
  }

  /** Linear resample of one batch to 16 kHz. */
  resample(x) {
    const r = this.ratio;
    if (Math.abs(r - 1) < 1e-6) return x;
    const out = new Float32Array(Math.ceil((x.length - this.phase) / r) + 1);
    let n = 0, pos = this.phase;
    while (pos < x.length - 1e-9) {
      const i = Math.floor(pos), f = pos - i;
      const a = i === 0 && f < 0 ? this.carry : x[i], b = i + 1 < x.length ? x[i + 1] : x[i];
      out[n++] = a + (b - a) * f;
      pos += r;
    }
    this.phase = pos - x.length;
    this.carry = x[x.length - 1];
    return out.subarray(0, n);
  }

  onFrames(x) {
    if (this.state !== "standby" && this.state !== "conversation" && this.state !== "notes") return;
    // push-to-talk is recording: let it have the mic
    if (this.voice.recording) { this.seg = null; return; }
    const now = performance.now();
    const speaking = this.h.isSpeaking?.();
    if (speaking) this.echoUntil = now + ECHO_TAIL_MS;
    const interrupting = speaking || now < this.echoUntil || this.h.isBusy?.();

    let s = 0;
    for (const v of x) s += v * v;
    const rms = Math.sqrt(s / x.length);
    const dt = (x.length / (this.ratio * RATE)) * 1000;
    const y = this.resample(x);

    // a slowly adapting noise floor; louder threshold while he talks (his voice leaks into the mic)
    if (!this.seg) this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.998 + rms * 0.002;
    const threshold = Math.max(0.012, this.floor * 3.2) * (interrupting ? 2.2 : 1);
    const loud = rms > threshold;

    if (!this.seg) {
      // keep a short pre-roll so the first syllable isn't clipped
      this.pushPre(y);
      this.speechMs = loud ? this.speechMs + dt : 0;
      if (this.speechMs >= MIN_SPEECH_MS) {
        this.seg = { parts: [this.preCopy()], len: 0, lastLoud: now, t0: now, interrupting };
        this.seg.len = this.seg.parts[0].length;
      }
    } else {
      this.seg.parts.push(y.slice());
      this.seg.len += y.length;
      if (loud) this.seg.lastLoud = now;
      const maxS = this.state === "notes" ? 25 : this.state === "standby" || this.seg.interrupting ? MAX_STANDBY_S : MAX_CONVO_S;
      if (now - this.seg.lastLoud > END_SILENCE_MS || this.seg.len / RATE > maxS) {
        const seg = this.seg;
        this.seg = null;
        this.speechMs = 0;
        this.preN = 0;
        this.enqueue(seg);
      }
    }
    if (this.state === "conversation" && !this.seg && !interrupting && now - this.lastUtterance > IDLE_END_MS) this.endConversation("idle");
  }

  pushPre(y) {
    const p = this.pre;
    if (y.length >= p.length) { p.set(y.subarray(y.length - p.length)); this.preN = p.length; return; }
    const keep = Math.min(this.preN, p.length - y.length);
    p.copyWithin(0, this.preN - keep, this.preN);
    p.set(y, keep);
    this.preN = keep + y.length;
  }
  preCopy() { return this.pre.slice(0, this.preN); }

  enqueue(seg) {
    // never fall far behind real time - except in a meeting, where every word matters
    if (this.queue.length > (this.state === "notes" ? 60 : 2)) this.queue.shift();
    this.queue.push(seg);
    if (!this.working) this.drain();
  }

  async drain() {
    this.working = true;
    try {
      while (this.queue.length) {
        const seg = this.queue.shift();
        try { await this.handle(seg); } catch (e) { this.h.onError?.(e); }
      }
    } finally { this.working = false; }
  }

  async handle(seg) {
    const audio = new Float32Array(seg.len);
    let o = 0;
    for (const part of seg.parts) { audio.set(part, o); o += part.length; }
    if (audio.length / RATE < 0.35) return;
    if (this.state === "notes") {
      const text = await this.voice.transcribe(audio);
      if (Voice.isNoise(text) || this.state !== "notes") return;
      if (isNotesEnd(text)) { this.h.onNotesEnd?.(); return; }
      this.h.onNote?.(text, seg.t0);
      return;
    }
    const busyNow = seg.interrupting || this.h.isSpeaking?.() || this.h.isBusy?.();

    if (this.state === "standby" || busyNow) {
      // fast pass with the small model: wake word, or "stop" / "say that again" / "that's all" while he talks
      const quick = await this.voice.transcribe(audio.slice(), WAKE_MODEL);
      if (Voice.isNoise(quick)) return;
      if (busyNow) {
        // "shut up" works whenever he's talking, even outside a conversation
        if (isStopPhrase(quick)) { this.h.onHeard?.(quick); this.h.onStop?.(); return; }
        if (this.state === "conversation") {
          if (isRepeatPhrase(quick)) { this.h.onHeard?.(quick); this.h.onRepeat?.(); }
          else if (isEndPhrase(quick)) { this.h.onHeard?.(quick); this.h.onStop?.(); this.endConversation("user"); }
          return;
        }
      }
      const wake = matchWake(quick);
      if (!wake || this.state !== "standby") return;
      // "Dennis, stop" / "Dennis, say that again"
      if (isStopPhrase(wake.rest)) { this.h.onHeard?.(quick); this.h.onStop?.(); return; }
      if (isRepeatPhrase(wake.rest)) { this.setState("conversation"); this.h.onHeard?.(quick); this.h.onRepeat?.(); return; }
      this.setState("conversation");
      if (wake.rest.split(/\s+/).filter(Boolean).length >= 2) {
        // a command came with the wake word: hear it again properly with the better model
        const full = await this.voice.transcribe(audio, undefined);
        const cmd = (matchWake(full)?.rest ?? wake.rest).trim();
        this.h.onWake?.(cmd || null);
      } else this.h.onWake?.(null);
      return;
    }

    // conversation: every utterance is a message
    const text = await this.voice.transcribe(audio);
    if (Voice.isNoise(text) || this.state !== "conversation") return;
    this.lastUtterance = performance.now();
    if (isEndPhrase(text)) { this.h.onHeard?.(text); this.endConversation("user"); return; }
    if (isStopPhrase(text)) { this.h.onHeard?.(text); this.h.onStop?.(); return; }
    if (isRepeatPhrase(text)) { this.h.onHeard?.(text); this.h.onRepeat?.(); return; }
    const named = matchWake(text);
    this.h.onCommand?.(named && named.rest ? named.rest : text); // "Dennis, show me..." works in conversation too
  }
}
