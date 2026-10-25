// D.E.N.N.I.S. desktop app. Starts the local server in-process and shows the
// interface in a window. Adds what a browser tab can't do: OS-encrypted API key
// storage, native open/reveal, a folder picker, camera/mic permission prompts,
// a global shortcut to summon D.E.N.N.I.S. from anywhere, fullscreen, reboot, and the
// compact mode: just the core, floating on the desktop in a small transparent window.
// Also his browser: web pages (and web apps such as Mirsam) in <webview> windows of the
// interface, locked down below - their own session, no Node, no preload, never our own origin.
import { app, BrowserWindow, session, shell, safeStorage, dialog, globalShortcut, systemPreferences, Menu, ipcMain, screen, desktopCapturer, webContents } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dlog } from "../server/log.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, "preload.cjs");
const SUMMON = "CommandOrControl+Shift+Space";
const ORB_SIZE = 280; // room for the glow around the core
const WEB_PARTITION = "persist:dennis-web"; // the browser's own cookies and logins, apart from the interface's
const plainUA = (ua) => ua.replace(/\s(Electron|dennis[\w-]*|DENNIS)\/\S+/gi, ""); // as Chrome; some sites turn away "Electron"

let win = null;
let srv = null;
let orb = null; // the compact-mode window
let compact = false;
let dataDir = "";

// His own Electron profile, in ~/.dennis/electron - not in AppData. The profile holds the key that
// encrypts his saved API keys, and AppData isn't always the same folder: programs started from a
// Store-packaged app (the Claude desktop app, for one) see a private copy of AppData, so a key saved
// in one kind of launch couldn't be read in the other. His own folder is the same however he starts.
// The first time, the profile he had is copied over (logins, settings, downloaded voice models and
// the encryption key with them; not the caches). An explicit --user-data-dir (the tests) still wins.
const PROFILE = path.join(process.env.DENNIS_HOME || path.join(os.homedir(), ".dennis"), "electron");
const PROFILE_SKIP = /^(Cache|Code Cache|GPUCache|GPUPersistentCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|Crashpad|blob_storage|lockfile|SingletonLock|SingletonCookie|SingletonSocket|DevToolsActivePort)$/i;
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) {
  const before = app.getPath("userData");
  if (!fs.existsSync(path.join(PROFILE, "Local State")) && fs.existsSync(path.join(before, "Local State"))) {
    try {
      fs.cpSync(before, PROFILE, { recursive: true, force: false, errorOnExist: false, filter: (src) => !PROFILE_SKIP.test(path.basename(src)) });
      dlog("SYSTEM", `moved his profile from ${before} to ${PROFILE}`);
    } catch (e) { dlog("ERROR", `couldn't copy his profile to ${PROFILE}: ${e.message}`); }
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  app.setPath("userData", PROFILE);
}

// One D.E.N.N.I.S. at a time. Opening him again just brings the running one forward; this copy
// exits at once, before it starts a server or a window. A reboot's new copy (--relaunched) may
// arrive while the old one is still closing, so it waits a few seconds for the lock instead.
const RELAUNCHED = process.argv.includes("--relaunched");
async function singleInstance() {
  if (app.requestSingleInstanceLock()) return true;
  for (let i = 0; RELAUNCHED && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}
app.on("second-instance", () => {
  dlog("SYSTEM", "D.E.N.N.I.S. was opened again - brought this one forward instead of starting a second copy");
  if (compact) return setCompact(false);
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

const secrets = {
  canEncrypt: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, "base64")),
};

const platform = {
  electron: true,
  async openPath(p) { return shell.openPath(p); }, // "" on success, else an error message
  async openUrl(u) { try { await shell.openExternal(u); return ""; } catch (e) { return e.message; } },
  revealPath(p) { shell.showItemInFolder(p); },
  async pickFolder() {
    const r = await dialog.showOpenDialog(win, { title: "Choose a folder for D.E.N.N.I.S.", properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0] || null;
  },
  /**
   * Screenshots for "look at my screen": the display under the cursor (or every display),
   * scaled to at most 1600 px, as JPEG. D.E.N.N.I.S.'s own windows fade out for a moment so
   * he sees what's behind them.
   */
  async captureScreen({ all = false } = {}) {
    const displays = all ? screen.getAllDisplays() : [screen.getDisplayNearestPoint(screen.getCursorScreenPoint())];
    const ours = [win, orb].filter((w) => w && !w.isDestroyed() && w.isVisible());
    const was = ours.map((w) => w.getOpacity());
    ours.forEach((w) => w.setOpacity(0));
    await new Promise((r) => setTimeout(r, 220)); // let the compositor drop them
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1600, height: 1600 } });
      return displays.map((d, i) => {
        const src = sources.find((s) => s.display_id === String(d.id)) || sources[i] || sources[0];
        const img = src.thumbnail;
        return { label: all ? `display ${i + 1}${d.id === screen.getPrimaryDisplay().id ? " (main)" : ""}` : "your screen", width: img.getSize().width, height: img.getSize().height, jpeg: img.toJPEG(82) };
      });
    } finally {
      ours.forEach((w, i) => { if (!w.isDestroyed()) w.setOpacity(was[i]); });
    }
  },
  async pickFile({ title = "Choose a file", filters } = {}) {
    const r = await dialog.showOpenDialog(win, { title, properties: ["openFile"], filters });
    return r.canceled ? null : r.filePaths[0] || null;
  },
};

