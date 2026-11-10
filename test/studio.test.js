import test from "node:test";
import assert from "node:assert/strict";
import { Hive } from "../src/core.js";
import { StudioBridge } from "../src/studio.js";

const fake = () => {
  const calls = [];
  return { calls, async callTool({ name, arguments: a }) {
    calls.push(name);
    if (name === "list_roblox_studios") return { content: [{ type: "text", text: JSON.stringify({ studios: [{ id: "s1", name: "Place" }] }) }] };
    if (name === "screen_capture") return { content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] };
    return { content: [{ type: "text", text: "{}" }] };
  } };
};

test("playtest lease: only owner stops; force overrides; logged", async () => {
  const h = new Hive(), f = fake(), b = new StudioBridge(h, { client: f });
  assert.ok((await b.playStart("human", "check spawn")).ok);
  assert.equal((await b.playStart("agentA", "mine")).error, "playtest_in_use");
  assert.equal((await b.playStop("agentA")).error, "not_owner");
  assert.ok((await b.playStop("agentA", { force: true })).ok);
  assert.deepEqual(h.ledger.filter((e) => e.kind.startsWith("playtest")).map((e) => e.kind), ["playtest-start", "playtest-stop"]);
  assert.equal(f.calls.filter((c) => c === "start_stop_play").length, 2);
});

test("screenshot caches + single-flights; posed capture bypasses cache", async () => {
  const f = fake(), b = new StudioBridge(new Hive(), { client: f });
  const [a, c] = await Promise.all([b.screenshot(), b.screenshot()]);
  assert.equal(a.data, "QUJD"); assert.equal(c, a);
  await b.screenshot();
  assert.equal(f.calls.filter((x) => x === "screen_capture").length, 1);
  await b.screenshot({ camera_position: [0, 10, 0], look_at_position: [0, 0, 0] });
  assert.equal(f.calls.filter((x) => x === "screen_capture").length, 2);
});

test("failed start releases lease", async () => {
  const h = new Hive();
  const b = new StudioBridge(h, { client: { async callTool({ name }) { if (name === "start_stop_play") return { isError: true, content: [{ type: "text", text: "boom" }] }; return { content: [{ type: "text", text: JSON.stringify({ studios: [{ id: "s" }] }) }] }; } } });
  assert.equal((await b.playStart("a")).ok, false);
  assert.equal(h.playtest, null);
});
