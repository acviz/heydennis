// D.E.N.N.I.S.'s long-term memory: one plain markdown file you can open and edit
// yourself (~/.dennis/memory.md). It is read into the system prompt when a new
// conversation starts; the `remember` tool appends to it.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export const MEMORY_PATH = path.join(DATA_DIR, "memory.md");
const MAX_CHARS = 20_000;

const HEADER = `# What D.E.N.N.I.S. remembers

Plain notes, one per line. Edit or delete anything; D.E.N.N.I.S. rereads this file at the start of every conversation.

`;

export function readMemory() {
  try {
    const text = fs.readFileSync(MEMORY_PATH, "utf8");
    return text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text;
  } catch {
    return "";
  }
}

export function remember(fact) {
  const line = String(fact || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!line) return false;
  if (!fs.existsSync(MEMORY_PATH)) fs.writeFileSync(MEMORY_PATH, HEADER);
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(MEMORY_PATH, `- ${line} _(${date})_\n`);
  return true;
}
