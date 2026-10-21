// The folder watcher: D.E.N.N.I.S. notices when something worth mentioning happens in your
// mapped folders, and says so once.
//   - a batch of new files lands in one folder (a night's renders, a card dump, a delivery)
//   - a drive is running low on space
// It's built to stay quiet: in-progress downloads, temp files and build/cache folders are
// ignored, each folder has a cooldown, there's a global minimum gap between notices, quiet
// hours, and a do-not-disturb switch. New files also go straight into the search index.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const IGNORE_DIR = /[\\/](node_modules|\.git|\.svn|__pycache__|\.cache|Intermediate|DerivedDataCache|Saved[\\/](Logs|Crashes|Autosaves)|\$RECYCLE\.BIN|System Volume Information)([\\/]|$)/i;
const IGNORE_FILE = /(^~\$|^\.|\.(tmp|temp|part|crdownload|download|partial|lock|lck|swp|log)$|^Thumbs\.db$|^desktop\.ini$)/i;
const SETTLE_MS = 45_000; // a batch is done when a folder has been quiet this long
const FOLDER_COOLDOWN_MS = 30 * 60_000;
const GLOBAL_GAP_MS = 3 * 60_000;
const DISK_EVERY_MS = 10 * 60_000;
const LOW_FRACTION = 0.08, LOW_BYTES = 15e9; // "low" = under 8% or under 15 GB

const inQuietHours = (quiet, d = new Date()) => {
  if (!quiet?.from || !quiet?.to) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  const [fh, fm] = quiet.from.split(":").map(Number), [th, tm] = quiet.to.split(":").map(Number);
  const from = fh * 60 + (fm || 0), to = th * 60 + (tm || 0);
  return from <= to ? m >= from && m < to : m >= from || m < to;
};

export class FolderWatcher {
  /** notify(notice) -> bool: deliver a notice (false if no window is open to hear it). */
  constructor({ config, index, kindOf, notify }) {
    this.config = config;
    this.index = index;
    this.kindOf = kindOf;
    this.notify = notify;
    this.watchers = [];
    this.pending = new Map(); // folder -> { files: Set, last }
    this.lastNotice = 0;
    this.folderNoticed = new Map();
    this.diskNoticed = new Map(); // drive -> day string
    this.timer = setInterval(() => this.flush(), 15_000);
    this.diskTimer = setInterval(() => this.checkDisks(), DISK_EVERY_MS);
    this.timer.unref?.(); this.diskTimer.unref?.();
    this.start();
  }

  get settings() { return { enabled: true, minFiles: 5, quiet: { from: "22:00", to: "07:00" }, dnd: false, ...(this.config.get("watch") || {}) }; }

  start() {
    this.stop();
    if (!this.settings.enabled) return;
    for (const r of this.config.get("roots") || []) {
      try {
        const w = fs.watch(r.path, { recursive: true, persistent: false }, (ev, name) => { if (name) this.onEvent(path.join(r.path, String(name))); });
        w.on("error", () => { /* the folder went away; restart() picks it up again */ });
        this.watchers.push(w);
      } catch { /* not watchable (a network share, say) */ }
    }
  }
  stop() { for (const w of this.watchers) { try { w.close(); } catch { /* closed */ } } this.watchers = []; }
  restart() { this.start(); }
  close() { this.stop(); clearInterval(this.timer); clearInterval(this.diskTimer); }

  async onEvent(p) {
    if (IGNORE_DIR.test(p) || IGNORE_FILE.test(path.basename(p))) return;
    let st;
    try { st = await fsp.stat(p); } catch { return; } // deleted or renamed away
    if (!st.isFile() || Date.now() - st.birthtimeMs > 5 * 60_000) return; // only files that are actually new
    const dir = path.dirname(p);
    let batch = this.pending.get(dir);
    if (!batch) { batch = { files: new Set(), last: 0 }; this.pending.set(dir, batch); }
    if (!batch.files.has(p)) { batch.files.add(p); this.index?.noteCreated?.(p); }
    batch.last = Date.now();
  }

  /** Batches that have gone quiet become notices (if they're big enough and it's a good moment). */
  flush() {
    const now = Date.now();
    for (const [dir, batch] of this.pending) {
      if (now - batch.last < SETTLE_MS) continue;
      this.pending.delete(dir);
      const files = [...batch.files].filter((f) => fs.existsSync(f));
      if (files.length < this.settings.minFiles) continue;
      if (now - (this.folderNoticed.get(dir) || 0) < FOLDER_COOLDOWN_MS) continue;
      const kinds = {};
      for (const f of files) { const k = this.kindOf(f); kinds[k] = (kinds[k] || 0) + 1; }
      const [kind] = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0];
      this.deliver({ type: "new_files", folder: dir, count: files.length, kind, sample: files.slice(0, 6).map((f) => path.basename(f)) }, () => this.folderNoticed.set(dir, now));
    }
  }

  async checkDisks() {
    const seen = new Set();
    for (const r of this.config.get("roots") || []) {
      const drive = path.parse(r.path).root || r.path;
      if (seen.has(drive.toLowerCase())) continue;
      seen.add(drive.toLowerCase());
      try {
        const st = await fsp.statfs(r.path);
        const free = st.bavail * st.bsize, total = st.blocks * st.bsize;
        const today = new Date().toDateString();
        if ((free / total < LOW_FRACTION || free < LOW_BYTES) && this.diskNoticed.get(drive) !== today) {
          this.deliver({ type: "disk_low", drive, free, total }, () => this.diskNoticed.set(drive, today));
        }
      } catch { /* unmounted */ }
    }
  }

  deliver(notice, done) {
    const s = this.settings;
    if (s.dnd || inQuietHours(s.quiet)) return; // try again next time it happens
    if (Date.now() - this.lastNotice < GLOBAL_GAP_MS) return;
    if (this.notify(notice) === false) return;
    this.lastNotice = Date.now();
    done?.();
  }
}

export { inQuietHours };