let origin = "";

/** Start the server once per app run (a macOS dock click can reopen the window later). */
async function startCore() {
  // imported after `app` is ready, so safeStorage can encrypt the API key
  const { Config, DATA_DIR } = await import("../server/config.js");
  dataDir = DATA_DIR;
  const { startServer } = await import("../server/index.js");
  const known = {};
  for (const k of ["desktop", "documents", "downloads", "pictures", "music", "videos"]) { try { known[k] = app.getPath(k); } catch { /* not on this OS */ } }
  const config = new Config({ secrets, knownFolders: known });
  srv = await startServer({ config, platform, mock: process.argv.includes("--mock") });
  origin = srv.url;

  // camera + microphone only for our own page
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const fromUs = (details.requestingUrl || wc.getURL()).startsWith(origin);
    cb(fromUs && ["media", "fullscreen", "clipboard-sanitized-write"].includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => !!requestingOrigin?.startsWith(origin) && ["media", "fullscreen"].includes(permission));
  // the browser: web pages get no camera, microphone, location or notifications - fullscreen and copying only.
  // It introduces itself as plain Chrome (some sites turn away an "Electron" browser).
  const web = session.fromPartition(WEB_PARTITION);
  const WEB_OK = ["fullscreen", "clipboard-sanitized-write"];
  web.setPermissionRequestHandler((wc, permission, cb) => cb(WEB_OK.includes(permission)));
  web.setPermissionCheckHandler((wc, permission) => WEB_OK.includes(permission));
  web.setUserAgent(plainUA(web.getUserAgent()));
  if (process.platform === "darwin") {
    for (const m of ["camera", "microphone"]) { try { await systemPreferences.askForMediaAccess(m); } catch { /* user can grant later in System Settings */ } }
  }
  globalShortcut.register(SUMMON, () => {
    if (!win) return createWindow();
    // in compact mode the orb stays put and just starts listening
    if (compact) return void win.webContents.executeJavaScript("window.__dennis && window.__dennis.summon()").catch(() => {});
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.executeJavaScript("window.__dennis && window.__dennis.summon()").catch(() => {});
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: "#02060b",
    title: "D.E.N.N.I.S.",
    icon: path.join(HERE, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: true, backgroundThrottling: false, preload: PRELOAD, webviewTag: true },
  });
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]) : null);
  win.once("ready-to-show", () => { win.show(); });
  // external links open in the real browser; the window itself never leaves our origin
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "F11") { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.type === "keyDown" && input.key === "F12" && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.on("enter-full-screen", () => win.webContents.send("shell:fullscreen", true));
  win.on("leave-full-screen", () => win.webContents.send("shell:fullscreen", false));
  win.on("closed", () => { win = null; compact = false; orb?.destroy(); });
  await win.loadURL(srv.openUrl);
  // smoke test hook: DENNIS_SMOKE=out.png captures the window after boot and quits
  if (process.env.DENNIS_SMOKE) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      (await import("node:fs")).writeFileSync(process.env.DENNIS_SMOKE, img.toPNG());
      app.quit();
    }, 9000);
  }
}

