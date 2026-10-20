// File "kinds": the coarse categories the galaxy colours by and the agent filters by.
import path from "node:path";

const EXT = {
  image: "png jpg jpeg gif webp bmp tif tiff heic heif svg ico avif raw cr2 nef arw dng",
  video: "mp4 mov m4v avi mkv webm wmv flv mpg mpeg mxf r3d braw",
  audio: "mp3 wav flac aac m4a ogg opus aiff aif wma mid midi",
  document: "pdf doc docx txt md markdown rtf odt pages tex epub log",
  sheet: "xls xlsx xlsm csv tsv ods numbers",
  slides: "ppt pptx key odp",
  code: "js mjs cjs ts tsx jsx py rb go rs java kt c cc cpp h hpp cs php swift sh bash zsh ps1 bat cmd lua r sql html htm css scss vue svelte ipynb",
  data: "json xml yaml yml toml ini cfg conf env plist db sqlite parquet",
  archive: "zip rar 7z tar gz tgz bz2 xz iso dmg",
  design: "psd ai indd fig sketch xd afdesign afphoto aep prproj drp blend c4d max ma mb hip nk",
  model3d: "glb gltf fbx obj stl usd usdz 3ds dae ply abc",
  font: "ttf otf woff woff2",
  app: "exe msi app pkg deb rpm apk appimage lnk command",
};

const BY_EXT = new Map();
for (const [kind, list] of Object.entries(EXT)) for (const e of list.split(" ")) BY_EXT.set(e, kind);

export const KINDS = ["folder", ...Object.keys(EXT), "other"];

export function kindOf(name, isDir = false) {
  if (isDir) return "folder";
  const ext = path.extname(name).slice(1).toLowerCase();
  return BY_EXT.get(ext) || "other";
}

// Extensions the agent must never launch, whatever it is asked: opening one of
// these runs code rather than showing a document.
const EXECUTABLE = new Set(
  "exe msi bat cmd com scr ps1 psm1 vbs vbe js jse wsf wsh hta cpl msc jar sh bash zsh command app pkg reg lnk url scf inf dll sys appimage deb rpm apk py rb pl".split(" "),
);
export function isExecutable(name) {
  return EXECUTABLE.has(path.extname(name).slice(1).toLowerCase());
}

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", opus: "audio/ogg",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  json: "application/json", html: "text/plain; charset=utf-8", htm: "text/plain; charset=utf-8",
  css: "text/plain; charset=utf-8", js: "text/plain; charset=utf-8", csv: "text/plain; charset=utf-8",
  glb: "model/gltf-binary",
};
export function mimeOf(name) {
  return MIME[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream";
}

// Image types the Claude API accepts as image blocks.
export const CLAUDE_IMAGE_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

const TEXTISH = new Set(
  "txt md markdown log csv tsv json xml yaml yml toml ini cfg conf env rtf tex html htm css scss js mjs cjs ts tsx jsx py rb go rs java kt c cc cpp h hpp cs php swift sh bash zsh ps1 bat cmd lua r sql vue svelte srt vtt plist gitignore".split(" "),
);
export function isTextLike(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return TEXTISH.has(ext) || ext === "";
}
