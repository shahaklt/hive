// MCP bridge: every agent (Claude Code, Codex, ...) gets the same shared-context tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HIVE = process.env.HIVE_URL ?? "http://localhost:7777";
const ACTOR = process.env.HIVE_ACTOR ?? `agent-${process.pid}`;
const call = async (p, body) => {
  const r = await fetch(HIVE + p, body ? { method: "POST", body: JSON.stringify({ actor: ACTOR, ...body }) } : undefined);
  return r.json();
};
const out = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });

const s = new McpServer({ name: "hive", version: "0.1.0" });
s.tool("hive_context", "READ FIRST. Active claims, decisions, recent changes by every human/agent, file list. Call before starting and after any conflict.", { since: z.number().optional(), path: z.string().optional() },
  async ({ since, path }) => out(await call(`/context?since=${since ?? 0}${path ? `&path=${encodeURIComponent(path)}` : ""}`)));
s.tool("hive_read", "Read the live (merged) content of a script.", { path: z.string() },
  async ({ path }) => out(await call(`/read?path=${encodeURIComponent(path)}`)));
s.tool("hive_claim", "Declare intent on a path/subtree before editing. Exclusive claims block others; refused if someone holds an overlapping one (response names them + their intent).", { path: z.string(), intent: z.string(), ttl_s: z.number().optional(), mode: z.enum(["exclusive", "soft"]).optional() },
  async (a) => out(await call("/claim", a)));
s.tool("hive_edit", "Edit a script by exact str-replace against the live doc (merges with concurrent human/agent edits). Fails if old_string is missing/ambiguous or path is claimed by someone else. Empty old_string creates a new empty file.", { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
  async (a) => out(await call("/edit", a)));
s.tool("hive_release", "Release your claim(s) and say what you did so others get context.", { path: z.string().optional(), summary: z.string().optional() },
  async (a) => out(await call("/release", a)));
s.tool("hive_note", "Post a note or decision (kind=decision) every other agent will see in context. Use for API shapes, remote names, conventions.", { text: z.string(), path: z.string().optional(), kind: z.enum(["note", "decision", "question"]).optional() },
  async (a) => out(await call("/note", a)));
// ---- Studio: see the game + run playtests (shared lease: only the owner may stop) ----
s.tool("hive_screenshot", "See the game: edit-time Studio viewport as an image. Optional camera pose to look at something specific. Safe anytime; cached ~1s.", { camera_position: z.array(z.number()).length(3).optional(), look_at_position: z.array(z.number()).length(3).optional(), fresh: z.boolean().optional() },
  async ({ camera_position, look_at_position, fresh }) => {
    const qs = new URLSearchParams();
    if (camera_position) qs.set("camera", camera_position.join(","));
    if (look_at_position) qs.set("look", look_at_position.join(","));
    if (fresh) qs.set("fresh", "1");
    const r = await fetch(`${HIVE}/studio/screenshot?${qs}`);
    if (!r.ok) return out(await r.json());
    return { content: [{ type: "image", data: Buffer.from(await r.arrayBuffer()).toString("base64"), mimeType: r.headers.get("content-type") }] };
  });
s.tool("hive_playtest_start", "Start a playtest in Studio. Refused if someone else is already playtesting (response says who/why). You then own it until you stop it.", { intent: z.string().describe("what you are testing") },
  async (a) => out(await call("/studio/play", a)));
s.tool("hive_playtest_stop", "Stop the playtest you own. Stopping someone else's needs force=true; only do that if it is stale.", { force: z.boolean().optional(), summary: z.string().optional().describe("what you found") },
  async (a) => out(await call("/studio/stop", a)));
s.tool("hive_playtest_status", "Who is playtesting, Studio state.", {}, async () => out(await call("/studio/state")));
s.tool("hive_console", "Studio output log (errors/prints from the playtest). Read after a playtest to verify behavior.", {}, async () => out(await call("/studio/console")));
await s.connect(new StdioServerTransport());
