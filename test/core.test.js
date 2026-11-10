import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { Hive } from "../src/core.js";

test("agents edit via str-replace and don't clobber each other", () => {
  const h = new Hive();
  h.setFromDisk("ServerScriptService/Gun.server.lua", "local a = 1\nlocal b = 2\nlocal c = 3\n");
  assert.ok(h.edit("ServerScriptService/Gun.server.lua", "agentA", { oldString: "a = 1", newString: "a = 10" }).ok);
  assert.ok(h.edit("ServerScriptService/Gun.server.lua", "agentB", { oldString: "c = 3", newString: "c = 30" }).ok);
  assert.equal(h.read("ServerScriptService/Gun.server.lua"), "local a = 10\nlocal b = 2\nlocal c = 30\n");
});

test("stale edit fails instead of overwriting", () => {
  const h = new Hive();
  h.setFromDisk("x.lua", "print(1)");
  h.edit("x.lua", "human", { oldString: "print(1)", newString: "print(2)" });
  const r = h.edit("x.lua", "agent", { oldString: "print(1)", newString: "print(3)" });
  assert.equal(r.error, "old_string_not_found");
  assert.equal(h.read("x.lua"), "print(2)");
});

test("exclusive claim blocks other actors on overlapping paths", () => {
  const h = new Hive();
  h.setFromDisk("Shared/Combat/Hit.lua", "x");
  assert.ok(h.claim("Shared/Combat", "agentA", "refactor damage").ok);
  const c = h.claim("Shared/Combat/Hit.lua", "agentB", "tweak hit");
  assert.equal(c.error, "conflict");
  assert.equal(c.held_by[0].intent, "refactor damage");
  assert.equal(h.edit("Shared/Combat/Hit.lua", "agentB", { oldString: "x", newString: "y" }).error, "claimed");
  assert.ok(h.edit("Shared/Combat/Hit.lua", "agentA", { oldString: "x", newString: "y" }).ok);
  h.release("agentA", { path: "Shared/Combat" });
  assert.ok(h.edit("Shared/Combat/Hit.lua", "agentB", { oldString: "y", newString: "z" }).ok);
});

test("claims expire", () => {
  let t = 0;
  const h = new Hive({ now: () => t });
  h.claim("a", "A", "work", { ttlMs: 1000 });
  t = 2000;
  assert.ok(h.claim("a", "B", "mine now").ok);
});

test("sibling paths don't conflict", () => {
  const h = new Hive();
  h.claim("Shared/Combat", "A", "x");
  assert.ok(h.claim("Shared/CombatUI", "B", "y").ok);
});

test("disk sync merges with concurrent CRDT edits", () => {
  const h = new Hive();
  h.setFromDisk("m.lua", "line1\nline2\n");
  h.edit("m.lua", "agent", { oldString: "line2", newString: "line2 edited" });
  h.setFromDisk("m.lua", "line1 studio\nline2 edited\n"); // Studio changed line1
  assert.equal(h.read("m.lua"), "line1 studio\nline2 edited\n");
});

test("remote Y updates converge", () => {
  const h = new Hive();
  h.setFromDisk("r.lua", "hello");
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.doc("r.lua")));
  peer.getText("src").insert(5, " world");
  Y.applyUpdate(h.doc("r.lua"), Y.encodeStateAsUpdate(peer));
  assert.equal(h.read("r.lua"), "hello world");
});

test("context shows claims, decisions, recent events", () => {
  const h = new Hive();
  h.claim("a", "A", "doing a");
  h.note("A", "use RemoteFunction not Event", { kind: "decision" });
  const c = h.context();
  assert.equal(c.active_claims.length, 1);
  assert.equal(c.decisions[0].summary, "use RemoteFunction not Event");
});
