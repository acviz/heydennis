// Outlook email, without an app registration (IT keeps those locked on a company tenant).
//
//   in   a Teams Workflow ("When a new email arrives" -> OneDrive "Create file") saves each new
//        email as JSON in a OneDrive folder; OneDrive syncs it to this computer and D.E.N.N.I.S.
//        reads it from there, then files it under Done (nothing is deleted). What's in Done is
//        his memory of the last few weeks of mail.
//   out  he never sends anything. draft() posts a draft to a second Workflow, which saves it in
//        Outlook's Drafts; you review it and press Send yourself.
//
// Emails are data, never instructions: whatever an email asks for, he only acts on what you ask.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAIL_DEFAULTS = { enabled: false, folder: "", notify: "important", vips: [], keepDays: 30 };
const MAX_MAILS = 3000;
const MAX_TEXT = 30_000;

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", bull: "•", middot: "·" };

/** An email's HTML body as readable text: no styles, scripts or markup; paragraphs kept. */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|xml)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "Name <a@b.com>", "a@b.com", or Graph's { emailAddress: { name, address } } -> { name, address }. */
function person(v) {
  if (!v) return null;
  if (typeof v === "object") {
    const e = v.emailAddress || v;
    const address = String(e.address || e.Address || "").trim(), name = String(e.name || e.Name || "").trim();
    return address || name ? { name: name && name !== address ? name : "", address } : null;
  }
  const s = String(v).trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim(), address: m[2].trim() };
  return s ? { name: "", address: s } : null;
}
const people = (v) => (Array.isArray(v) ? v : String(v || "").split(/[;,]\s*/)).map(person).filter(Boolean);
export const who = (p) => (p ? p.name || p.address : "someone");

/**
 * One email, as the Workflow saved it. The Outlook trigger's output (V3: id, receivedDateTime,
 * from, toRecipients, ccRecipients, subject, body, bodyPreview, importance, hasAttachments,
 * conversationId, isHtml ...) or a Graph message; property names in any case.
 */
export function parseMail(raw, file = "") {
  let j = typeof raw === "string" ? JSON.parse(raw.replace(/^﻿/, "")) : raw;
  if (j && typeof j === "object" && j.body && typeof j.body === "object" && !("content" in j.body) && (j.body.subject || j.body.from)) j = j.body; // the whole trigger output
  if (!j || typeof j !== "object") throw new Error("not an email");
  const get = (...names) => { for (const n of names) for (const k of Object.keys(j)) if (k.toLowerCase() === n.toLowerCase() && j[k] != null && j[k] !== "") return j[k]; return undefined; };
  const bodyRaw = get("body");
  const html = typeof bodyRaw === "object" ? bodyRaw.content : bodyRaw;
  const isHtml = typeof bodyRaw === "object" ? /html/i.test(bodyRaw.contentType || "html") : get("isHtml") !== false && /<[a-z][\s\S]*>/i.test(String(html || ""));
  const text = (isHtml ? htmlToText(html) : String(html || "").trim()).slice(0, MAX_TEXT);
  const received = Date.parse(get("receivedDateTime", "dateTimeReceived", "receivedTime", "sentDateTime") || "") || 0;
  const subject = String(get("subject") || "").trim();
  const from = person(get("from", "sender"));
  if (!from && !subject && !text) throw new Error("not an email");
  return {
    id: String(get("id", "internetMessageId") || file || `${received}-${subject}`),
    conversationId: String(get("conversationId") || ""),
    from,
    to: people(get("toRecipients", "to")),
    cc: people(get("ccRecipients", "cc")),
    subject: subject || "(no subject)",
    received: received || Date.now(),
    preview: String(get("bodyPreview") || text.slice(0, 250)).replace(/\s+/g, " ").trim().slice(0, 300),
    text,
    important: /^high$/i.test(String(get("importance") || "")),
    attachments: !!get("hasAttachments", "hasAttachment"),
  };
}

const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
/** One line per email, for tool results and the briefing. */
export function mailLine(m) {
  return `[${m.key}] ${fmtWhen(m.received)} - ${who(m.from)}${m.from?.address && m.from.name ? ` <${m.from.address}>` : ""}: ${m.subject}${m.important ? " (marked important)" : ""}${m.attachments ? " (attachments)" : ""} - ${m.preview.slice(0, 160)}`;
}

