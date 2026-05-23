# Bridge

Cross-device, cross-tool memory layer for Claude Code. Your conversation history, decisions, and edits follow you from laptop to desktop, between Claude Code sessions, regardless of where the repo lives on disk.

**The wedge**: every existing solution (Claude Sync, claude-memsync, claude-mem) keys project sessions by absolute filesystem path. Bridge keys them by `sha256(git remote get-url origin)`. Same repo → same workspace, every machine, every time.

## What's in this bundle

```
bridge/
├── README.md                ← this file
├── bridge-landing.html      ← marketing site (open in any browser)
├── bridge-backend/          ← Hono API + Neon Postgres
└── bridge-cli/              ← CLI + Claude Code hooks + MCP server
```

Three deployables. They talk to each other over HTTPS.

## The data flow, in one paragraph

You open Claude Code on your laptop. The `SessionStart` hook fires `bridge capture session_start`, which writes a row to `~/.bridge/buffer.db`. Every prompt, response, and mutating tool call adds a row. A `bridge sync` (or `bridge sync --watch`) drains the buffer to your hosted Bridge backend, where each event lands in Postgres keyed by your workspace's `project_id_hash`. Later, you open Claude Code on your desktop in the same repo — Claude reads the `CLAUDE.md` instruction Bridge wrote, calls `recall_context()` via the Bridge MCP server, which fetches all recent events from Postgres and returns them as markdown. Your session continues with full context. Loop closed.

## Setup order — fastest path to working v1

You need: Node 20+, a Neon Postgres (free at neon.tech), a place to host the backend (Render or Fly, ~$5/mo).

### 1. Stand up the backend (~15 minutes)

```bash
cd bridge-backend
cp .env.example .env
# edit .env — paste your Neon DATABASE_URL and pick a long random ADMIN_TOKEN
npm install
npm run db:push       # creates tables
npm run dev           # local at http://localhost:8787

# in another terminal — create your user account
curl -X POST http://localhost:8787/admin/users \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"tsenangthatayotlhe04@gmail.com"}'
# returns { id, email, api_key: "bridge_xxx..." } — save the api_key
```

For production, deploy this folder to Render or Fly (instructions in `bridge-backend/README.md`). Same env vars, same code.

### 2. Install the CLI (~5 minutes)

```bash
cd ../bridge-cli
npm install
npm run build
npm link              # makes `bridge` available globally

bridge login bridge_xxxxx --api http://localhost:8787   # or your hosted URL
bridge ping           # should print: OK · 42ms · your@email
```

### 3. Wire it into a project (~1 minute)

```bash
cd ~/your-real-repo
bridge init           # writes .bridge/project.json, .claude/settings.json,
                      # .claude/mcp.json, AND CLAUDE.md block (new in v1.1)
```

That's it — `CLAUDE.md` is wired automatically now. Claude will call `recall_context()` at session start without you having to remember.

### 4. Use Claude Code normally

Events accumulate in `~/.bridge/buffer.db` as you work. Flush them with `bridge sync` (or run `bridge sync --watch &` in a tmux pane).

### 5. The proof — sync across machines

Repeat steps 2–3 on a second machine (with the same git repo cloned). The workspace ID resolves identically. Claude Code on machine #2 will see machine #1's context.

### Removing Bridge from a project

```bash
bridge uninstall          # removes hooks, MCP entry, and the CLAUDE.md block
bridge uninstall --purge  # also deletes .bridge/ — full clean state
```

Default uninstall keeps `.bridge/project.json` so a future `bridge init` lands on the same workspace.

## Platform notes

- **macOS** — primary target. By June (per your timeline), you're on this. Everything just works.
- **Linux** — fine.
- **Windows native** — backend and CLI compile and run fine, but Claude Code on native Windows is patchy in mid-2026. Until you're on macOS, run the whole stack inside WSL2. Backend + Neon are cross-platform regardless, so you can deploy from Windows fine.

## Design system

- **Logo**: `</br>` — the HTML line-break tag, read as "br" for Bridge. Pixelated/code-y on purpose.
- **Fonts**: Press Start 2P (logo only — the pixel identity) + Montserrat (headlines, body) + JetBrains Mono (code, labels).
- **Accent color**: bright green `#4ade80` on the dark surface — terminal-luminous, not toxic-lime.
- **Surface treatment**: neumorphic shadows on every elevated panel (cards, demo window, nav pill, pricing).

## What's NOT in this v1.1 — but should come next

- **Client-side encryption.** Memories are stored plaintext in Postgres. Add libsodium with passphrase-derived keys before letting anyone other than yourself use this.
- **Embeddings / semantic recall.** `recall_context` returns recent events by time, not relevance. Postgres `pg_vector` + `text-embedding-3-small` is a v2 add.
- **Compression.** Big `PostToolUse` payloads get truncated at 8KB. Real compression (or LLM-based summarization, like claude-mem does) is v2.
- **Team workspaces.** Single-user only. Adding `workspace_members` + invite flow is straightforward but deferred.
- **Web dashboard.** None. Use `bridge status` and `npm run db:studio` in the backend folder.

## Layout summary

| Folder | What it is | Deploy where |
|---|---|---|
| `bridge-landing.html` | Marketing site, single HTML file | Static host (Vercel, Cloudflare Pages, GitHub Pages) |
| `bridge-backend/` | API server, Postgres schema | Render, Fly.io, Railway |
| `bridge-cli/` | CLI binary, hooks, MCP server | npm package — install on every dev machine |

## Contact

Built by Tsenang. tsenangthatayotlhe04@gmail.com
