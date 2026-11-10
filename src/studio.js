// StudioBridge: Hive's hands on Roblox Studio. Wraps the official StudioMCP binary and adds
// (a) a playtest lease so humans/agents don't stop each other's runs, (b) cached screenshots so
// N viewers don't hammer Studio, (c) ledger events so everyone sees what happened.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const STUDIO_MCP = process.env.STUDIO_MCP ?? "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
const text = (r) => { try { return JSON.parse(r.content?.find((c) => c.type === "text")?.text ?? "null"); } catch { return r.content?.find((c) => c.type === "text")?.text; } };

export class StudioBridge {
  /** @param hive Hive  @param client optional MCP-like {callTool({name,arguments})} for tests */
  constructor(hive, { client = null, studioId = null, captureTtlMs = 1000 } = {}) {
    this.hive = hive; this._client = client; this.studioId = studioId; this.captureTtlMs = captureTtlMs;
    this._cap = null; this._capAt = 0; this._capInflight = null; this._n = 0;
  }
  async client() {
    if (this._client) return this._client;
    const c = new Client({ name: "hive-studio", version: "0.1.0" });
    await c.connect(new StdioClientTransport({ command: STUDIO_MCP, args: [] }));
    return (this._client = c);
  }
  async _call(name, args = {}) {
    const c = await this.client();
    const r = await c.callTool({ name, arguments: args });
    if (r.isError) throw new Error(text(r) || `${name} failed`);
    return r;
  }
  async _sid() {
    if (this.studioId) return this.studioId;
    const { studios = [] } = text(await this._call("list_roblox_studios")) ?? {};
    if (!studios.length) throw new Error("no_studio_open");
    return (this.studioId = studios[0].id); // single-Studio default; pass studio_id to pin
  }
  async studios() { return text(await this._call("list_roblox_studios")); }

  /** Edit-time viewport. Optional camera pose. Cached briefly + single-flight. Works for any actor, any time. */
  async screenshot({ camera_position, look_at_position, fresh = false } = {}) {
    const posed = camera_position || look_at_position;
    if (!fresh && !posed && this._cap && Date.now() - this._capAt < this.captureTtlMs) return this._cap;
    if (!posed && this._capInflight) return this._capInflight;
    const run = (async () => {
      const args = { studio_id: await this._sid(), capture_id: `Hive_${++this._n}` };
      if (camera_position) args.camera_position = camera_position;
      if (look_at_position) args.look_at_position = look_at_position;
      const r = await this._call("screen_capture", args);
      const img = r.content.find((c) => c.type === "image");
      if (!img) throw new Error("capture returned no image");
      const out = { mimeType: img.mimeType ?? "image/png", data: img.data, ts: Date.now() };
      if (!posed) { this._cap = out; this._capAt = out.ts; }
      return out;
    })();
    if (!posed) this._capInflight = run.finally(() => (this._capInflight = null));
    return run;
  }

  async state() {
    const s = text(await this._call("get_studio_state", { studio_id: await this._sid() }));
    return { studio: s, playtest_lease: this.hive.playtest };
  }
  async playStart(actor, intent) {
    const lease = this.hive.playtestAcquire(actor, intent);
    if (!lease.ok) return lease;
    try { await this._call("start_stop_play", { is_start: true, studio_id: await this._sid() }); }
    catch (e) { this.hive.playtestRelease(actor, { summary: `start failed: ${e.message}` }); return { ok: false, error: e.message }; }
    return lease;
  }
  async playStop(actor, { force = false, summary } = {}) {
    const rel = this.hive.playtestRelease(actor, { force, summary });
    if (!rel.ok) return rel;
    try { await this._call("start_stop_play", { is_start: false, studio_id: await this._sid() }); }
    catch (e) { return { ok: false, error: e.message }; }
    return rel;
  }
  async console() {
    const r = await this._call("get_console_output", { studio_id: await this._sid() });
    return { output: text(r) };
  }
}
