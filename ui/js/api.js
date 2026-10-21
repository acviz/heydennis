// Thin client for the local server. The session cookie rides along
// automatically; state-changing calls add the X-Dennis header the server requires.
export class LockedError extends Error {}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Dennis": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new LockedError("locked");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const qs = (o) => new URLSearchParams(o).toString();

export const api = {
  state: () => req("GET", "/api/state"),
  list: (path = "") => req("GET", "/api/list?" + qs({ path })),
  info: (paths) => req("GET", "/api/info?" + qs({ paths: paths.join("\n") })),
  text: (path, max = 60000) => req("GET", "/api/text?" + qs({ path, max })),
  activity: (path = "") => req("GET", "/api/activity?" + qs({ path })),
  search: (q, kind) => req("GET", "/api/search?" + qs(kind ? { q, kind } : { q })),
  raw: (path) => "/api/raw?" + qs({ path }),
  settings: (patch) => req("POST", "/api/settings", patch),
  approve: (id, yes) => req("POST", "/api/approve", { id, yes }),
  stop: () => req("POST", "/api/stop", {}),
  newChat: () => req("POST", "/api/new", {}),
  reindex: () => req("POST", "/api/reindex", {}),
  open: (path) => req("POST", "/api/open", { path }),
  reveal: (path) => req("POST", "/api/reveal", { path }),
  pickFolder: () => req("POST", "/api/pick-folder", {}),
  diag: (entry) => req("POST", "/api/diag", entry),
  // capabilities: skills, MCP connections, minions
  skills: () => req("GET", "/api/skills"),
  skillsDo: (body) => req("POST", "/api/skills", body),
  mcp: () => req("GET", "/api/mcp"),
  mcpDo: (body) => req("POST", "/api/mcp", body),
  minions: () => req("GET", "/api/minions"),
  minionsDo: (body) => req("POST", "/api/minions", body),
  undo: (count = 1) => req("POST", "/api/undo", { count }),
  notes: (title, text) => req("POST", "/api/notes", { title, text }),
  uiReply: (id, result) => req("POST", "/api/ui-reply", { id, result }),
  remote: () => req("GET", "/api/remote"),
  remoteDo: (body) => req("POST", "/api/remote", body),
  presence: () => req("POST", "/api/presence", {}),
  saveDiagram: (title, svg, png) => req("POST", "/api/diagram-save", { title, svg, png }),

  /** Server-sent events for background status (index progress). */
  events(onEvent) {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ } };
    return es;
  },

  /** POST a chat turn and stream its events. Returns { done: Promise, abort() }. */
  chat(body, onEvent) {
    const ctrl = new AbortController();
    const done = (async () => {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dennis": "1" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 401) throw new LockedError("locked");
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* partial */ } }
          }
        }
      }
    })();
    return { done, abort: () => ctrl.abort() };
  },
};
