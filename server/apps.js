// Apps you've authorized D.E.N.N.I.S. to open (Capabilities > APPS, or "add X to my apps",
// which always asks first). Nothing else is ever launched: open_file still refuses programs,
// scripts and shortcuts.
//
// An app is { name, run, page, ready, where }:
//   run    the program, script or shortcut that starts it (.exe, .bat, .lnk, .app ...)
//   page   a web address to show once it's running - a web app such as Mirsam (ComfyUI)
//   ready  optional address that answers only once it's really up (defaults to page)
//   where  "dennis": his own browser window | "browser": your default browser
// A web app that's already answering just opens; otherwise `run` starts it and he opens the
// page the moment it answers (watched in the background, so he's free meanwhile).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_APPS = 40;
const RUNNABLE = /\.(exe|bat|cmd|com|lnk|url|appref-ms|msc|app)$/i;

/** "127.0.0.1:8188/mirsam" -> "http://127.0.0.1:8188/mirsam", "example.com" -> "https://example.com". Empty if it isn't a web address. */
export function normalizeUrl(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return ""; // file://, ftp:// ...
    const local = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(s) || /^[^/]+:\d+(\/|$)/.test(s); // this PC, the LAN, or a port: plain http
    s = (local ? "http://" : "https://") + s;
  }
  try {
    const url = new URL(s);
    return /^https?:$/.test(url.protocol) && url.hostname ? url.href : "";
  } catch { return ""; }
}

/** The app list as the settings screen or add_app sends it: tidied, deduplicated, bad entries dropped. */
export function cleanApps(list) {
  const out = [], seen = new Set();
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== "object") continue;
    const name = String(a.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const run = String(a.run || "").trim().replace(/^"(.*)"$/, "$1");
    const page = normalizeUrl(a.page);
    if (!name || (!run && !page) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, run: run ? path.resolve(run) : "", page, ready: normalizeUrl(a.ready), where: a.where === "browser" ? "browser" : "dennis" });
    if (out.length >= MAX_APPS) break;
  }
  return out;
}

/** What an app is, in a few words, for the prompt and the approval card. */
export function describeApp(a) {
  if (a.page && a.run) return `web app at ${a.page}, started by ${a.run}`;
  if (a.page) return `web app at ${a.page}`;
  return `program: ${a.run}`;
}

export class AppLauncher {
  /** broadcast(ev) reaches every open window; platform has openPath and openUrl. */
  constructor({ config, platform, broadcast = () => {}, fetchImpl = (...a) => fetch(...a), waitMs = 240_000, pollMs = 2000 }) {
    this.config = config;
    this.platform = platform;
    this.broadcast = broadcast;
    this.fetch = fetchImpl;
    this.waitMs = waitMs;
    this.pollMs = pollMs;
    this.starting = new Map(); // name (lower case) -> { since, timer }
  }

  list() { return cleanApps(this.config.get("apps")); }

  /** By name: exact first, then a unique prefix ("mir" -> Mirsam). */
  find(name) {
    const want = String(name || "").trim().toLowerCase();
    if (!want) return null;
    const apps = this.list();
    const hit = apps.find((a) => a.name.toLowerCase() === want);
    if (hit) return hit;
    const near = apps.filter((a) => a.name.toLowerCase().startsWith(want) || want.startsWith(a.name.toLowerCase()));
    return near.length === 1 ? near[0] : null;
  }

  /** Does the app's web page answer? (any reply short of a server error counts) */
  async isUp(app) {
    const url = app.ready || app.page;
    if (!url) return false;
    try {
      const r = await this.fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" });
      return r.status < 500;
    } catch { return false; }
  }

  /**
   * Open an app. Resolves to { text, show? , starting? } or { error }.
   * show: { action: "web", url, title } for the caller to put on screen (his browser window).
   */
  async open(name) {
    const app = this.find(name);
    if (!app) {
      const names = this.list().map((a) => a.name);
      return { error: `"${name}" isn't one of the apps they've authorized${names.length ? ` (those are: ${names.join(", ")})` : " - none are yet"}. They can add it in Capabilities > APPS, or you can offer add_app.` };
    }
    const key = app.name.toLowerCase();
    if (app.page) {
      if (await this.isUp(app)) return this.show(app);
      if (!app.run) return { error: `${app.name} isn't answering at ${app.page}, and nothing is set to start it.` };
      if (this.starting.has(key)) return { text: `${app.name} is still starting - it opens the moment it answers.`, starting: true };
      if (!fs.existsSync(app.run)) return { error: `Can't find ${app.run} to start ${app.name}.` };
      const err = await this.platform.openPath(app.run);
      if (err) return { error: `Couldn't start ${app.name}: ${err}` };
      this.watch(app);
      return { text: `Starting ${app.name} (ran ${path.basename(app.run)}). It opens ${app.where === "browser" ? "in their browser" : "here"} as soon as it answers - usually within a minute.`, starting: true };
    }
    if (!fs.existsSync(app.run)) return { error: `Can't find ${app.run} - has it moved?` };
    const err = await this.platform.openPath(app.run);
    return err ? { error: `Couldn't open ${app.name}: ${err}` } : { text: `Opened ${app.name}.` };
  }

