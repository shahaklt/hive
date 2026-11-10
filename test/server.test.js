import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";

test("end to end: disk, agent HTTP edit, ws human, claim rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/A.server.luau"), "print('a')\n");
  const s = await startServer({ root, port: 0 });
  const base = `http://localhost:${s.server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());

  assert.equal((await (await fetch(base + "/read?path=src/A.server.luau")).json()).content, "print('a')\n");
  assert.ok((await post("/claim", { actor: "agentA", path: "src", intent: "rewrite" })).ok);
  assert.equal((await post("/edit", { actor: "agentB", path: "src/A.server.luau", old_string: "a", new_string: "b" })).error, "claimed");
  assert.ok((await post("/edit", { actor: "agentA", path: "src/A.server.luau", old_string: "'a'", new_string: "'z'" })).ok);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.readFileSync(path.join(root, "src/A.server.luau"), "utf8"), "print('z')\n"); // Rojo would see this

  const ws = new WebSocket(`ws://localhost:${s.server.address().port}/?actor=human1`);
  await new Promise((r) => ws.on("open", r));
  const got = new Promise((r) => ws.on("message", (m) => { const j = JSON.parse(m); if (j.t === "rejected") r(j); }));
  ws.send(JSON.stringify({ t: "open", path: "src/A.server.luau" }));
  ws.send(JSON.stringify({ t: "update", path: "src/A.server.luau", u: "AAA=" }));
  assert.equal((await got).by, "agentA");
  ws.close(); s.close();
});

test("studio endpoints: screenshot bytes, lease conflict, viewer page", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hive-"));
  const client = { async callTool({ name }) {
    if (name === "list_roblox_studios") return { content: [{ type: "text", text: '{"studios":[{"id":"s1"}]}' }] };
    if (name === "screen_capture") return { content: [{ type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" }] };
    return { content: [{ type: "text", text: "{}" }] };
  } };
  const s = await startServer({ root, port: 0, studioClient: client });
  const base = `http://localhost:${s.server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
  const img = await fetch(base + "/studio/screenshot");
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await img.arrayBuffer()).toString(), "PNGDATA");
  assert.ok((await post("/studio/play", { actor: "human", intent: "spawn" })).ok);
  assert.equal((await post("/studio/play", { actor: "claude" })).error, "playtest_in_use");
  assert.equal((await (await fetch(base + "/context")).json()).playtest.owner, "human");
  assert.match(await (await fetch(base + "/")).text(), /Hive/);
  s.close();
});
