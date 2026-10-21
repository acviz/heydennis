// The file index: a background crawl of the mapped folders that powers search,
// folder sizes (the galaxy sizes orbs by them) and "what kinds of files are in
// here" summaries. Directory listings for the UI are always read live from disk;
// the index only adds the aggregate numbers.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { DATA_DIR } from "./config.js";
import { kindOf } from "./kinds.js";
import { isInside } from "./paths.js";

const CACHE_PATH = path.join(DATA_DIR, "index-cache.json.gz");
const MAX_ENTRIES = 300_000;
const MAX_DEPTH = 18;
const STAT_CONCURRENCY = 48;

// Folders that are huge, machine-generated, or private to the OS. Skipped by the
// crawler (still browsable live if a user navigates into one).
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "__pycache__", ".cache", ".npm", ".yarn", ".pnpm-store",
  ".venv", "venv", "env", "site-packages", ".gradle", ".m2", ".cargo", ".rustup", "target",
  ".next", ".nuxt", "dist-electron", ".Trash", ".Trashes", "$RECYCLE.BIN", "System Volume Information",
  "AppData", "Library", "Application Data", "Local Settings", ".DS_Store", "Thumbs.db",
]);

function pool(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

export class FileIndex {
  constructor(config) {
    this.config = config;
    this.files = []; // { p, n, k, s, m }
    this.dirs = new Map(); // path(lowercased) -> { p, files, dirs, bytes, kinds, m }
    this.status = { state: "idle", scanned: 0, total: 0, startedAt: 0, finishedAt: 0, truncated: false };
    this.listeners = new Set();
    this._timer = null;
    this.loadCache();
  }

  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(this.status); } catch { /* listener gone */ } } }

  loadCache() {
    try {
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE_PATH)).toString("utf8"));
      if (data.v !== 1) return;
      this.files = data.files;
      this.dirs = new Map(data.dirs.map((d) => [d.p.toLowerCase(), d]));
      this.status = { ...this.status, state: "cached", total: this.files.length, finishedAt: data.at };
    } catch { /* no cache yet */ }
  }

  saveCache() {
    try {
      const body = JSON.stringify({ v: 1, at: Date.now(), files: this.files, dirs: [...this.dirs.values()] });
      fs.writeFileSync(CACHE_PATH, zlib.gzipSync(body, { level: 6 }));
    } catch (e) { console.warn("[index] could not write cache:", e.message); }
  }

  schedule(everyMs = 30 * 60_000) {
    clearInterval(this._timer);
    setTimeout(() => this.rebuild(), 2500);
    this._timer = setInterval(() => this.rebuild(), everyMs);
    this._timer.unref?.();
  }

  async rebuild() {
    if (this.status.state === "scanning") return;
    const roots = this.config.get("roots") || [];
    const files = [];
    const dirs = new Map();
    this.building = { files, dirs }; // searchable while the first scan is still running
    this.status = { state: "scanning", scanned: 0, total: 0, startedAt: Date.now(), finishedAt: 0, truncated: false };
    this._emit();
    const limit = pool(STAT_CONCURRENCY);
    const showHidden = !!this.config.get("showHidden");
    let lastEmit = 0;

    const addDir = (p, parent) => {
      const rec = { p, files: 0, dirs: 0, bytes: 0, kinds: {}, m: 0, parent };
      dirs.set(p.toLowerCase(), rec);
      if (parent) parent.dirs++;
      return rec;
    };

    for (const root of roots) {
      let rootStat;
      try { rootStat = await fsp.stat(root.path); } catch { continue; }
      if (!rootStat.isDirectory()) continue;
      const queue = [{ p: root.path, depth: 0, rec: addDir(root.path, null) }];
      while (queue.length) {
        if (files.length >= MAX_ENTRIES) { this.status.truncated = true; break; }
        const { p, depth, rec } = queue.shift();
        let entries;
        try { entries = await fsp.readdir(p, { withFileTypes: true }); } catch { continue; }
        const stats = [];
        for (const e of entries) {
          if (e.isSymbolicLink()) continue;
          if (!showHidden && e.name.startsWith(".")) continue;
          const full = path.join(p, e.name);
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name) || depth >= MAX_DEPTH) continue;
            queue.push({ p: full, depth: depth + 1, rec: addDir(full, rec) });
          } else if (e.isFile()) {
            stats.push(limit(async () => {
              try {
                const st = await fsp.stat(full);
                return { p: full, n: e.name, k: kindOf(e.name), s: st.size, m: Math.round(st.mtimeMs) };
              } catch { return null; }
            }));
          }
        }
        for (const f of await Promise.all(stats)) {
          if (!f) continue;
          files.push(f);
          // roll the file up into every ancestor folder's totals
          for (let d = rec; d; d = d.parent) {
            d.files++; d.bytes += f.s; d.kinds[f.k] = (d.kinds[f.k] || 0) + 1;
            if (f.m > d.m) d.m = f.m;
          }
        }
        this.status.scanned = files.length;
        if (Date.now() - lastEmit > 400) { lastEmit = Date.now(); this._emit(); }
      }
    }
    for (const d of dirs.values()) delete d.parent; // parent pointers were only for the roll-up
    this.files = files;
    this.dirs = dirs;
    this.building = null;
    this.status = { ...this.status, state: "ready", total: files.length, finishedAt: Date.now() };
    this._emit();
    this.saveCache();
  }

  get _files() { return this.files.length || !this.building ? this.files : this.building.files; }
  get _dirs() { return this.dirs.size || !this.building ? this.dirs : this.building.dirs; }

  dirStats(p) {
    const d = this._dirs.get(path.resolve(p).toLowerCase());
    if (!d) return null;
    const { parent, ...rest } = d;
    return rest;
  }

  /**
   * Name search. Every word in the query must appear in the file name (or, failing
   * that, its folder path). Ranked by: exact name, name prefix, word hits, recency.
   */
  search(query, { kind, under, limit = 25, modifiedWithinDays, minBytes } = {}) {
    const q = String(query || "").toLowerCase().trim();
    const words = q.split(/[\s_\-.]+/).filter(Boolean);
    const since = modifiedWithinDays ? Date.now() - modifiedWithinDays * 86400_000 : 0;
    const out = [];
    for (const f of this._files) {
      if (kind && f.k !== kind) continue;
      if (since && f.m < since) continue;
      if (minBytes && f.s < minBytes) continue;
      if (under && !isInside(f.p, under)) continue;
      let score = 0;
      if (words.length) {
        const n = f.n.toLowerCase();
        let all = true, inName = 0;
        for (const w of words) {
          if (n.includes(w)) inName++;
          else if (!f.p.toLowerCase().includes(w)) { all = false; break; }
        }
        if (!all) continue;
        score = inName * 10 + (n === q ? 100 : 0) + (n.startsWith(words[0]) ? 15 : 0);
      }
      score += Math.max(0, 10 - (Date.now() - f.m) / (30 * 86400_000)); // a nudge for recent files
      out.push({ f, score });
    }
    // Also match folder names.
    if (words.length && (!kind || kind === "folder")) {
      for (const d of this._dirs.values()) {
        if (under && !isInside(d.p, under)) continue;
        const n = path.basename(d.p).toLowerCase();
        if (!words.every((w) => n.includes(w))) continue;
        out.push({ f: { p: d.p, n: path.basename(d.p), k: "folder", s: d.bytes, m: d.m, items: d.files }, score: 12 + (n === q ? 100 : 0) });
      }
    }
    out.sort((a, b) => b.score - a.score || b.f.m - a.f.m);
    return out.slice(0, limit).map((o) => o.f);
  }

  /** Keep search current between rescans when D.E.N.N.I.S. itself creates or moves something. */
  noteCreated(p) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) this._files.push({ p, n: path.basename(p), k: kindOf(p), s: st.size, m: Math.round(st.mtimeMs) });
    } catch { /* gone already */ }
  }

  /** A file or folder left the mapped folders (undo parked it): forget it and everything inside. */
  noteRemoved(p) {
    const lp = p.toLowerCase();
    const list = this._files; // the live list (the finished index, or the one being built)
    for (let i = list.length - 1; i >= 0; i--) { const l = list[i].p.toLowerCase(); if (l === lp || l.startsWith(lp + path.sep)) list.splice(i, 1); }
  }

  noteMoved(from, to) {
    const lf = from.toLowerCase();
    for (const f of this._files) {
      const lp = f.p.toLowerCase();
      if (lp === lf || lp.startsWith(lf + path.sep)) { f.p = to + f.p.slice(from.length); f.n = path.basename(f.p); }
    }
  }

  /** Files modified per day for the last `days` days (oldest first), optionally inside a folder. */
  activity(under, days = 30) {
    const DAY = 86400_000, end = new Date(); end.setHours(24, 0, 0, 0);
    const start = end.getTime() - days * DAY;
    const counts = new Array(days).fill(0);
    for (const f of this._files) {
      if (f.m < start || f.m >= end.getTime()) continue;
      if (under && !isInside(f.p, under)) continue;
      counts[Math.floor((f.m - start) / DAY)]++;
    }
    return counts;
  }

  /** Largest / newest helpers for "what's eating my disk" style questions. */
  /** Every indexed folder inside `under`, with its totals: [{ p, files, bytes, m }]. */
  folders(under) {
    const out = [];
    for (const d of this._dirs.values()) if (!under || isInside(d.p, under)) out.push({ p: d.p, files: d.files, bytes: d.bytes, m: d.m });
    return out;
  }

  /** Indexed files inside `under` (the live list; don't modify it). */
  filesUnder(under) { return this._files.filter((f) => !under || isInside(f.p, under)); }

  largest(under, limit = 15) {
    return this._files.filter((f) => !under || isInside(f.p, under)).sort((a, b) => b.s - a.s).slice(0, limit);
  }

  recent(under, limit = 15) {
    return this._files.filter((f) => !under || isInside(f.p, under)).sort((a, b) => b.m - a.m).slice(0, limit);
  }
}

/** Live directory listing for the UI and the list_folder tool. */
export async function listDir(dir, { showHidden = false, index = null, limit = 5000 } = {}) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const limiter = pool(STAT_CONCURRENCY);
  const items = await Promise.all(entries
    .filter((e) => (showHidden || !e.name.startsWith(".")) && !e.name.startsWith("~$") && e.name !== "desktop.ini" && e.name !== "Thumbs.db")
    .slice(0, limit)
    .map((e) => limiter(async () => {
      const full = path.join(dir, e.name);
      try {
        const st = await fsp.stat(full);
        const isDir = st.isDirectory();
        const item = { name: e.name, path: full, kind: kindOf(e.name, isDir), size: st.size, mtime: Math.round(st.mtimeMs), isDir };
        if (isDir) {
          const ds = index?.dirStats(full);
          if (ds) { item.size = ds.bytes; item.items = ds.files; item.kinds = ds.kinds; }
        }
        return item;
      } catch { return null; } // broken link, permission denied, vanished mid-read
    })));
  return {
    items: items.filter(Boolean).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
    truncated: entries.length > limit,
  };
}