  async show(app) {
    if (app.where === "browser" || !this.platform.electron) {
      const err = await this.platform.openUrl?.(app.page);
      if (err) return { error: `Couldn't open ${app.page}: ${err}` };
      return { text: `Opened ${app.name} in their browser.` };
    }
    return { text: `Opened ${app.name} in a window here.`, show: { action: "web", url: app.page, title: app.name } };
  }

  /** Poll until the page answers, then put it on screen; give up after waitMs. */
  watch(app) {
    const key = app.name.toLowerCase(), since = Date.now();
    const tick = async () => {
      const entry = this.starting.get(key);
      if (!entry) return;
      if (await this.isUp(app)) {
        this.starting.delete(key);
        const r = await this.show(app);
        this.broadcast({ type: "app", phase: "ready", name: app.name, show: r.show || null, text: r.error || `${app.name} is ready.` });
        return;
      }
      if (Date.now() - since > this.waitMs) {
        this.starting.delete(key);
        this.broadcast({ type: "app", phase: "failed", name: app.name, text: `${app.name} didn't answer within ${Math.round(this.waitMs / 60000)} minutes - its own window may say why.` });
        return;
      }
      entry.timer = setTimeout(tick, this.pollMs);
    };
    this.starting.set(key, { since, timer: setTimeout(tick, this.pollMs) });
  }

  close() { for (const s of this.starting.values()) clearTimeout(s.timer); this.starting.clear(); }
}

// ---------------------------------------------------------------- finding apps on this computer
function shortcutDirs() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const pd = process.env.ProgramData || "C:\\ProgramData", ad = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const desktops = [path.join(home, "Desktop"), path.join(process.env.PUBLIC || "C:\\Users\\Public", "Desktop")];
    try { for (const n of fs.readdirSync(home)) if (/^OneDrive/i.test(n)) desktops.push(path.join(home, n, "Desktop")); } catch { /* no OneDrive */ }
    return [path.join(pd, "Microsoft", "Windows", "Start Menu", "Programs"), path.join(ad, "Microsoft", "Windows", "Start Menu", "Programs"), ...desktops];
  }
  if (process.platform === "darwin") return ["/Applications", path.join(home, "Applications"), "/System/Applications", path.join(home, "Desktop")];
  return ["/usr/share/applications", path.join(home, ".local", "share", "applications"), path.join(home, "Desktop")];
}

const appName = (file) => path.basename(file).replace(/\.(lnk|url|appref-ms|exe|bat|cmd|app|desktop)$/i, "").replace(/\s*-\s*Shortcut$/i, "").replace(/\.(bat|cmd|exe)$/i, "").trim();

/** Start-menu and desktop shortcuts (Applications on a Mac) whose name has every word of `query`. */
export function findApps(query, { dirs = shortcutDirs(), limit = 12 } = {}) {
  const words = String(query || "").toLowerCase().replace(/\.(bat|cmd|exe|lnk|url|app)\b/g, "").split(/\s+/).filter(Boolean);
  const found = [], seen = new Set();
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const isApp = e.name.endsWith(".app") || (!e.isDirectory() && (RUNNABLE.test(e.name) || e.name.endsWith(".desktop")));
      if (isApp) {
        const name = appName(p), key = name.toLowerCase();
        if (/^(uninstall|readme|license|help|website)\b/i.test(name) || seen.has(key)) continue;
        if (words.every((w) => key.includes(w))) { seen.add(key); found.push({ name, path: p }); }
      } else if (e.isDirectory() && depth < 4) walk(p, depth + 1);
    }
  };
  for (const d of dirs) walk(d, 0);
  const q = words.join(" ");
  const score = (a) => (a.name.toLowerCase() === q ? 0 : a.name.toLowerCase().startsWith(q) ? 1 : 2) + a.name.length / 1000;
  return found.sort((a, b) => score(a) - score(b)).slice(0, limit);
}

/**
 * What add_app was given, made concrete: a path that exists -> { run }, a web address -> { page },
 * otherwise a name looked up among the shortcuts -> { run } when exactly one fits, else { error }.
 */
export function resolveTarget(target, { dirs } = {}) {
  const t = String(target || "").trim().replace(/^"(.*)"$/, "$1");
  if (!t) return { error: "Say what to open: the program or shortcut's path, a web address, or its name in the Start menu." };
  if (/^([a-z]:[\\/]|\\\\|\/|~[\\/])/i.test(t)) { // C:\..., \\server\..., /..., ~/...
    const p = path.resolve(t.replace(/^~(?=[\\/])/, os.homedir()));
    return fs.existsSync(p) ? { run: p } : { error: `There's nothing at ${p}.` };
  }
  const url = !/\s/.test(t) && /[.:]/.test(t) && !/\.(bat|cmd|exe|lnk|url|app)$/i.test(t) ? normalizeUrl(t) : "";
  if (url) return { page: url };
  const found = findApps(t, dirs ? { dirs } : {});
  const exact = found.filter((f) => f.name.toLowerCase() === t.toLowerCase().replace(/\.(bat|cmd|exe|lnk)$/, ""));
  const one = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null;
  if (one) return { run: one.path, label: one.name };
  if (!found.length) return { error: `I can't find "${t}" in the Start menu or on the desktop. Ask for the path to the program or its shortcut.` };
  return { error: `Several match "${t}": ${found.slice(0, 8).map((f) => `${f.name} (${f.path})`).join("; ")}. Ask which, then call add_app again with its exact path.` };
}