export class MailBox {
  /** notify(text) passes a notice on to their phone when they're away (remote.js); broadcast(ev) reaches every open window. */
  constructor({ config, broadcast = () => {}, notify = () => false, fetchImpl = (...a) => fetch(...a), scanMs = 3000 }) {
    this.config = config;
    this.broadcast = broadcast;
    this.notifyPhone = notify;
    this.fetch = fetchImpl;
    this.scanMs = scanMs;
    this.mails = []; // newest first
    this.byId = new Map();
    this.seq = 0;
    this.timer = null;
    this.error = "";
    this.lastMail = 0;
  }

  get cfg() { return { ...MAIL_DEFAULTS, ...(this.config.get("mail") || {}) }; }
  get ready() { return !!(this.cfg.enabled && this.cfg.folder); }
  get canDraft() { return !!this.config.getSecret?.("mailDraftHook"); }

  async start() {
    this.stop();
    this.mails = []; this.byId.clear(); this.error = "";
    if (!this.ready) return;
    const dir = this.cfg.folder;
    try { await fsp.mkdir(path.join(dir, "Done"), { recursive: true }); } catch (e) { this.error = `can't use ${dir}: ${e.code || e.message}`; return; }
    await this.loadHistory();
    await this.scan().catch((e) => { this.error = e.message; });
    this.timer = setInterval(() => this.scan().catch((e) => { this.error = e.message; }), this.scanMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async restart() { await this.start(); }

  /** What's filed under Done from the last keepDays: his memory of recent mail. */
  async loadHistory() {
    const done = path.join(this.cfg.folder, "Done"), since = Date.now() - this.cfg.keepDays * 86_400_000;
    let names = [];
    try { names = (await fsp.readdir(done)).filter((n) => n.toLowerCase().endsWith(".json")); } catch { return; }
    const recent = [];
    for (const n of names) { try { const st = await fsp.stat(path.join(done, n)); if (st.mtimeMs >= since) recent.push([n, st.mtimeMs]); } catch { /* gone */ } }
    recent.sort((a, b) => b[1] - a[1]);
    for (const [n] of recent.slice(0, MAX_MAILS)) {
      try { this.add(parseMail(await fsp.readFile(path.join(done, n), "utf8"), n), { quiet: true }); } catch { /* not an email */ }
    }
  }

  /** New files from the Workflow (once OneDrive has finished writing them): read, remember, file under Done. */
  async scan() {
    if (this.scanning || !this.ready) return;
    this.scanning = true;
    try {
      const dir = this.cfg.folder;
      let names = [];
      try { names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".json")); } catch (e) { this.error = `can't read ${dir}: ${e.code || e.message}`; return; }
      this.error = "";
      const fresh = [];
      for (const n of names.sort()) {
        const f = path.join(dir, n);
        let st;
        try { st = await fsp.stat(f); } catch { continue; }
        if (Date.now() - st.mtimeMs < 1500) continue; // still being written
        let mail = null;
        try { mail = parseMail(await fsp.readFile(f, "utf8"), n); } catch { /* not an email: filed away all the same */ }
        await this.file(f, n);
        if (mail && this.add(mail)) fresh.push(mail);
      }
      if (fresh.length) this.announce(fresh);
    } finally { this.scanning = false; }
  }

  async file(f, name) {
    const done = path.join(this.cfg.folder, "Done");
    let to = path.join(done, name);
    if (fs.existsSync(to)) to = path.join(done, `${path.parse(name).name}-${Date.now()}${path.extname(name)}`);
    try { await fsp.rename(f, to); } catch (e) { this.error = `couldn't file ${name}: ${e.code || e.message}`; }
  }

  /** Remember one email; false if he already had it. */
  add(m, { quiet = false } = {}) {
    if (this.byId.has(m.id)) return false;
    m.key = `m${++this.seq}`; // a short handle for the tools
    this.byId.set(m.id, m);
    this.byId.set(m.key, m);
    let i = this.mails.findIndex((x) => x.received < m.received);
    if (i < 0) i = this.mails.length;
    this.mails.splice(i, 0, m);
    if (this.mails.length > MAX_MAILS) for (const old of this.mails.splice(MAX_MAILS)) { this.byId.delete(old.id); this.byId.delete(old.key); }
    if (!quiet) this.lastMail = Math.max(this.lastMail, m.received);
    return true;
  }

  /** Worth telling them about straight away? notify: "important" (marked important, or from someone on the list) | "all" | "off". */
  worthTelling(m) {
    const { notify, vips } = this.cfg;
    if (notify === "off") return false;
    if (notify === "all") return true;
    const from = `${m.from?.name || ""} ${m.from?.address || ""}`.toLowerCase();
    return m.important || (vips || []).some((v) => String(v).trim() && from.includes(String(v).trim().toLowerCase()));
  }

