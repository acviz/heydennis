// Undo: every change to your files made by D.E.N.N.I.S. or a minion is recorded with how to
// reverse it, so "undo that" puts things back. A voice assistant mishears; acting quickly is
// only safe when acting can be taken back.
//
// Nothing is ever deleted by an undo:
//   - a new file (or a new folder with something in it) moves to ~/.dennis/undone/<time>/
//   - a new, still-empty folder is removed
//   - a move or rename moves the item back to where it was (if that spot is still free)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";

const FILE = path.join(DATA_DIR, "undo.json");
export const UNDONE_DIR = path.join(DATA_DIR, "undone");
const MAX = 60;

let stack = [];
try { stack = JSON.parse(fs.readFileSync(FILE, "utf8")); if (!Array.isArray(stack)) stack = []; } catch { /* nothing yet */ }
const save = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(stack.slice(-MAX), null, 1)); } catch { /* not fatal */ } };

/**
 * Record a change. kind: "create" (a file at `path`), "mkdir" (a folder at `path`),
 * "move" (`from` -> `to`). `label` is what to say when it's undone; `by` who did it.
 */
export function recordChange(entry) {
  stack.push({ id: crypto.randomBytes(4).toString("hex"), at: Date.now(), ...entry });
  if (stack.length > MAX) stack = stack.slice(-MAX);
  save();
}

/** The most recent changes, newest first. */
export function history(n = 10) {
  return stack.slice(-n).reverse().map(({ id, at, kind, path: p, from, to, label, by }) => ({ id, at, kind, path: p, from, to, label, by }));
}

function moveItem(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); return; } catch (e) {
    if (e.code !== "EXDEV") throw e;
  }
  // across drives: files are copied, checked and the original removed; folders are left alone
  if (fs.statSync(from).isDirectory()) throw new Error("that folder is on another drive now - move it back by hand");
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  if (fs.statSync(to).size !== fs.statSync(from).size) throw new Error("copy verification failed");
  fs.unlinkSync(from);
}

function parkInUndone(p) {
  const dir = path.join(UNDONE_DIR, new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  let dest = path.join(dir, path.basename(p));
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${n}-${path.basename(p)}`);
  moveItem(p, dest);
  return dest;
}

/** Reverse one recorded change. Returns { ok, text, refresh: [folders that changed] }. */
function reverse(e) {
  if (e.kind === "move") {
    if (!fs.existsSync(e.to)) return { ok: false, text: `${path.basename(e.to)} is no longer at ${path.dirname(e.to)}, so I couldn't move it back.` };
    if (fs.existsSync(e.from)) return { ok: false, text: `Something new is already at ${e.from}, so I left ${path.basename(e.to)} where it is.` };
    moveItem(e.to, e.from);
    return { ok: true, text: `Moved ${path.basename(e.from)} back to ${path.dirname(e.from)}.`, refresh: [path.dirname(e.to), path.dirname(e.from)], moved: [e.to, e.from] };
  }
  if (e.kind === "create" || e.kind === "mkdir") {
    if (!fs.existsSync(e.path)) return { ok: false, text: `${path.basename(e.path)} is already gone.` };
    if (e.kind === "mkdir" && fs.statSync(e.path).isDirectory() && fs.readdirSync(e.path).length === 0) {
      fs.rmdirSync(e.path); // an empty folder D.E.N.N.I.S. made: nothing in it to lose
      return { ok: true, text: `Removed the empty folder ${path.basename(e.path)}.`, refresh: [path.dirname(e.path)] };
    }
    const parked = parkInUndone(e.path);
    return { ok: true, text: `Took ${path.basename(e.path)} out of ${path.dirname(e.path)} (it's kept in ${path.dirname(parked)}, just in case).`, refresh: [path.dirname(e.path)], moved: [e.path, parked] };
  }
  return { ok: false, text: "I don't know how to undo that one." };
}

/** Undo the last `count` changes, newest first. */
export function undoLast(count = 1) {
  const results = [];
  for (let i = 0; i < Math.max(1, Math.min(10, count)); i++) {
    const e = stack.pop();
    if (!e) { if (!results.length) results.push({ ok: false, text: "There's nothing to undo." }); break; }
    try { results.push({ ...reverse(e), label: e.label }); } catch (err) { results.push({ ok: false, text: `Couldn't undo "${e.label || e.kind}": ${err.message}` }); }
  }
  save();
  return results;
}
