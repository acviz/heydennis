// Settings and persistent state live in ~/.dennis (override with DENNIS_HOME).
// Nothing here is inside the app bundle, so reinstalling or updating the app
// never touches who D.E.N.N.I.S. thinks you are or what it remembers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { cleanApps } from "./apps.js";

export const DATA_DIR = process.env.DENNIS_HOME || path.join(os.homedir(), ".dennis");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

export const DEFAULT_MODEL = "claude-opus-5-5";

const DEFAULTS = {
  userName: "",
  address: "", // how D.E.N.N.I.S. addresses you ("sir", "boss", ...); empty = by name
  personality: "", // your own notes on his personality, added to the system prompt
  model: DEFAULT_MODEL, // the Claude model
  provider: "anthropic", // the brain: anthropic | openai | gemini | ollama | custom (see brains.js)
  brains: { openai: { model: "" }, gemini: { model: "" }, ollama: { model: "", baseUrl: "http://127.0.0.1:11434/v1" }, custom: { model: "", baseUrl: "" } },
  effort: "low", // low keeps spoken replies quick; raise for heavier file work
  webSearch: true,
  permissionMode: "ask", // "ask": confirm every change/launch; "auto": just do it
  roots: null, // [{ path, label }]; null = detect on first run
  showHidden: false,
  voice: { speak: true, voiceName: "", rate: 0.96, pitch: 0.85, stt: "whisper", sttModel: "Xenova/whisper-base.en", micId: "", wakeWord: true,
    engine: "kokoro", kokoroVoice: "bm_daniel", elevenVoice: "onwK4e9ZLuTAKqWW03F9", elevenModel: "eleven_flash_v2_5",
    language: "en", // "en" (English-only models) | "auto" (detect among `languages`) | one ISO code
    languages: ["en", "ar", "tl", "fr", "ja", "zh"] },
  hands: { enabled: true, palmToTalk: true, showCamera: true, cameraId: "", mirror: true, stageFlip: false, feel: "normal", camView: "stage" }, // feel: normal | calm; camView: stage | pip | off; stageFlip: full-stage camera picture renders upside down on this machine
  visuals: { bloom: true, autoRotate: true, theme: "reactor" }, // theme: reactor | spiral | neural | grid (ui/js/themes.js)
  // messaging (remote.js): WhatsApp and Teams; their tokens are secrets, stored apart (setSecret)
  remote: {
    whatsapp: { enabled: false, phoneNumberId: "", allow: [], port: 47820, apiVersion: "v23.0", template: "", templateLang: "en", verifyToken: "", publicUrl: "", tunnel: "own", appId: "" },
    teams: { enabled: false, tenant: "organizations", clientId: "", chatId: "", chatName: "", pollSeconds: 6, account: "", inboxFolder: "", inboxPrefix: true },
    forward: { reminders: true, minions: true, watcher: true, approvals: true, awayOnly: true, awayMinutes: 10, via: "whatsapp" },
  },
  apps: [], // apps you've authorized him to open (apps.js): [{ name, run, page, ready, where }]
  skillsDisabled: [], // ids of installed skills (~/.dennis/skills) that are switched off
  mcpServers: {}, // MCP servers, same shape as Claude Desktop's: { name: { command, args, env } | { url, headers } }
  docSkills: { enabled: true, skills: ["docx", "pptx", "xlsx", "pdf"] }, // Anthropic's document skills, in the cloud sandbox
  minions: [ // worker agents D.E.N.N.I.S. can deploy (toolsets: files, write, web, skills, docs, mcp)
    { name: "Scout", role: "A researcher. Digs up facts on the web and in the files, cross-checks them, and reports back with sources.", tools: ["web", "files", "skills"], effort: "medium" },
    { name: "Archivist", role: "An organiser. Surveys folders, spots duplicates, clutter and naming problems, and proposes - or, if asked, carries out - a tidy structure.", tools: ["files", "write"], effort: "medium" },
    { name: "Scribe", role: "A writer. Drafts documents, decks, spreadsheets and notes from the brief and the files it's pointed at, and saves them where it's told.", tools: ["files", "write", "docs", "skills"], effort: "medium" },
  ],
  briefMinions: true, // when a minion finishes, D.E.N.N.I.S. tells you about it straight away
  location: null, // { query, name, lat, lon } for the weather in the daily briefing (set by "Your city")
  briefOnBoot: false, // the daily briefing at the first start of each day
  watch: { enabled: true, minFiles: 5, quiet: { from: "22:00", to: "07:00" }, dnd: false }, // the folder watcher's notices
  port: 47800,
};

