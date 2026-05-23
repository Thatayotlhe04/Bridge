# Bridge CLI + Claude Code plugin + MCP server — v1

A single Node binary (`bridge`) that does three things for cross-device Claude Code memory:

1. **Writes** — registers itself as Claude Code lifecycle hooks, captures session events to a local SQLite buffer, syncs them to your Bridge backend.
2. **Reads** — exposes itself as an MCP server so Claude can call `recall_context()` mid-session and retrieve memories synced from any other device or AI tool.
3. **Resolves identity** — computes a stable workspace ID from `git remote get-url origin` so the same repo on every machine maps to the same memory pool, regardless of file path.

That's the loop closed: write on laptop, read on desktop, same session continues.

## What `bridge init` does

When you run it inside a git repo:

1. Computes a stable **project ID** from `git remote get-url origin` (sha256 → first 32 chars). Writes it to `.bridge/project.json`. **This is the wedge** — same git repo on any machine resolves to the same workspace, regardless of where on disk it lives.
2. Calls `POST /v1/workspaces` on your backend to get-or-create the workspace.
3. Patches `.claude/settings.json` to register **five lifecycle hooks** that all invoke `bridge capture <event>`:
   - `SessionStart` — when Claude Code opens
   - `UserPromptSubmit` — when you send a message
   - `PostToolUse` (Edit / Write / MultiEdit / Bash only) — after mutating tools
   - `Stop` — when Claude finishes responding
   - `SessionEnd` — when Claude Code exits
4. Patches `.claude/mcp.json` to register the **Bridge MCP server**, so Claude can call `recall_context()` mid-session.
5. Patches `CLAUDE.md` with a marker-bracketed block telling Claude to call `recall_context` at session start (creates the file if it doesn't exist). The block is bounded by HTML comment markers so `bridge uninstall` can find and remove just that section.

Every hook runs async, so it never blocks your Claude session. Events are written to `~/.bridge/buffer.db` synchronously (so they survive crashes), then flushed to your backend by `bridge sync`.

## Install + use

```bash
# from the bridge-cli/ directory
npm install
npm run build
npm link            # makes `bridge` available globally on your machine

# point it at your backend
bridge login YOUR_API_KEY --api https://your-backend.fly.dev

# sanity-check the connection (new in v1)
bridge ping

# inside any git repo:
cd ~/code/some-project
bridge init

# Claude Code is now wired in BOTH directions: capture + recall.
claude  # use it normally — Claude can now call recall_context()

# in another terminal, flush the buffer to the cloud:
bridge sync

# or watch mode — keeps syncing every 10s:
bridge sync --watch &
```

## File layout

```
bridge-cli/
├── README.md
├── package.json          ← deps + bin entry
├── tsconfig.json
└── src/
    ├── index.ts          ← CLI dispatch
    ├── lib.ts            ← config, buffer, api, workspace helpers
    └── commands/
        ├── init.ts       ← registers hooks, mcp server, AND CLAUDE.md block
        ├── uninstall.ts  ← clean reverse of init (idempotent)
        ├── login.ts      ← verifies via /v1/whoami
        ├── ping.ts       ← sanity check the backend
        ├── status.ts
        ├── capture.ts    ← invoked by hooks; reads JSON from stdin
        ├── sync.ts       ← idempotent flush via client_event_id
        └── mcp-server.ts ← v1: stdio MCP, exposes recall_context tool
```

## The MCP tool — `recall_context`

Claude Code spawns `bridge mcp-server` (via `.claude/mcp.json`) and gets one tool:

```
recall_context(since_hours?: number = 168, limit?: number = 50)
```

It reads the current project's workspace_id from `.bridge/project.json`, hits `GET /v1/memories` on your backend, and returns a markdown-formatted summary of recent events across all your machines. `bridge init` writes the instruction telling Claude to call this at session start directly into `CLAUDE.md` — you don't have to remember.

To remove everything (hooks, MCP entry, CLAUDE.md block):

```bash
bridge uninstall          # keeps .bridge/project.json so re-init lands on the same workspace
bridge uninstall --purge  # also deletes .bridge/, full clean state
```

## How hooks get registered

`bridge init` writes (or merges into) `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "bridge capture session_start",      "async": true }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bridge capture user_prompt",        "async": true }] }],
    "PostToolUse":      [{ "matcher": "Edit|Write|MultiEdit|Bash",
                          "hooks": [{ "type": "command", "command": "bridge capture tool_use",            "async": true }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "bridge capture assistant_response", "async": true }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "bridge capture session_end",        "async": true }] }]
  }
}
```

And `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "bridge": { "command": "bridge", "args": ["mcp-server"] }
  }
}
```

If either file already exists, `bridge init` merges its entries in (idempotently — it strips prior Bridge entries before re-adding, and preserves any other hooks/servers you have).

## Caveats

- Requires **Node 20+** for built-in `fetch`. Node 22+ recommended.
- Local buffer is plaintext SQLite. Encrypt at rest in v2 (libsodium with a passphrase-derived key).
- Hook payloads can be large (PostToolUse with a big file read). v1 truncates string fields to 8KB. v2 should compress.

### Important — `bridge` must be on PATH inside Claude Code

The hook commands `bridge capture session_start` etc. — and the MCP spawn `bridge mcp-server` — run as subprocesses Claude Code launches. If `bridge` isn't on the PATH Claude Code sees, both hooks AND the MCP server silently fail. Test with `bridge ping` — if it works in the same shell where you launch Claude Code, you're fine. With `nvm` / `asdf` / `volta`, make sure Claude Code is launched from a shell where the right Node version is active, OR install Bridge globally with `npm install -g bridge-cli` (not just `npm link` in a working copy).

### Commit `.bridge/project.json` to git — yes

The file is small (two lines: the project ID hash and your workspace UUID) and committing it means anyone who clones the repo and runs `bridge init` lands on the *same* workspace automatically. Don't `.gitignore` it. The trade-off is that the workspace UUID becomes visible in your repo history, which is fine — without your API key it's unusable.

### Only run one `bridge sync --watch` per machine

The local SQLite buffer doesn't lease rows. Two sync processes will race and may each try to POST the same event (idempotency on the backend will dedupe via `client_event_id`, but it's wasted bandwidth). One watcher per machine is enough.

### Platform support

- **macOS** — primary target. Everything works.
- **Linux** — works.
- **Windows native** — backend and CLI run fine, but Claude Code on native Windows is patchy as of mid-2026. Easiest path is to run the whole stack inside WSL2.