// ---------------------------------------------------------------- compact mode: the orb
const orbFile = () => path.join(dataDir, "orb.json");
function orbBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const def = { x: wa.x + wa.width - ORB_SIZE - 32, y: wa.y + wa.height - ORB_SIZE - 32 };
  let p = def;
  try {
    const saved = JSON.parse(fs.readFileSync(orbFile(), "utf8"));
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) p = { x: Math.round(saved.x), y: Math.round(saved.y) };
  } catch { /* first time: bottom-right corner */ }
  // still on a screen? (monitors get unplugged)
  const d = screen.getDisplayMatching({ ...p, width: ORB_SIZE, height: ORB_SIZE }).workArea;
  const half = ORB_SIZE / 2;
  const visible = p.x > d.x - half && p.y > d.y - half && p.x + half < d.x + d.width && p.y + half < d.y + d.height;
  return { ...(visible ? p : def), width: ORB_SIZE, height: ORB_SIZE };
}
function saveOrb() {
  if (!orb) return;
  const [x, y] = orb.getPosition();
  try { fs.writeFileSync(orbFile(), JSON.stringify({ x, y })); } catch { /* not worth failing over */ }
}
function createOrb() {
  orb = new BrowserWindow({
    ...orbBounds(),
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, thickFrame: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, title: "D.E.N.N.I.S.",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, preload: PRELOAD },
  });
  orb.setAlwaysOnTop(true, "floating");
  orb.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  orb.webContents.on("will-navigate", (e) => e.preventDefault());
  const o = orb;
  o.on("closed", () => { if (orb === o) { orb = null; if (compact) setCompact(false); } });
  o.loadURL(`${origin}/orb.html`);
}
/** Compact: hide the main window and float the core on the desktop. The main page keeps
 *  running (voice, wake word, Claude) and streams its state to the orb. */
function setCompact(on) {
  if (!win || on === compact) return;
  compact = on;
  if (on) {
    if (win.isFullScreen()) win.setFullScreen(false);
    createOrb();
    const o = orb;
    // the main window only steps aside once the orb is actually on screen
    const fail = setTimeout(() => { if (orb === o && !o.isVisible()) o.destroy(); }, 8000);
    o.once("ready-to-show", () => {
      clearTimeout(fail);
      if (!compact || orb !== o) return;
      o.showInactive();
      win?.hide();
      win?.webContents.send("shell:compact", true);
    });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  saveOrb();
  const o = orb;
  orb = null;
  o?.destroy(); // frees its GPU work; it's rebuilt next time
  win.webContents.send("shell:compact", false);
}
// once only: on Windows every app.relaunch() call starts its own new copy when this one exits
let relaunching = false;
function relaunch() {
  if (relaunching) return;
  relaunching = true;
  dlog("SYSTEM", "rebooting");
  app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== "--relaunched"), "--relaunched"] });
  app.quit();
}