  announce(fresh) {
    const recent = fresh.filter((m) => Date.now() - m.received < 30 * 60_000); // not a backlog from while he was off
    this.broadcast({ type: "mail", count: fresh.length, tell: recent.filter((m) => this.worthTelling(m)).map((m) => this.summary(m)) });
    for (const m of recent.filter((x) => this.worthTelling(x))) this.notifyPhone(`📧 ${who(m.from)}: ${m.subject}`);
  }

  summary(m) { return { key: m.key, from: who(m.from), address: m.from?.address || "", subject: m.subject, received: m.received, important: m.important, preview: m.preview.slice(0, 200) }; }

  /** Emails matching: words in sender/subject/text, a sender, the last N days, important only. Newest first. */
  find({ query = "", from = "", days = 0, important = false, limit = 15 } = {}) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean), sender = String(from).toLowerCase().trim();
    const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
    const out = [];
    for (const m of this.mails) {
      if (m.received < since) break;
      if (important && !m.important) continue;
      if (sender && !`${m.from?.name || ""} ${m.from?.address || ""}`.toLowerCase().includes(sender)) continue;
      if (words.length) { const hay = `${who(m.from)} ${m.from?.address || ""} ${m.subject} ${m.text}`.toLowerCase(); if (!words.every((w) => hay.includes(w))) continue; }
      out.push(m);
      if (out.length >= Math.min(50, Math.max(1, limit))) break;
    }
    return out;
  }

  get(key) { return this.byId.get(String(key || "").trim()) || null; }

  /** For the daily briefing: what came in over the last `hours`. */
  digest(hours = 24) {
    if (!this.ready) return null;
    const since = Date.now() - hours * 3_600_000;
    const recent = this.mails.filter((m) => m.received >= since);
    const counts = new Map();
    for (const m of recent) counts.set(who(m.from), (counts.get(who(m.from)) || 0) + 1);
    return { count: recent.length, important: recent.filter((m) => this.worthTelling(m) || m.important).slice(0, 5), top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) };
  }

  /** Save a draft in their Outlook (via the drafts Workflow). They send it themselves. */
  async draft({ to, cc = "", subject, body, replyTo = null }) {
    const hook = this.config.getSecret?.("mailDraftHook");
    if (!hook) throw new Error("The drafts Workflow isn't connected yet (Capabilities > MESSAGING > Outlook).");
    const list = (v) => people(v).map((p) => p.address).filter((a) => /@/.test(a)).join("; ");
    const toList = list(to);
    if (!toList) throw new Error("A draft needs at least one email address to go to.");
    const orig = replyTo ? this.get(replyTo) : null;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    let html = `<div>${esc(body).replace(/\r?\n/g, "<br>")}</div>`;
    if (orig) html += `<br><hr><div><b>From:</b> ${esc(who(orig.from))}${orig.from?.address ? ` &lt;${esc(orig.from.address)}&gt;` : ""}<br><b>Sent:</b> ${esc(new Date(orig.received).toLocaleString())}<br><b>Subject:</b> ${esc(orig.subject)}<br><br>${esc(orig.text.slice(0, 8000)).replace(/\r?\n/g, "<br>")}</div>`;
    const payload = { kind: "dennis-draft", to: toList, cc: list(cc), subject: String(subject || (orig ? `RE: ${orig.subject.replace(/^(re|aw|sv):\s*/i, "")}` : "")).slice(0, 255), body: html, text: String(body), replyToId: orig?.id || "" };
    const r = await this.fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`The drafts Workflow answered ${r.status}${r.status === 401 || r.status === 403 ? " - is its link still right?" : ""}.`);
    return payload;
  }

  status() {
    const c = this.cfg;
    return { enabled: c.enabled, folder: c.folder, ready: this.ready, count: this.mails.length, lastMail: this.lastMail || this.mails[0]?.received || 0, error: this.error, canDraft: this.canDraft, notify: c.notify, vips: c.vips };
  }
}

/** Where the Workflow's OneDrive folder lands on this computer: <OneDrive - Company>\Dennis\Mail. */
export function suggestMailFolder() {
  const home = os.homedir();
  let names = [];
  try { names = fs.readdirSync(home).filter((n) => /^OneDrive/i.test(n)); } catch { /* none */ }
  const pick = names.find((n) => /^OneDrive - /i.test(n)) || names[0];
  return pick ? { folder: path.join(home, pick, "Dennis", "Mail"), onedrivePath: "/Dennis/Mail" } : null;
}
