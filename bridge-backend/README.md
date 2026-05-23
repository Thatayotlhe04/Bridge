# Bridge backend — v0

The smallest version of the Bridge cloud that actually does the thing: capture memory events from the Bridge plugin, store them keyed by workspace (resolved via git remote, not file path), and serve them back to the MCP server for recall.

## What this is

- **Hono** API on Node 20+, deployable to Render / Fly / Railway in minutes
- **Neon Postgres** (serverless) via **Drizzle ORM**
- **API-key auth** (simple bearer token — swap for Clerk when you have real users)
- Three endpoints:
  - `POST /v1/workspaces` — get-or-create a workspace by `project_id_hash`
  - `POST /v1/memories` — append a memory event
  - `GET  /v1/memories?workspace_id=...&since=...` — fetch events for recall

That's it. Everything else (compression, embeddings, web dashboard, teams) is post-v0.

## File layout

```
bridge-backend/
├── README.md             ← this file
├── package.json          ← deps
├── tsconfig.json
├── drizzle.config.ts
├── .env.example          ← copy to .env
└── src/
    ├── index.ts          ← Hono app + all routes (refactor later)
    └── db/
        └── schema.ts     ← Drizzle schema — the architectural decisions
```

## Run it locally

```bash
# 1. Install
npm install

# 2. Set up a Neon Postgres DB (free tier at neon.tech)
#    Copy your connection string into .env

cp .env.example .env
# edit .env — paste DATABASE_URL and pick any ADMIN_TOKEN

# 3. Push schema to the database
npm run db:push

# 4. Create a user + grab the API key
npm run seed -- you@example.com

# 5. Start the server
npm run dev
```

API is now at `http://localhost:8787`. Test it:

```bash
# Get-or-create a workspace
curl -X POST http://localhost:8787/v1/workspaces \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"project_id_hash":"sha256-of-git-remote","name":"my-project"}'

# Write a memory
curl -X POST http://localhost:8787/v1/memories \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id":"<from-above>",
    "machine_id":"laptop-001",
    "event_type":"user_prompt",
    "payload":{"text":"Refactor checkout.ts"},
    "occurred_at":"2026-05-17T09:14:00Z"
  }'

# Read memories
curl "http://localhost:8787/v1/memories?workspace_id=<ID>&since=2026-05-17T00:00:00Z" \
  -H "Authorization: Bearer <YOUR_API_KEY>"
```

## Deploy

Easiest path: **Render** or **Fly.io**.

**Render:** New Web Service → Build `npm install && npm run build`, Start `npm start`. Add `DATABASE_URL` and `ADMIN_TOKEN` env vars. Done.

**Fly.io:** `fly launch` from this directory, accept the defaults, add the same env vars via `fly secrets set DATABASE_URL=... ADMIN_TOKEN=...`.

Either should cost ~$5–7/month at v0 scale.

## Schema notes — the wedge

`workspaces.project_id_hash` is the load-bearing column. The Bridge plugin writes a `.bridge/project-id` file at `bridge init` time, derived from `sha256(git remote get-url origin)` if there's a remote, or a generated UUID otherwise. Every machine running Bridge on the same git repo computes the *same hash* — and therefore resolves to the *same workspace row* — regardless of where the repo lives on disk. This is the thing Claude Sync / claude-memsync don't fully solve. Don't let it drift.

## Next pieces (not in this repo yet)

1. **Bridge Claude Code plugin** — TypeScript, hooks into `SessionStart`/`PostToolUse`/`UserPromptSubmit`/`Stop`/`SessionEnd`, buffers events to local SQLite, flushes to this API in the background.
2. **Bridge MCP server** — TypeScript, one tool `recall_context(query?, limit?)`, registered in `~/.claude/mcp.json`. Reads from this API.
3. **`bridge` CLI** — `bridge init`, `bridge status`, `bridge sync now`. Handles the `.bridge/project-id` file.

Say the word and I'll scaffold each.
