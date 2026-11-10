// Hive core: shared project state for humans + agents.
// - Every script is a Y.Text (CRDT), so concurrent edits merge instead of overwrite.
// - Agents edit via str-replace ops applied to the *live* doc, never whole-file writes.
// - Claims declare intent on a path/subtree; conflicting claims are refused with the holder's intent.
// - Ledger is an append-only shared context log every actor can read.
import * as Y from "yjs";
import { EventEmitter } from "node:events";

const norm = (p) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
// a overlaps b if equal or one is an ancestor of the other
const overlaps = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

export class Hive extends EventEmitter {
  constructor({ now = () => Date.now(), defaultTtlMs = 10 * 60_000 } = {}) {
    super();
    this.now = now;
    this.defaultTtlMs = defaultTtlMs;
    this.docs = new Map(); // path -> Y.Doc
    this.claims = new Map(); // id -> claim
    this.ledger = [];
    this.presence = new Map(); // actor -> {path, cursor, kind, ts}
    this._claimSeq = 0;
    this.playtest = null; // {owner, intent, since} — one playtest at a time per Studio
  }

  // ---------- playtest lease ----------
  /** Only one actor may own the running playtest. Others can watch (screenshots/console) but not stop it. */
  playtestAcquire(actor, intent = "") {
    if (this.playtest && this.playtest.owner !== actor)
      return { ok: false, error: "playtest_in_use", held_by: { ...this.playtest } };
    const fresh = !this.playtest;
    this.playtest = { owner: actor, intent, since: this.now() };
    if (fresh) this.log(actor, "playtest-start", null, intent || "playtest started");
    return { ok: true, playtest: { ...this.playtest } };
  }
  playtestRelease(actor, { force = false, summary = "" } = {}) {
    if (!this.playtest) return { ok: true, was_running: false };
    if (this.playtest.owner !== actor && !force)
      return { ok: false, error: "not_owner", held_by: { ...this.playtest }, hint: "ask owner, or pass force=true" };
    const o = this.playtest.owner;
    this.playtest = null;
    this.log(actor, "playtest-stop", null, summary || (o === actor ? "playtest stopped" : `force-stopped ${o}'s playtest`));
    return { ok: true, was_running: true };
  }

