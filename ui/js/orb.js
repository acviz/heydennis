// Compact mode: the core alone, floating on the desktop. The main window keeps doing the
// work (voice, wake word, Claude) and tells us its state over a BroadcastChannel.
//   drag          move it anywhere on screen
//   click         back to the full interface
//   right-click   menu: open, listen, reboot, quit
import { Orb } from "./galaxy.js";

const el = document.getElementById("orb");
const shell = window.dennisShell || null;
const orb = new Orb(el);

const ch = new BroadcastChannel("dennis-orb");
ch.onmessage = (e) => {
  const m = e.data || {};
  if (m.state) orb.setState(m.state);
  if (typeof m.level === "number") orb.setLevel(m.level);
  if (m.pulse) orb.pulse();
};
ch.postMessage({ hello: true }); // ask for the current state straight away

let drag = null;
el.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY, moved: false };
  el.setPointerCapture(e.pointerId);
  shell?.orbDrag("start");
});
el.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 3) { drag.moved = true; el.classList.add("dragging"); }
  if (drag.moved) shell?.orbDrag("move", dx, dy);
});
el.addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  el.classList.remove("dragging");
  shell?.orbDrag("end");
  if (!d.moved) shell?.compact(false);
});
el.addEventListener("contextmenu", (e) => { e.preventDefault(); shell?.orbMenu(); });

let last = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  try { orb.render(dt); } catch (err) { if (!window.__orbErr) { window.__orbErr = String(err?.message || err); console.error("[orb]", err); } }
}
requestAnimationFrame(loop);
window.__orb = orb;
