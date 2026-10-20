// D.E.N.N.I.S. desktop app. Starts the local server in-process and shows the
// interface in a window. Adds what a browser tab can't do: OS-encrypted API key
// storage, native open/reveal, a folder picker, camera/mic permission prompts,
// a global shortcut to summon D.E.N.N.I.S. from anywhere, fullscreen, reboot, and the
// compact mode: just the core, floating on the desktop in a small transparent window.
import { app, BrowserWindow, session, shell, safeStorage, dialog, globalShortcut, systemPreferences, Menu, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, "preload.cjs");
const SUMMON = "CommandOrControl+Shift+Space";
const ORB_SIZE = 240;

let win = null;
let srv = null;
let orb = null; // the compact-mode window
let compact = false;
let dataDir = "";

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
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
  revealPath(p) { shell.showItemInFolder(p); },
  async pickFolder() {
    const r = await dialog.showOpenDialog(win, { title: "Choose a folder for D.E.N.N.I.S.", properties: ["openDirectory"] });
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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: true, backgroundThrottling: false, preload: PRELOAD },
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
function relaunch() { app.relaunch(); app.quit(); }

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
ipcMain.on("orb:menu", (e) => {
  if (!orb || e.sender !== orb.webContents) return;
  Menu.buildFromTemplate([
    { label: "Open D.E.N.N.I.S.", click: () => setCompact(false) },
    { label: "Listen", click: () => win?.webContents.executeJavaScript("window.__dennis && window.__dennis.summon()").catch(() => {}) },
    { type: "separator" },
    { label: "Reboot", click: relaunch },
    { label: "Quit", click: () => app.quit() },
  ]).popup({ window: orb });
});

app.whenReady().then(startCore).then(createWindow).catch((e) => {
  dialog.showErrorBox("D.E.N.N.I.S. couldn't start", String(e?.stack || e));
  app.quit();
});
app.on("activate", () => { if (!win && srv) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", async () => { globalShortcut.unregisterAll(); try { await srv?.close(); } catch { /* exiting anyway */ } });
