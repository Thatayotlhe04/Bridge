import fs from "node:fs";
import path from "node:path";
import {
  apiRequest,
  computeProjectIdHash,
  requireConfig,
  writeProject,
  type ProjectFile,
} from "../lib.js";

type Workspace = {
  id: string;
  project_id_hash: string;
  name: string | null;
  created_at: string;
};

export async function initCommand(opts: { name?: string }): Promise<void> {
  const config = requireConfig();
  const cwd = process.cwd();

  // 1) Compute or reuse project_id_hash
  const { hash, source } = computeProjectIdHash(cwd);
  console.log(`Project ID:  ${hash}  (from ${source === "git" ? "git remote" : "generated UUID"})`);
  if (source === "uuid") {
    console.warn(
      "\n  ⚠  No git remote found. Bridge generated a per-machine UUID for this project.\n" +
      "     Cross-device sync will NOT work — each machine will create its own workspace.\n" +
      "     Fix: `git remote add origin <url>` and re-run `bridge init`.\n"
    );
  }

  // 2) Get-or-create workspace via API
  const name = opts.name ?? path.basename(cwd);
  const ws = await apiRequest<Workspace>(config, "POST", "/v1/workspaces", {
    project_id_hash: hash,
    name,
  });
  console.log(`Workspace:   ${ws.id}  (${ws.name})`);

  // 3) Write .bridge/project.json
  const project: ProjectFile = {
    project_id_hash: hash,
    workspace_id: ws.id,
  };
  writeProject(cwd, project);

  // 4) Register hooks in .claude/settings.json (merge with existing)
  registerHooks(cwd);

  // 5) Register MCP server in .claude/mcp.json (merge with existing)
  registerMcpServer(cwd);

  // 6) Add the recall_context instruction to CLAUDE.md so Claude
  //    knows to call the MCP tool without the user remembering.
  registerClaudeMd(cwd);

  console.log(`\nDone. Run \`claude\` in this directory — Bridge will capture events AND inject context via MCP.`);
  console.log(`Then run \`bridge sync\` to push the buffer to the cloud.`);
}

const CLAUDE_MD_MARKER_START = "<!-- BRIDGE:BEGIN -->";
const CLAUDE_MD_MARKER_END = "<!-- BRIDGE:END -->";

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_MARKER_START}
## Bridge — cross-device memory

At the start of every session, call the \`recall_context\` tool to load Bridge's
synced memories for this project. Call it again whenever you need to remember
earlier context — including work done from another machine or in another AI tool.
${CLAUDE_MD_MARKER_END}`;

/**
 * Append (or update) a Bridge block in CLAUDE.md, bracketed by HTML comments
 * so we can find and remove it later. If the file doesn't exist, create one.
 */
function registerClaudeMd(cwd: string): void {
  const claudeMdPath = path.join(cwd, "CLAUDE.md");

  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, CLAUDE_MD_BLOCK + "\n");
    console.log(`CLAUDE.md:   wrote ${claudeMdPath}`);
    return;
  }

  const existing = fs.readFileSync(claudeMdPath, "utf-8");
  const startIdx = existing.indexOf(CLAUDE_MD_MARKER_START);
  const endIdx = existing.indexOf(CLAUDE_MD_MARKER_END);

  let updated: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing Bridge block
    updated =
      existing.slice(0, startIdx) +
      CLAUDE_MD_BLOCK +
      existing.slice(endIdx + CLAUDE_MD_MARKER_END.length);
  } else {
    // Append (with separating blank line if needed)
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    updated = existing + sep + CLAUDE_MD_BLOCK + "\n";
  }
  fs.writeFileSync(claudeMdPath, updated);
  console.log(`CLAUDE.md:   updated ${claudeMdPath}`);
}

/**
 * Register the Bridge MCP server in .claude/mcp.json so Claude Code can
 * spawn it to call recall_context() during sessions.
 */
function registerMcpServer(cwd: string): void {
  const claudeDir = path.join(cwd, ".claude");
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  const mcpPath = path.join(claudeDir, "mcp.json");

  let mcp: any = {};
  if (fs.existsSync(mcpPath)) {
    try {
      mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    } catch {
      console.warn("Warning: .claude/mcp.json was unreadable; backing up to mcp.json.bak");
      fs.copyFileSync(mcpPath, mcpPath + ".bak");
      mcp = {};
    }
  }
  if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") mcp.mcpServers = {};

  mcp.mcpServers.bridge = {
    command: "bridge",
    args: ["mcp-server"],
  };

  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));
  console.log(`MCP server: wrote ${mcpPath}`);
}

/**
 * Merge Bridge hooks into .claude/settings.json. Preserves any user-defined
 * hooks already in the file. Identifies our entries by command prefix so
 * re-running `bridge init` is idempotent.
 */
function registerHooks(cwd: string): void {
  const claudeDir = path.join(cwd, ".claude");
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");

  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      console.warn("Warning: .claude/settings.json was unreadable; backing up to settings.json.bak");
      fs.copyFileSync(settingsPath, settingsPath + ".bak");
      settings = {};
    }
  }
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const bridgeHooks: Record<string, Array<{ matcher?: string; hooks: any[] }>> = {
    SessionStart: [
      { hooks: [bridgeHook("session_start")] },
    ],
    UserPromptSubmit: [
      { hooks: [bridgeHook("user_prompt")] },
    ],
    PostToolUse: [
      // Only capture mutating tools. Reads are noisy and low-signal.
      { matcher: "Edit|Write|MultiEdit|Bash", hooks: [bridgeHook("tool_use")] },
    ],
    Stop: [
      { hooks: [bridgeHook("assistant_response")] },
    ],
    SessionEnd: [
      { hooks: [bridgeHook("session_end")] },
    ],
  };

  for (const [event, groups] of Object.entries(bridgeHooks)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

    // Strip prior bridge entries from each group
    settings.hooks[event] = settings.hooks[event]
      .map((g: any) => ({
        ...g,
        hooks: Array.isArray(g.hooks)
          ? g.hooks.filter((h: any) => !isBridgeHook(h))
          : [],
      }))
      .filter((g: any) => g.hooks && g.hooks.length > 0);

    // Append our group
    for (const g of groups) settings.hooks[event].push(g);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`Hooks:       wrote ${settingsPath}`);
}

function bridgeHook(eventName: string) {
  return {
    type: "command" as const,
    command: `bridge capture ${eventName}`,
    async: true,
  };
}

function isBridgeHook(h: any): boolean {
  return (
    h &&
    h.type === "command" &&
    typeof h.command === "string" &&
    h.command.startsWith("bridge capture ")
  );
}