function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) && base[k] !== null ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Folders that exist on this machine and make sense as starting roots. */
export function detectRoots(known = {}) {
  const home = os.homedir();
  const candidates = [
    ["Desktop", known.desktop], ["Documents", known.documents], ["Downloads", known.downloads],
    ["Pictures", known.pictures], ["Music", known.music], ["Videos", known.videos],
  ];
  const seen = new Set();
  const out = [];
  const add = (label, p) => {
    if (!p) return;
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    try { if (!fs.statSync(p).isDirectory()) return; } catch { return; }
    seen.add(key);
    out.push({ path: path.resolve(p), label });
  };
  for (const [label, p] of candidates) add(label, p);
  // Fall back to the conventional names (and macOS "Movies", OneDrive redirection).
  for (const [label, names] of [
    ["Desktop", ["Desktop", "OneDrive/Desktop"]],
    ["Documents", ["Documents", "OneDrive/Documents"]],
    ["Downloads", ["Downloads"]],
    ["Pictures", ["Pictures", "OneDrive/Pictures"]],
    ["Music", ["Music"]],
    ["Videos", ["Videos", "Movies"]],
  ]) {
    if (out.some((r) => r.label === label)) continue;
    for (const n of names) {
      const p = path.join(home, n);
      if (fs.existsSync(p)) { add(label, p); break; }
    }
  }
  return out;
}

export class Config {
  constructor({ secrets = null, knownFolders = {} } = {}) {
    this.secrets = secrets; // { canEncrypt(), encrypt(str) -> b64, decrypt(b64) -> str } (Electron safeStorage)
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { /* first run */ }
    this.data = deepMerge(DEFAULTS, raw);
    let dirty = false;
    if (!this.data.token) { this.data.token = crypto.randomBytes(24).toString("hex"); dirty = true; }
    if (!Array.isArray(this.data.roots) || !this.data.roots.length) {
      this.data.roots = detectRoots(knownFolders);
      dirty = true;
    }
    if (dirty) this.save();
  }

  get(key) { return this.data[key]; }

  save() {
    const tmp = CONFIG_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
  }

