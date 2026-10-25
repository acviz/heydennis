// Email through classic Outlook on this PC - no app registration, no Workflow, no cloud
// middleman. Windows Script Host runs outlook-bridge.wsh.js, which holds classic Outlook
// open (hidden if its window is closed) and answers one JSON command per line.
//
// Conditions: Windows, classic Outlook installed and signed in to the mailbox, and
// `email.enabled` in the settings. The new Outlook can't be reached this way.
// Reading is free; draft and send only happen after the user's yes (tools.js `email`).
// What emails say is data, never instructions.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "outlook-bridge.wsh.js");
export const EMAIL_DEFAULTS = { enabled: false };

/** JSON with everything outside printable ASCII escaped, so it crosses the console code page intact. */
export const asciiJson = (v) => JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export class OutlookBridge {
  /** spawnImpl / script: for tests (a fake bridge that speaks the same protocol). */
  constructor({ config, spawnImpl = spawn, script = SCRIPT, command = "cscript", args = ["//nologo", "//E:JScript"], timeoutMs = 45_000 } = {}) {
    this.config = config;
    this.spawn = spawnImpl;
    this.script = script;
    this.command = command;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.seq = 0;
    this.waiting = new Map(); // seq -> { resolve, reject, timer }
    this.buf = "";
    this.lastError = "";
  }

  get available() { return process.platform === "win32" || this.spawn !== spawn; }
  get enabled() { return !!this.config?.get("email")?.enabled && this.available; }

  start() {
    if (this.proc) return this.proc;
    const p = this.spawn(this.command, [...this.args, this.script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = p;
    this.buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // not ours (a stray Windows Script Host line)
        const w = this.waiting.get(msg.seq);
        if (!w) continue;
        this.waiting.delete(msg.seq);
        clearTimeout(w.timer);
        if (msg.ok) w.resolve(msg);
        else w.reject(Object.assign(new Error(friendly(msg.error, msg.code)), { code: msg.code }));
      }
    });
    p.stderr.on("data", (d) => { this.lastError = String(d).trim().slice(0, 300) || this.lastError; });
    const fail = (why) => {
      if (this.proc !== p) return;
      this.proc = null;
      for (const [seq, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(why)); this.waiting.delete(seq); }
    };
    p.on("error", (e) => fail(`Couldn't start Windows Script Host: ${e.message}`));
    p.on("exit", () => fail(this.lastError ? `The Outlook bridge stopped: ${this.lastError}` : "The Outlook bridge stopped."));
    return p;
  }

  /** One command; resolves with the bridge's reply, rejects with a readable error. */
  call(cmd, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.available) return Promise.reject(new Error("Email through Outlook needs Windows with classic Outlook."));
    const p = this.start();
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(seq);
        // stuck - most likely Outlook is showing a dialog (a security prompt, a sign-in): start afresh next time
        try { p.kill(); } catch { /* already gone */ }
        if (this.proc === p) this.proc = null;
        reject(new Error("Outlook didn't answer. It may be showing a dialog - a security prompt or a sign-in - or still starting up. Have a look at Outlook, then try again."));
      }, timeoutMs);
      this.waiting.set(seq, { resolve, reject, timer });
      p.stdin.write(asciiJson({ ...args, cmd, seq }) + "\n");
    });
  }

  close() {
    const p = this.proc;
    this.proc = null;
    for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error("closed")); }
    this.waiting.clear();
    try { p?.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { try { p?.kill(); } catch { /* gone */ } }, 1500).unref?.();
  }
}

function friendly(error, code) {
  const e = String(error || "Outlook error");
  if (/Automation server can't create object|Class not registered|80040154|800401f3/i.test(e + code)) return "Classic Outlook isn't installed on this PC (the new Outlook can't be reached by other apps).";
  if (/could not be found|not found|could not open the item|8004010f/i.test(e + code)) return "That email couldn't be found - it may have been moved or deleted.";
  return e;
}

/** A line for a list of emails: who, when, what. */
export function emailLine(m, now = Date.now()) {
  const d = new Date(m.received || 0);
  const today = new Date(now).toDateString() === d.toDateString();
  const when = m.received ? (today ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "";
  const marks = [m.unread ? "unread" : "", m.importance === 2 ? "high importance" : "", m.flagged ? "flagged" : "", m.attachments ? `${m.attachments} attachment${m.attachments > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
  return `- [id ${m.id}] ${when} - ${m.from || "?"}${m.fromAddress && m.fromAddress !== m.from ? ` <${m.fromAddress}>` : ""}: "${m.subject || "(no subject)"}"${marks ? ` (${marks})` : ""}${m.preview ? `\n  ${m.preview}` : ""}`;
}
