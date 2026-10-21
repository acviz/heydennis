// Reminders: "remind me at three to check the LED calibration". Kept in ~/.dennis/reminders.json
// and announced by every open window when they fall due (one that came due while
// D.E.N.N.I.S. was closed is announced at the next start, marked as missed). Repeating
// reminders roll forward: daily, or on weekdays.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";

const FILE = path.join(DATA_DIR, "reminders.json");
const MISSED_AFTER_MS = 2 * 60_000;

export class Reminders {
  constructor({ announce }) {
    this.announce = announce; // (reminder, { missed }) -> bool (false if nobody is listening yet)
    try { this.list = JSON.parse(fs.readFileSync(FILE, "utf8")); if (!Array.isArray(this.list)) this.list = []; } catch { this.list = []; }
    this.timer = setInterval(() => this.tick(), 10_000);
    this.timer.unref?.();
  }
  save() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(this.list, null, 1)); } catch { /* not fatal */ } }

  /** at: a time (ms, ISO string, or Date). repeat: null | "daily" | "weekdays". */
  add({ text, at, repeat = null }) {
    text = String(text || "").trim().slice(0, 500);
    const when = new Date(at);
    if (!text) throw new Error("What should I remind you about?");
    if (Number.isNaN(when.getTime())) throw new Error(`I couldn't read "${at}" as a time. Use a full date and time, like 2026-10-21T15:00.`);
    if (when.getTime() < Date.now() - 60_000) throw new Error("That time has already passed.");
    if (repeat && !["daily", "weekdays"].includes(repeat)) throw new Error('repeat must be "daily" or "weekdays".');
    const r = { id: crypto.randomBytes(3).toString("hex"), text, at: when.getTime(), repeat: repeat || null, created: Date.now(), fired: false };
    this.list.push(r);
    this.save();
    return r;
  }

  upcoming() { return this.list.filter((r) => !r.fired).sort((a, b) => a.at - b.at); }

  /** Today's still-to-come reminders and anything due today that already went off. */
  today() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = start.getTime() + 86_400_000;
    return this.list.filter((r) => r.at >= start.getTime() && r.at < end).sort((a, b) => a.at - b.at);
  }

  cancel(idOrText) {
    const k = String(idOrText || "").trim().toLowerCase();
    const r = this.list.find((x) => !x.fired && (x.id === k || x.text.toLowerCase().includes(k)));
    if (!r) return null;
    this.list = this.list.filter((x) => x !== r);
    this.save();
    return r;
  }

  nextOccurrence(r) {
    const d = new Date(r.at);
    do d.setDate(d.getDate() + 1); while (r.repeat === "weekdays" && (d.getDay() === 0 || d.getDay() === 6));
    return d.getTime();
  }

  /** Announce whatever is due (when a window is there to hear it). */
  tick() {
    const now = Date.now();
    let changed = false;
    for (const r of this.list) {
      if (r.fired || r.at > now) continue;
      const missed = now - r.at > MISSED_AFTER_MS;
      if (!this.announce(r, { missed })) return; // nobody listening yet; try again later
      changed = true;
      if (r.repeat) { do r.at = this.nextOccurrence(r); while (r.at <= now); } // roll forward, skipping any it slept through
      else r.fired = true;
    }
    // keep a week of history
    const before = this.list.length;
    this.list = this.list.filter((r) => !r.fired || now - r.at < 7 * 86_400_000);
    if (changed || this.list.length !== before) this.save();
  }

  close() { clearInterval(this.timer); }
}
