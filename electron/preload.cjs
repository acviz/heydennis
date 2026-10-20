// The few desktop-shell actions the page can ask the app for: the compact orb, reboot,
// and fullscreen. Exposed as window.dennisShell; absent when D.E.N.N.I.S. runs in a browser.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dennisShell", {
  compact: (on) => ipcRenderer.send("shell:compact", !!on),
  relaunch: () => ipcRenderer.send("shell:relaunch"),
  toggleFullscreen: () => ipcRenderer.invoke("shell:fullscreen"),
  onCompact: (fn) => ipcRenderer.on("shell:compact", (_e, on) => fn(!!on)),
  onFullscreen: (fn) => ipcRenderer.on("shell:fullscreen", (_e, on) => fn(!!on)),
  // the orb window: drag it about, right-click for its menu
  orbDrag: (phase, dx = 0, dy = 0) => ipcRenderer.send("orb:drag", String(phase), +dx || 0, +dy || 0),
  orbMenu: () => ipcRenderer.send("orb:menu"),
});