// ---------------------------------------------------------------- his browser: <webview> guests
/** Web pages only (http/https), and never the interface itself: a page must not reach his API. */
const webUrlOk = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && (!origin || x.origin !== origin); } catch { return false; } };
app.on("web-contents-created", (_e, contents) => {
  // only the main window may embed pages, and each one is locked down however the page asked for it
  contents.on("will-attach-webview", (e, prefs, params) => {
    delete prefs.preload;
    Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false });
    params.partition = WEB_PARTITION;
    if (!win || contents !== win.webContents || !webUrlOk(params.src)) e.preventDefault();
  });
  if (contents.getType() !== "webview") return;
  contents.setUserAgent(plainUA(contents.getUserAgent()));
  // pop-ups (target=_blank, window.open) open as another browser window in the interface
  contents.setWindowOpenHandler(({ url }) => { if (webUrlOk(url)) win?.webContents.send("web:open", url); return { action: "deny" }; });
  const guard = (e, url) => { if (!webUrlOk(url)) e.preventDefault(); };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
});
/** A browser window's page, if it really is one of the main window's. */
function guest(e, id) {
  if (!fromUs(e) || !win) return null;
  const wc = webContents.fromId(Number(id));
  return wc && !wc.isDestroyed() && wc.getType() === "webview" && wc.hostWebContents === win.webContents ? wc : null;
}
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("the page took too long to answer")), ms))]);
ipcMain.handle("web:read", async (e, id) => {
  const wc = guest(e, id);
  if (!wc) return { ok: false, error: "No web page is open." };
  try {
    const r = await within(wc.executeJavaScript("({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 60000) })", false), 8000);
    return { ok: true, title: String(r?.title || wc.getTitle()), url: wc.getURL(), text: String(r?.text || "") };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle("web:look", async (e, id) => {
  const wc = guest(e, id);
  if (!wc) return { ok: false, error: "No web page is open." };
  try {
    let img = await within(wc.capturePage(), 8000);
    if (img.isEmpty()) return { ok: false, error: "The page isn't on screen to capture." };
    if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: "good" });
    return { ok: true, title: wc.getTitle(), url: wc.getURL(), jpeg: img.toJPEG(80).toString("base64") };
  } catch (err) { return { ok: false, error: err.message }; }
});

// IPC from our own pages only
const fromUs = (e) => { try { return !!origin && new URL(e.senderFrame.url).origin === origin; } catch { return false; } };
ipcMain.on("shell:compact", (e, on) => { if (fromUs(e)) setCompact(!!on); });
ipcMain.on("shell:relaunch", (e) => { if (fromUs(e)) relaunch(); });
ipcMain.handle("shell:fullscreen", (e) => {
  if (!fromUs(e) || !win) return false;
  if (compact) setCompact(false);
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});
let dragFrom = null;
ipcMain.on("orb:drag", (e, phase, dx, dy) => {
  if (!orb || e.sender !== orb.webContents) return;
  if (phase === "start") dragFrom = orb.getPosition();
  else if (phase === "move" && dragFrom) orb.setBounds({ x: Math.round(dragFrom[0] + dx), y: Math.round(dragFrom[1] + dy), width: ORB_SIZE, height: ORB_SIZE });
  else if (phase === "end") { dragFrom = null; saveOrb(); }
});
ipcMain.on("orb:menu", async (e) => {
  if (!orb || e.sender !== orb.webContents) return;
  const convo = await win?.webContents.executeJavaScript("!!(window.__dennis && window.__dennis.S.continuous)").catch(() => false);
  if (!orb) return;
  Menu.buildFromTemplate([
    { label: "Open D.E.N.N.I.S.", click: () => setCompact(false) },
    { label: "Listen", click: () => win?.webContents.executeJavaScript("window.__dennis && window.__dennis.summon()").catch(() => {}) },
    { label: "Continuous conversation", type: "checkbox", checked: !!convo, click: () => win?.webContents.executeJavaScript(`window.__dennis && window.__dennis.setContinuous(${!convo})`).catch(() => {}) },
    { type: "separator" },
    { label: "Reboot", click: relaunch },
    { label: "Quit", click: () => app.quit() },
  ]).popup({ window: orb });
});

singleInstance().then((first) => {
  if (!first) { dlog("SYSTEM", "a second copy started and closed itself - one is already running"); return app.exit(0); } // the running copy has been asked to come forward
  return app.whenReady().then(startCore).then(createWindow);
}).catch((e) => {
  dialog.showErrorBox("D.E.N.N.I.S. couldn't start", String(e?.stack || e));
  app.quit();
});
app.on("activate", () => { if (!win && srv) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", async () => { globalShortcut.unregisterAll(); try { await srv?.close(); } catch { /* exiting anyway */ } });
