// OS integration when running without Electron (`npm run serve`).
// spawn() is always called with an argument array and no shell, so a file name
// can never be interpreted as a command.
import { spawn } from "node:child_process";
import path from "node:path";

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", (e) => resolve(e.message));
      child.on("spawn", () => { child.unref(); resolve(""); });
    } catch (e) { resolve(e.message); }
  });
}

export const nodePlatform = {
  electron: false,
  openPath(p) {
    if (process.platform === "win32") return run("explorer.exe", [p]);
    if (process.platform === "darwin") return run("open", [p]);
    return run("xdg-open", [p]);
  },
  revealPath(p) {
    if (process.platform === "win32") return run("explorer.exe", [`/select,${p}`]);
    if (process.platform === "darwin") return run("open", ["-R", p]);
    return run("xdg-open", [path.dirname(p)]);
  },
  openUrl(url) {
    if (process.platform === "win32") return run("rundll32", ["url.dll,FileProtocolHandler", url]);
    if (process.platform === "darwin") return run("open", [url]);
    return run("xdg-open", [url]);
  },
};
