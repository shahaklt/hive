<h1 align="center">🐝 Hive</h1>
<p align="center"><b>Multiplayer for Roblox. Humans and AI agents, one live project, nobody overwrites anybody.</b></p>
<p align="center">Google-Docs-style collaboration on top of <a href="https://github.com/rojo-rbx/rojo">Rojo</a>, with a shared brain for every agent working on the game.</p>

---

## The problem

Point three AI agents and two teammates at one Roblox game and you get chaos: one agent rewrites a file another is halfway through, nobody knows which remote name was agreed, and somebody stops a playtest that someone else was running.

Hive fixes this with a coordination layer that sits between your editors/agents and Rojo. Everyone, human or agent, reads and writes the same live project and sees the same context.

```
 Editors (humans) ──ws / CRDT──┐
 Agents (Claude, Codex…) ─MCP──┼──►  HIVE  ──files──►  Rojo (unchanged)  ──►  Roblox Studio
 Studio edits ◄────────────────┘   live docs · claims · ledger · playtest lease
                                        ▲
                                        └── StudioMCP: screenshots, play/stop, console
```

## What makes it safe

| Mechanism | What it does |
|---|---|
| **CRDT documents** | Every script is a Yjs `Y.Text`. Concurrent edits merge instead of overwriting. |
| **Edit ops, not file writes** | Agents change code with exact find-and-replace against the *live* doc. A stale or ambiguous edit fails with an error rather than clobbering a teammate. |
| **Claims** | An agent declares *intent* on a file or folder. Overlapping exclusive claims are refused, naming the holder and why. Claims auto-expire. |
| **Shared ledger** | One append-only log of claims, edits, decisions and playtests. `hive_context` gives any agent the full picture before it touches anything. |
| **Decisions** | `hive_note kind=decision` records conventions (remote names, API shapes) that every other agent then sees. |
| **Playtest lease** | One playtest at a time. Others can watch; only the owner can stop it (or force, explicitly). |
| **Studio edits merge in** | Changes made in Studio flow through Rojo to disk and are merged into the live doc as minimal diffs. |

## See and playtest the game

Open `http://localhost:7777/` for a live viewer: edit-mode viewport, ▶ Playtest / ■ Stop, active claims, activity feed and the Studio console. Agents get the same abilities through MCP, so Claude can look at the game, run a playtest, read the console and report back.

## Agent tools (MCP)

| Tool | Purpose |
|---|---|
| `hive_context` | **Read first.** Claims, decisions, recent changes by everyone, file list |
| `hive_read` | Live merged contents of a script |
| `hive_claim` / `hive_release` | Declare / drop intent on a path or subtree |
| `hive_edit` | Exact str-replace on the live doc |
| `hive_note` | Share a note, question or decision with all agents |
| `hive_screenshot` | See the game (edit-mode viewport, optional camera pose) |
| `hive_playtest_start` / `_stop` / `_status` | Run playtests under the shared lease |
| `hive_console` | Read the Studio output log |

## Quick start

```bash
npm install
node src/server.js /path/to/rojo-project     # Hive on :7777
rojo serve                                   # in the same dir, for Studio sync
```

Register the MCP bridge with each agent (give each its own name):

```json
{ "mcpServers": { "hive": {
    "command": "node", "args": ["/path/to/hive/src/mcp.js"],
    "env": { "HIVE_ACTOR": "agent-combat", "HIVE_URL": "http://localhost:7777" } } } }
```

Studio control uses Roblox's `StudioMCP` binary (macOS default path; override with `STUDIO_MCP=`).

```bash
npm test      # 13 tests
```

## Layout

```
src/core.js     Hive: CRDT docs, claims, ledger, playtest lease (pure, no I/O)
src/server.js   disk mirror + WebSocket sync + HTTP API + viewer
src/studio.js   StudioBridge: screenshots (cached), play/stop, console
src/mcp.js      MCP tools for agents
src/viewer.html live viewer
```

## Status

Working: core, server, MCP tools, Studio bridge, viewer, tests (Studio is faked in tests; live-Studio verification is pending).

Roadmap:
- [ ] VS Code extension: Yjs binding, presence cursors, claims panel
- [ ] Non-script instances (parts, properties) via a Studio plugin
- [ ] Playtest-time viewport capture
- [ ] Auth and multi-project hosting
- [ ] Code-OSS fork once the extension proves out

## Credits

Builds on [Rojo](https://github.com/rojo-rbx/rojo) (MPL-2.0) and [Yjs](https://github.com/yjs/yjs). Not affiliated with Roblox Corporation.

## License

MIT
