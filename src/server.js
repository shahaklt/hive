// Hive server: mirrors a Rojo project dir into CRDT docs, syncs editors over WebSocket,
// exposes a small HTTP API (used by the MCP bridge). Rojo keeps doing Studio <-> disk.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { Hive } from "./core.js";
import { StudioBridge } from "./studio.js";

const SRC_EXT = /\.(luau?|json5?)$/; // .lua/.luau (+ project/meta json)
const IGNORE = /(^|\/)(node_modules|\.git|Packages|\.hive)(\/|$)/;

export function startServer({ root, port = 7777, studioClient = null } = {}) {
  root = path.resolve(root);
  const hive = new Hive();
  const studio = new StudioBridge(hive, { client: studioClient });
  const viewer = fs.readFileSync(new URL("./viewer.html", import.meta.url), "utf8");
  const echo = new Map(); // rel -> content we just wrote, to suppress watcher loops

  const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");
  const load = (relp) => {
    try { hive.setFromDisk(relp, fs.readFileSync(path.join(root, relp), "utf8")); } catch {}
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name), r = rel(abs);
      if (IGNORE.test(r)) continue;
      if (e.isDirectory()) walk(abs);
      else if (SRC_EXT.test(e.name)) load(r);
    }
  };
  walk(root);

  // doc -> disk (debounced); Rojo sees the file change and pushes to Studio
  const timers = new Map();
  hive.on("doc-update", ({ path: p, origin }) => {
    if (origin === "disk") return;
    clearTimeout(timers.get(p));
    timers.set(p, setTimeout(() => {
      const content = hive.read(p), abs = path.join(root, p);
      echo.set(p, content);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }, 150));
  });
  // disk -> doc (Studio edits arriving via Rojo, or a human using any other editor)
  const watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
    if (!name) return;
    const r = name.split(path.sep).join("/");
    if (IGNORE.test(r) || !SRC_EXT.test(r)) return;
    let content;
    try { content = fs.readFileSync(path.join(root, r), "utf8"); } catch { return; }
    if (echo.get(r) === content) return echo.delete(r);
    if (hive.setFromDisk(r, content)) hive.log("disk", "external-edit", r, "changed on disk (Studio/Rojo/other editor)");
  });

  // ---- HTTP API ----
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    let body = {};
    if (req.method === "POST") { let s = ""; for await (const c of req) s += c; try { body = JSON.parse(s || "{}"); } catch {} }
    const q = u.searchParams, actor = body.actor ?? q.get("actor") ?? "anon";
    const guard = (fn) => fn().then((r) => json(res, 200, r), (e) => json(res, 502, { error: String(e.message ?? e) }));
    switch (u.pathname) {
      case "/": res.writeHead(200, { "content-type": "text/html" }); return res.end(viewer);
      case "/studio/screenshot": try {
        const cam = q.get("camera"), look = q.get("look");
        const img = await studio.screenshot({ fresh: q.has("fresh"), camera_position: cam?.split(",").map(Number), look_at_position: look?.split(",").map(Number) });
        res.writeHead(200, { "content-type": img.mimeType, "cache-control": "no-store" }); return res.end(Buffer.from(img.data, "base64"));
      } catch (e) { return json(res, 502, { error: String(e.message ?? e) }); }
      case "/studio/state": return guard(() => studio.state());
      case "/studio/studios": return guard(() => studio.studios());
      case "/studio/console": return guard(() => studio.console());
      case "/studio/play": return guard(() => studio.playStart(actor, body.intent));
      case "/studio/stop": return guard(() => studio.playStop(actor, { force: body.force, summary: body.summary }));
      case "/context": return json(res, 200, { ...hive.context({ sinceSeq: +q.get("since") || 0, path: q.get("path"), limit: +q.get("limit") || 50 }), playtest: hive.playtest });
      case "/files": return json(res, 200, hive.list());
      case "/read": { const c = hive.read(q.get("path")); return c == null ? json(res, 404, { error: "no_such_file" }) : json(res, 200, { content: c, version: hive.version(q.get("path")) }); }
      case "/edit": return json(res, 200, hive.edit(body.path, actor, { oldString: body.old_string, newString: body.new_string, replaceAll: body.replace_all }));
      case "/claim": return json(res, 200, hive.claim(body.path, actor, body.intent ?? "", { ttlMs: body.ttl_s ? body.ttl_s * 1000 : undefined, mode: body.mode }));
      case "/release": return json(res, 200, hive.release(actor, { path: body.path, id: body.id, summary: body.summary }));
      case "/note": return json(res, 200, hive.note(actor, body.text, { path: body.path, kind: body.kind }));
      default: return json(res, 404, { error: "not_found" });
    }
  });

  // ---- WebSocket: Yjs sync for editors. msg = {t, path, u(base64)} ----
  const wss = new WebSocketServer({ server });
  const subs = new Map(); // ws -> Set<path>
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  wss.on("connection", (ws, req) => {
    const actor = new URL(req.url, "http://x").searchParams.get("actor") ?? "human";
    subs.set(ws, new Set());
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.t === "open") {
        subs.get(ws).add(m.path);
        ws.send(JSON.stringify({ t: "sync", path: m.path, u: b64(Y.encodeStateAsUpdate(hive.doc(m.path))) }));
      } else if (m.t === "update") {
        const blocker = hive._foreignClaim(m.path, actor);
        if (blocker) return ws.send(JSON.stringify({ t: "rejected", path: m.path, claim: blocker.intent, by: blocker.actor }));
        Y.applyUpdate(hive.doc(m.path), Buffer.from(m.u, "base64"), ws);
      } else if (m.t === "presence") hive.setPresence(actor, { kind: "human", path: m.path, cursor: m.cursor });
    });
    ws.on("close", () => { subs.delete(ws); hive.presence.delete(actor); });
  });
  hive.on("doc-update", ({ path: p, update, origin }) => {
    for (const [ws, set] of subs) if (ws !== origin && set.has(p)) ws.send(JSON.stringify({ t: "update", path: p, u: b64(update) }));
  });
  hive.on("event", (e) => { for (const ws of subs.keys()) ws.send(JSON.stringify({ t: "event", e })); });

  return new Promise((r) => server.listen(port, () => r({ hive, studio, server, port, close: () => { watcher.close(); studio._client?.close?.(); timers.forEach(clearTimeout); for (const ws of subs.keys()) ws.terminate(); wss.close(); server.close(); } })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] ?? process.cwd();
  const { port } = await startServer({ root, port: +process.env.PORT || 7777 });
  console.log(`hive: ${root} on :${port}  (run \`rojo serve\` in the same dir for Studio sync)`);
}