  // ---------- docs ----------
  doc(path) {
    path = norm(path);
    let d = this.docs.get(path);
    if (!d) {
      d = new Y.Doc();
      d.getText("src");
      d.on("update", (update, origin) => this.emit("doc-update", { path, update, origin }));
      this.docs.set(path, d);
    }
    return d;
  }
  read(path) {
    const d = this.docs.get(norm(path));
    return d ? d.getText("src").toString() : null;
  }
  version(path) {
    const s = this.read(path);
    if (s == null) return null;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
  list() {
    return [...this.docs.keys()].sort();
  }

  /** Replace whole content using common prefix/suffix diff, so it merges as a minimal CRDT edit
   *  (used for disk->doc sync from Rojo/Studio, not for agents). */
  setFromDisk(path, content, origin = "disk") {
    const t = this.doc(path).getText("src");
    const cur = t.toString();
    if (cur === content) return false;
    let s = 0;
    while (s < cur.length && s < content.length && cur[s] === content[s]) s++;
    let e = 0;
    while (e < cur.length - s && e < content.length - s && cur[cur.length - 1 - e] === content[content.length - 1 - e]) e++;
    t.doc.transact(() => {
      if (cur.length - s - e > 0) t.delete(s, cur.length - s - e);
      const ins = content.slice(s, content.length - e);
      if (ins) t.insert(s, ins);
    }, origin);
    return true;
  }

  /** Agent/human structured edit. Applies to the live doc. Fails loudly instead of clobbering. */
  edit(path, actor, { oldString, newString, replaceAll = false }) {
    path = norm(path);
    const blocker = this._foreignClaim(path, actor);
    if (blocker) return { ok: false, error: "claimed", claim: pub(blocker) };
    const t = this.doc(path).getText("src");
    const cur = t.toString();
    if (oldString === "" ) {
      if (cur !== "") return { ok: false, error: "file_not_empty", hint: "use a non-empty old_string" };
      t.doc.transact(() => t.insert(0, newString), actor);
      return this._wrote(path, actor, "create", cur.length);
    }
    const first = cur.indexOf(oldString);
    if (first < 0) return { ok: false, error: "old_string_not_found", current_version: this.version(path), hint: "doc changed under you; re-read" };
    if (!replaceAll && cur.indexOf(oldString, first + 1) >= 0) return { ok: false, error: "old_string_ambiguous" };
    t.doc.transact(() => {
      let idx = first;
      // apply from the end so earlier indexes stay valid when replaceAll
      const hits = [];
      while (idx >= 0) {
        hits.push(idx);
        if (!replaceAll) break;
        idx = cur.indexOf(oldString, idx + oldString.length);
      }
      for (const h of hits.reverse()) {
        t.delete(h, oldString.length);
        if (newString) t.insert(h, newString);
      }
    }, actor);
    return this._wrote(path, actor, "edit", oldString.length);
  }
  _wrote(path, actor, kind, n) {
    this.log(actor, kind, path, `${kind} ${path}`);
    return { ok: true, version: this.version(path) };
  }

  // ---------- claims ----------
  _expire() {
    const t = this.now();
    for (const [id, c] of this.claims) if (c.expires <= t) { this.claims.delete(id); this.log(c.actor, "claim-expired", c.path, c.intent); }
  }
  _foreignClaim(path, actor) {
    this._expire();
    for (const c of this.claims.values()) if (c.actor !== actor && c.mode === "exclusive" && overlaps(c.path, path)) return c;
    return null;
  }
  /** mode "exclusive": nobody else may edit the subtree. "soft": announce only, others are warned. */
  claim(path, actor, intent, { ttlMs = this.defaultTtlMs, mode = "exclusive" } = {}) {
    path = norm(path);
    this._expire();
    const conflicts = [...this.claims.values()].filter((c) => c.actor !== actor && overlaps(c.path, path));
    const hard = conflicts.filter((c) => c.mode === "exclusive");
    if (hard.length && mode === "exclusive") return { ok: false, error: "conflict", held_by: hard.map(pub) };
    const mine = [...this.claims.values()].find((c) => c.actor === actor && c.path === path);
    const c = mine ?? { id: `c${++this._claimSeq}`, actor, path };
    Object.assign(c, { intent, mode, expires: this.now() + ttlMs });
    this.claims.set(c.id, c);
    this.log(actor, "claim", path, intent);
    return { ok: true, claim: pub(c), also_working_here: conflicts.map(pub) };
  }
  release(actor, { path, id, summary = "" } = {}) {
    let n = 0;
    for (const [cid, c] of this.claims)
      if (c.actor === actor && (id ? cid === id : path ? c.path === norm(path) : true)) { this.claims.delete(cid); n++; this.log(actor, "release", c.path, summary || c.intent); }
    return { ok: true, released: n };
  }
  activeClaims() {
    this._expire();
    return [...this.claims.values()].map(pub);
  }

  // ---------- shared context ----------
  log(actor, kind, path, summary) {
    const e = { seq: this.ledger.length + 1, ts: this.now(), actor, kind, path: path ? norm(path) : null, summary };
    this.ledger.push(e);
    this.emit("event", e);
    return e;
  }
  note(actor, text, { path = null, kind = "note" } = {}) {
    return this.log(actor, kind, path, text);
  }
  /** What a freshly-joined agent must read before touching anything. */
  context({ sinceSeq = 0, path = null, limit = 50 } = {}) {
    let ev = this.ledger.filter((e) => e.seq > sinceSeq);
    if (path) { const p = norm(path); ev = ev.filter((e) => !e.path || overlaps(e.path, p)); }
    return {
      head_seq: this.ledger.length,
      active_claims: this.activeClaims(),
      decisions: this.ledger.filter((e) => e.kind === "decision").slice(-20),
      recent: ev.slice(-limit),
      presence: [...this.presence].map(([actor, v]) => ({ actor, ...v })),
      files: this.list(),
    };
  }
  setPresence(actor, v) {
    this.presence.set(actor, { ...v, ts: this.now() });
    this.emit("presence", { actor, ...v });
  }
}

const pub = (c) => ({ id: c.id, actor: c.actor, path: c.path, intent: c.intent, mode: c.mode, expires_in_s: Math.max(0, Math.round((c.expires - Date.now()) / 1000)) });
