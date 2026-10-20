// Every path that reaches the file system - from the UI or from Claude - goes
// through resolveSafe(). Model output is untrusted: a path is only usable if,
// after resolving symlinks, it sits inside one of the folders the user mapped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export function expandHome(p) {
  if (typeof p !== "string") return "";
  p = p.trim().replace(/^["']|["']$/g, "");
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function key(p) {
  const n = path.resolve(p);
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

export function isInside(child, parent) {
  const c = key(child), pa = key(parent);
  if (c === pa) return true;
  const rel = path.relative(pa, c);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export class PathError extends Error {}

/**
 * Resolve `p` against the allowed roots. For paths that must exist, symlinks are
 * resolved before the containment check; for paths about to be created, the
 * nearest existing ancestor is resolved instead.
 */
export function resolveSafe(p, roots, { mustExist = true } = {}) {
  const raw = expandHome(p);
  if (!raw) throw new PathError("No path given.");
  if (!path.isAbsolute(raw)) throw new PathError(`Use a full path (got "${p}").`);
  const abs = path.resolve(raw);
  let real;
  if (fs.existsSync(abs)) {
    real = fs.realpathSync.native(abs);
  } else if (mustExist) {
    throw new PathError(`Not found: ${abs}`);
  } else {
    let up = path.dirname(abs);
    while (!fs.existsSync(up) && path.dirname(up) !== up) up = path.dirname(up);
    real = path.join(fs.realpathSync.native(up), path.relative(up, abs));
  }
  const realRoots = roots.map((r) => { try { return fs.realpathSync.native(r.path); } catch { return path.resolve(r.path); } });
  if (!realRoots.some((r) => isInside(real, r))) {
    throw new PathError(`"${abs}" is outside the folders D.E.N.N.I.S. is allowed to see. Add it in Settings first.`);
  }
  return real;
}

export function rootFor(p, roots) {
  return roots.find((r) => isInside(p, r.path)) || null;
}
