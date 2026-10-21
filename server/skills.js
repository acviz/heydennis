// Skills: packaged instructions for particular kinds of work, in the same format as
// Claude's Agent Skills - a folder holding a SKILL.md whose frontmatter has a name and
// a description, plus any reference files the instructions mention.
//
//   ~/.dennis/skills/<skill>/SKILL.md
//
// D.E.N.N.I.S. sees every enabled skill's name and description in his instructions and
// loads the full SKILL.md (use_skill) only when a request calls for it, so installing
// many skills costs little. Reference files can be read (read_skill_file); scripts in a
// skill are never run on this computer.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { readZip } from "./office.js";

export const SKILLS_DIR = path.join(DATA_DIR, "skills");
const REMOVED_DIR = path.join(DATA_DIR, "skills-removed");
const MAX_SKILL_BYTES = 25_000_000;
const MAX_SKILL_FILES = 600;
const SKILL_FILE = /^skill\.md$/i;

/** Lowercase-hyphen id from a name: "Shot List Writer" -> "shot-list-writer". */
export function slug(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "skill";
}

/** The small YAML subset skills use: `key: value`, quoted values, and folded (>) or literal (|) blocks. */
export function parseSkill(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      meta[key] = /^[>|][+-]?$/.test(v) ? "" : v.replace(/^(["'])([\s\S]*)\1$/, "$2");
    } else if (key && /^\s+\S/.test(line)) meta[key] = (meta[key] ? meta[key] + " " : "") + line.trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function skillFileIn(dir) {
  try { return fs.readdirSync(dir).find((f) => SKILL_FILE.test(f)) || null; } catch { return null; }
}

/** Every installed skill: { id, name, description, dir, file, enabled }. */
export function listSkills(disabled = []) {
  let dirs = [];
  try { dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const dir = path.join(SKILLS_DIR, d.name);
    const f = skillFileIn(dir);
    if (!f) continue;
    let text = "";
    try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    const { meta, body } = parseSkill(text);
    const first = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || "";
    out.push({
      id: d.name,
      name: String(meta.name || d.name).trim().slice(0, 80),
      description: String(meta.description || first).replace(/\s+/g, " ").trim().slice(0, 1024),
      dir,
      file: path.join(dir, f),
      enabled: !disabled.includes(d.name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a skill by id or (case-insensitive) name. */
export function findSkill(nameOrId, disabled = []) {
  const want = String(nameOrId || "").trim().toLowerCase();
  const all = listSkills(disabled).filter((s) => s.enabled);
  return all.find((s) => s.id === want) || all.find((s) => s.name.toLowerCase() === want) || all.find((s) => s.id === slug(want)) || null;
}

/** Relative paths of the files inside a skill folder (for the model to read on demand). */
export function skillFiles(skill) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 200) return;
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (!SKILL_FILE.test(r)) out.push(r);
    }
  };
  try { walk(skill.dir, ""); } catch { /* unreadable */ }
  return out;
}

/** Resolve a path inside a skill folder; refuses anything that escapes it. */
export function skillPath(skill, rel) {
  const p = path.resolve(skill.dir, String(rel || "").replace(/^[/\\]+/, ""));
  const base = path.resolve(skill.dir) + path.sep;
  if (!p.startsWith(base)) throw new Error("That path is outside the skill's folder.");
  return p;
}

function uniqueDir(id) {
  let dir = path.join(SKILLS_DIR, id);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(SKILLS_DIR, `${id}-${n}`);
  return dir;
}

/** Where an installed skill goes: its own id. Reinstalling replaces the old copy, which is kept in skills-removed. */
function installDir(id) {
  const dir = path.join(SKILLS_DIR, id);
  if (fs.existsSync(dir)) removeSkill(id);
  return dir;
}

/** The folder holding SKILL.md: the folder itself, or a single subfolder (as in a downloaded repo zip). */
function locateRoot(dir) {
  if (skillFileIn(dir)) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("."));
  for (const s of subs) if (skillFileIn(path.join(dir, s.name))) return path.join(dir, s.name);
  return null;
}

function copyTree(from, to) {
  let bytes = 0, files = 0;
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) walk(s, d);
      else if (e.isFile()) {
        bytes += fs.statSync(s).size;
        if (++files > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw new Error("That skill is too big (over 600 files or 25 MB).");
        fs.copyFileSync(s, d);
      }
    }
  };
  walk(from, to);
}

/**
 * Install a skill from a folder, a .zip, or a lone SKILL.md / .md file. Returns the
 * installed skill. Installing one that's already there updates it; the old copy moves
 * to ~/.dennis/skills-removed rather than being deleted.
 */
export function installSkill(source) {
  const src = path.resolve(String(source || ""));
  const st = fs.statSync(src);
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  let dest;
  if (st.isDirectory()) {
    const root = locateRoot(src);
    if (!root) throw new Error("No SKILL.md in that folder.");
    const { meta } = parseSkill(fs.readFileSync(path.join(root, skillFileIn(root)), "utf8"));
    dest = installDir(slug(meta.name || path.basename(root)));
    try { copyTree(root, dest); } catch (e) { fs.rmSync(dest, { recursive: true, force: true }); throw e; }
  } else if (/\.zip$/i.test(src)) {
    if (st.size > MAX_SKILL_BYTES) throw new Error("That zip is too big (over 25 MB).");
    const zip = readZip(fs.readFileSync(src));
    const names = zip.names.filter((n) => !n.endsWith("/") && !n.split("/").some((p) => p === ".." || p.startsWith(".git")));
    const skillMd = names.filter((n) => SKILL_FILE.test(n.split("/").pop())).sort((a, b) => a.split("/").length - b.split("/").length)[0];
    if (!skillMd) throw new Error("No SKILL.md in that zip.");
    const prefix = skillMd.slice(0, skillMd.length - skillMd.split("/").pop().length); // folder holding SKILL.md
    const members = names.filter((n) => n.startsWith(prefix));
    if (members.length > MAX_SKILL_FILES) throw new Error("That skill has too many files.");
    const { meta } = parseSkill(zip.read(skillMd) || "");
    dest = installDir(slug(meta.name || prefix.split("/").filter(Boolean).pop() || path.basename(src, ".zip")));
    let bytes = 0;
    try {
      for (const n of members) {
        const data = zip.readBuf(n);
        if (!data) continue;
        bytes += data.length;
        if (bytes > MAX_SKILL_BYTES) throw new Error("That skill is too big once unpacked (over 25 MB).");
        const out = path.resolve(dest, n.slice(prefix.length));
        if (!out.startsWith(path.resolve(dest) + path.sep)) continue; // zip-slip guard
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, data);
      }
    } catch (e) { fs.rmSync(dest, { recursive: true, force: true }); throw e; }
  } else if (/\.md$/i.test(src)) {
    const text = fs.readFileSync(src, "utf8");
    const { meta } = parseSkill(text);
    dest = installDir(slug(meta.name || path.basename(src, path.extname(src))));
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "SKILL.md"), text);
  } else throw new Error("Pick a skill folder, a .zip, or a SKILL.md file.");
  const id = path.basename(dest);
  return listSkills().find((s) => s.id === id);
}

/** Write a new skill from scratch (D.E.N.N.I.S. saving a procedure he was taught). */
export function createSkill({ name, description, instructions }) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const dest = uniqueDir(slug(name));
  const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const yaml = (s) => JSON.stringify(oneLine(s)); // a JSON string is valid YAML
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "SKILL.md"), `---\nname: ${yaml(name)}\ndescription: ${yaml(description)}\n---\n\n${String(instructions || "").trim()}\n`);
  return listSkills().find((s) => s.id === path.basename(dest));
}

/** Remove from the active set. The folder moves to ~/.dennis/skills-removed, so it can be restored. */
export function removeSkill(id) {
  const dir = path.join(SKILLS_DIR, path.basename(String(id || "")));
  if (!fs.existsSync(dir)) return false;
  fs.mkdirSync(REMOVED_DIR, { recursive: true });
  let to = path.join(REMOVED_DIR, path.basename(dir));
  for (let n = 2; fs.existsSync(to); n++) to = path.join(REMOVED_DIR, `${path.basename(dir)}-${n}`);
  fs.renameSync(dir, to);
  return true;
}