  /** Apply a partial update from the settings screen. Only known keys are accepted. */
  update(patch = {}) {
    const allowed = ["userName", "address", "personality", "model", "effort", "webSearch", "permissionMode", "roots", "showHidden", "voice", "hands", "visuals",
      "skillsDisabled", "mcpServers", "docSkills", "minions", "briefMinions", "provider", "brains", "location", "briefOnBoot", "watch", "remote", "apps"];
    for (const k of allowed) {
      if (!(k in patch)) continue;
      if (k === "roots") {
        const roots = (Array.isArray(patch.roots) ? patch.roots : [])
          .filter((r) => r && typeof r.path === "string" && r.path.trim())
          .map((r) => ({ path: path.resolve(r.path.trim()), label: String(r.label || path.basename(r.path.trim()) || r.path).slice(0, 40) }));
        this.data.roots = roots;
      } else if (k === "effort") {
        if (["low", "medium", "high", "xhigh", "max"].includes(patch.effort)) this.data.effort = patch.effort;
      } else if (k === "skillsDisabled") {
        this.data.skillsDisabled = (Array.isArray(patch.skillsDisabled) ? patch.skillsDisabled : []).map(String).slice(0, 500);
      } else if (k === "mcpServers") {
        // validated by mcp.js normalizeServers before it gets here; replaced whole so servers can be removed
        if (patch.mcpServers && typeof patch.mcpServers === "object" && !Array.isArray(patch.mcpServers)) this.data.mcpServers = patch.mcpServers;
      } else if (k === "minions") {
        // validated by minions.js cleanDefinition before it gets here
        if (Array.isArray(patch.minions)) this.data.minions = patch.minions.slice(0, 50);
      } else if (k === "location") {
        this.data.location = patch.location && typeof patch.location === "object" ? patch.location : null; // geocoded by the server
      } else if (k === "provider") {
        if (["anthropic", "openai", "gemini", "ollama", "custom"].includes(patch.provider)) this.data.provider = patch.provider;
      } else if (k === "remote") {
        const r = patch.remote && typeof patch.remote === "object" ? structuredClone(patch.remote) : {};
        if (r.whatsapp) {
          if ("allow" in r.whatsapp) r.whatsapp.allow = (Array.isArray(r.whatsapp.allow) ? r.whatsapp.allow : String(r.whatsapp.allow || "").split(/[,;\n]+/)).map((n) => String(n).replace(/\D/g, "")).filter((n) => n.length >= 6).slice(0, 5);
          if ("tunnel" in r.whatsapp && !["own", "cloudflared"].includes(r.whatsapp.tunnel)) r.whatsapp.tunnel = "own";
          if ("appId" in r.whatsapp) r.whatsapp.appId = String(r.whatsapp.appId || "").replace(/\D/g, "");
          if ("port" in r.whatsapp) r.whatsapp.port = Math.min(65535, Math.max(1024, Math.round(+r.whatsapp.port) || 47820));
          if ("phoneNumberId" in r.whatsapp) r.whatsapp.phoneNumberId = String(r.whatsapp.phoneNumberId || "").replace(/\D/g, "");
          if ("publicUrl" in r.whatsapp) { const u = String(r.whatsapp.publicUrl || "").trim().replace(/\/whatsapp\/?$/, "").replace(/\/+$/, ""); r.whatsapp.publicUrl = u && !/^https?:\/\//.test(u) ? `https://${u}` : u; }
        }
        if (r.forward && "via" in r.forward && !["whatsapp", "teams", "both"].includes(r.forward.via)) delete r.forward.via;
        if (r.teams && "inboxFolder" in r.teams) r.teams.inboxFolder = String(r.teams.inboxFolder || "").trim().replace(/^"(.*)"$/, "$1");
        this.data.remote = deepMerge(this.data.remote, r);
      } else if (k === "apps") {
        this.data.apps = cleanApps(patch.apps); // replaced whole, so apps can be removed
      } else if (k === "visuals") {
        const v = patch.visuals && typeof patch.visuals === "object" ? { ...patch.visuals } : {};
        if ("theme" in v && !["reactor", "spiral", "neural", "grid"].includes(v.theme)) delete v.theme;
        this.data.visuals = deepMerge(this.data.visuals, v);
      } else if (k === "briefMinions") {
        this.data.briefMinions = !!patch.briefMinions;
      } else if (k === "permissionMode") {
        if (["ask", "auto"].includes(patch.permissionMode)) this.data.permissionMode = patch.permissionMode;
      } else if (typeof DEFAULTS[k] === "object" && DEFAULTS[k] !== null) {
        this.data[k] = deepMerge(this.data[k], patch[k]);
      } else {
        this.data[k] = patch[k];
      }
    }
    if ("apiKey" in patch) this.setApiKey(patch.apiKey);
    if ("elevenKey" in patch) this.setSecret("elevenKey", patch.elevenKey);
    for (const k of ["openaiKey", "geminiKey", "customKey"]) if (k in patch) this.setSecret(k, patch[k]); // other brains' keys
    for (const k of ["waToken", "waAppSecret", "teamsWebhook"]) if (k in patch) this.setSecret(k, patch[k]); // messaging (remote.js)
    this.save();
  }

  setApiKey(key) { this.setSecret("apiKey", key); }

  /** Secrets are encrypted with the OS keychain in the desktop app (plain text only as a fallback). */
  setSecret(name, value) {
    value = String(value || "").trim();
    if (!value) { delete this.data[name]; return; }
    if (this.secrets?.canEncrypt()) this.data[name] = { scheme: "os", value: this.secrets.encrypt(value) };
    else this.data[name] = { scheme: "plain", value };
  }

  getSecret(name) {
    const k = this.data[name];
    if (k?.scheme === "os" && this.secrets) {
      try { return this.secrets.decrypt(k.value); } catch { return undefined; }
    }
    if (k?.scheme === "plain") return k.value;
    return undefined;
  }

  /** The key the Anthropic client should use, or undefined to let the SDK resolve env / `ant auth` credentials. */
  apiKey() {
    const k = this.data.apiKey;
    if (k?.scheme === "os" && this.secrets) {
      try { return this.secrets.decrypt(k.value); } catch { return undefined; }
    }
    if (k?.scheme === "plain") return k.value;
    return undefined;
  }

  hasCredentials() {
    return !!(this.apiKey() || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }

  /** What the UI is allowed to see: everything except secrets. */
  publicView() {
    const { token, apiKey, elevenKey, openaiKey, geminiKey, customKey, waToken, waAppSecret, teamsWebhook, teamsRefresh, ...rest } = this.data;
    return { ...rest, hasApiKey: this.hasCredentials(), hasElevenKey: !!this.getSecret("elevenKey"),
      brainKeys: { openai: !!this.getSecret("openaiKey"), gemini: !!this.getSecret("geminiKey"), custom: !!this.getSecret("customKey") }, keyStorage: apiKey?.scheme || (process.env.ANTHROPIC_API_KEY ? "env" : null), dataDir: DATA_DIR };
  }
}
