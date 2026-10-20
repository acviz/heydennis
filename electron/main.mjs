// D.E.N.N.I.S. desktop app. Starts the local server in-process and shows the
// interface in a window. Adds what a browser tab can't do: OS-encrypted API key
// storage, native open/reveal, a folder picker, camera/mic permission prompts,
// and a global shortcut to summon D.E.N.N.I.S. from anywhere.
import { app, BrowserWindow, session, shell, safeStorage, dialog, globalShortcut, systemPreferences, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUMMON = "CommandOrControl+Shift+Space";

let win = null;
let srv = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

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
  const { Config } = await import("../server/config.js");
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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: true, backgroundThrottling: false },
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
  win.on("closed", () => { win = null; });
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

app.whenReady().then(startCore).then(createWindow).catch((e) => {
  dialog.showErrorBox("D.E.N.N.I.S. couldn't start", String(e?.stack || e));
  app.quit();
});
app.on("activate", () => { if (!win && srv) createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", async () => { globalShortcut.unregisterAll(); try { await srv?.close(); } catch { /* exiting anyway */ } });
