// Minimal text extraction for .docx / .pptx / .xlsx (they are zip files of XML).
// No dependencies: a tiny zip central-directory reader plus zlib. ZIP64 and
// encrypted archives are not supported; callers fall back to "no preview".
import fs from "node:fs";
import zlib from "node:zlib";

export function readZip(buf) {
  // End-of-central-directory record: last 22 bytes + up to 64 KB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    files.set(name, { method, csize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const readBuf = (name) => {
    const f = files.get(name);
    if (!f) return null;
    const ln = buf.readUInt16LE(f.local + 26), le = buf.readUInt16LE(f.local + 28);
    const start = f.local + 30 + ln + le;
    const data = buf.subarray(start, start + f.csize);
    if (f.method === 0) return Buffer.from(data);
    if (f.method === 8) return zlib.inflateRawSync(data);
    return null;
  };
  return {
    names: [...files.keys()],
    readBuf, // raw bytes, for binary members
    read(name) { return readBuf(name)?.toString("utf8") ?? null; },
  };
}

const decode = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");

function docx(zip) {
  const xml = zip.read("word/document.xml") || "";
  return decode(xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n").trim();
}

function pptx(zip) {
  const slides = zip.names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  return slides.map((n, i) => {
    const xml = zip.read(n) || "";
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decode(m[1])).join("")).filter(Boolean);
    return `--- Slide ${i + 1} ---\n${paras.join("\n")}`;
  }).join("\n\n");
}

function xlsx(zip) {
  const shared = [...(zip.read("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => decode([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join("")));
  const sheets = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  return sheets.map((n, i) => {
    const xml = zip.read(n) || "";
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 400).map((r) =>
      [...r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(([, attrs, inner]) => {
        const v = (inner.match(/<v>([^<]*)<\/v>/) || [])[1];
        const t = (inner.match(/<t[^>]*>([^<]*)<\/t>/) || [])[1];
        if (/t="s"/.test(attrs) && v != null) return shared[+v] ?? "";
        return decode(v ?? t ?? "");
      }).join("\t"));
    return `--- Sheet ${i + 1} ---\n${rows.join("\n")}`;
  }).join("\n\n");
}

/** Returns extracted text, or null if this isn't an Office file we can read. */
export function officeText(filePath) {
  const ext = filePath.toLowerCase().split(".").pop();
  if (!["docx", "pptx", "xlsx", "xlsm"].includes(ext)) return null;
  try {
    const zip = readZip(fs.readFileSync(filePath));
    if (ext === "docx") return docx(zip);
    if (ext === "pptx") return pptx(zip);
    return xlsx(zip);
  } catch {
    return null;
  }
}
