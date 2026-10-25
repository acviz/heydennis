// D.E.N.N.I.S.'s daily log: one plain-text file per day in ~/.dennis/logs (2026-10-22.log) with
// everything about him - what you said and what he said, every tool he used and what it gave back,
// approvals asked and answered, messages to and from your phone, minions, reminders, apps, his
// brain, settings changes, voice trouble, errors, starts, stops and reboots.
//
// Keys, tokens and signed links are scrubbed before anything is written. Days older than
// `logs.keepDays` are removed (0 keeps every day). He can read his own log (the read_log tool),
// so "what did we do yesterday?" has an answer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_DIR = path.join(process.env.DENNIS_HOME || path.join(os.homedir(), ".dennis"), "logs");
export const LOG_DEFAULTS = { enabled: true, keepDays: 90 };
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.log$/;
const MAX_TEXT = 4000, MAX_DETAIL = 1500;

let settings = () => LOG_DEFAULTS;
let pruneTimer = null;

/** Follow the settings (logs: { enabled, keepDays }) and clear out days past keeping. */
export function initLog(config) {
  settings = () => ({ ...LOG_DEFAULTS, ...(config?.get?.("logs") || {}) });
  prune();
  clearInterval(pruneTimer);
  pruneTimer = setInterval(prune, 6 * 3_600_000);
  pruneTimer.unref?.();
}

const pad = (n) => String(n).padStart(2, "0");
/** Local date: "2026-10-22". */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
export const logFile = (day = dayKey()) => path.join(LOG_DIR, `${day}.log`);

// API keys, tokens, signed links (Teams workflows, OneDrive), his own sign-in link (?k=)
const SECRETS = [
  [/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-…"],
  [/\bsk[-_][A-Za-z0-9_-]{16,}/g, "sk-…"],
  [/\bEAA[A-Za-z0-9]{20,}/g, "EAA…"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza…"],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, "$1…"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 …"],
  [/\bdennis_mcp_[A-Za-z0-9]{8,}/g, "dennis_mcp_…"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "(token)"],
  [/([?&](?:sig|sv|code|token|key|k|access_token|refresh_token|client_secret|password|pwd|secret)=)[^&\s"'<>]+/gi, "$1…"],
  [/("(?:apiKey|elevenKey|openaiKey|geminiKey|deepseekKey|customKey|brainKey|waToken|waAppSecret|teamsWebhook|teamsRefresh|token|mcpToken|password|secret)"\s*:\s*")[^"]*(")/gi, "$1…$2"],
];
export function scrub(s) {
  let t = String(s ?? "");
  for (const [re, to] of SECRETS) t = t.replace(re, to);
  return t;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} … [${s.length - n} more characters]` : s);
const indent = (s) => s.replace(/\r?\n/g, "\n                    ");

/**
 * One entry: "00:41:12  KIND      text", then any detail on indented lines below.
 * kind is a short word in capitals (YOU, DENNIS, TOOL, ASK, ANSWER, PHONE, APP, BRAIN, ERROR ...).
 */
export function dlog(kind, text = "", detail = "") {
  try {
    const s = settings();
    if (s.enabled === false) return;
    const now = new Date();
    let line = `${clock(now)}  ${String(kind).toUpperCase().padEnd(8)}  ${indent(clip(scrub(text).trim(), MAX_TEXT))}`;
    const d = scrub(detail).trim();
    if (d) line += `\n                    ${indent(clip(d, MAX_DETAIL))}`;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFile(dayKey(now)), line + "\n");
  } catch { /* the log must never break him */ }
}

/** Remove days older than keepDays (only files named like a day, in the logs folder). */
export function prune(now = Date.now()) {
  const keep = Math.round(+settings().keepDays);
  if (!(keep > 0)) return 0;
  const cutoff = dayKey(new Date(now - keep * 86_400_000));
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(LOG_DIR); } catch { return 0; }
  for (const n of names) {
    const m = DAY_FILE.exec(n);
    if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(LOG_DIR, n)); removed++; } catch { /* in use */ } }
  }
  return removed;
}

/** The days on record, newest first: [{ day, bytes }]. */
export function listDays() {
  let names = [];
  try { names = fs.readdirSync(LOG_DIR); } catch { return []; }
  return names.map((n) => DAY_FILE.exec(n)?.[1]).filter(Boolean).sort().reverse()
    .map((day) => { let bytes = 0; try { bytes = fs.statSync(logFile(day)).size; } catch { /* gone */ } return { day, bytes }; });
}

/** "today", "yesterday", "2026-10-22", "22 October" ... -> "2026-10-22" (null if it can't tell). */
export function resolveDay(spec, now = new Date()) {
  const s = String(spec || "today").trim().toLowerCase();
  if (!s || s === "today") return dayKey(now);
  if (s === "yesterday") return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const ago = /^(\d+)\s*days?\s*ago$/.exec(s);
  if (ago) return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - +ago[1]));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(/\d{4}/.test(s) ? s : `${s} ${now.getFullYear()}`);
  return Number.isFinite(t) ? dayKey(new Date(t)) : null;
}

/** One day's entries (each a line plus its indented detail), optionally only those with every word of `search`; the last `limit`. */
export function readLog({ day = "today", search = "", limit = 80 } = {}) {
  const key = resolveDay(day);
  if (!key) return { day: null, entries: [], total: 0 };
  let text = "";
  try { text = fs.readFileSync(logFile(key), "utf8"); } catch { return { day: key, entries: [], total: 0 }; }
  const entries = [];
  for (const line of text.split("\n")) {
    if (/^\d{2}:\d{2}:\d{2}  /.test(line)) entries.push(line);
    else if (line.trim() && entries.length) entries[entries.length - 1] += "\n" + line;
  }
  const words = String(search).toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? entries.filter((e) => { const l = e.toLowerCase(); return words.every((w) => l.includes(w)); }) : entries;
  return { day: key, entries: hits.slice(-Math.max(1, Math.min(500, limit))), total: hits.length };
}
