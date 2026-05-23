import fs from "node:fs";
import path from "node:path";
import { findProjectRoot } from "../lib.js";

const CLAUDE_MD_MARKER_START = "<!-- BRIDGE:BEGIN -->";
const CLAUDE_MD_MARKER_END = "<!-- BRIDGE:END -->";

export async function uninstallCommand(opts: { purge?: boolean }): Promise<void> {
  const root = findProjectRoot();
  if (!root) {
    console.log("No Bridge project found in cwd or any parent. Nothing to uninstall.");
    return;
  }
  console.log(`Uninstalling Bridge from ${root}`);

  const changes: string[] = [];

  // 1) Strip Bridge hooks from .claude/settings.json
  const settingsPath = path.join(root, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.hooks && typeof settings.hooks === "object") {
        let stripped = 0;
        for (const event of Object.keys(settings.hooks)) {
          if (!Array.isArray(settings.hooks[event])) continue;
          settings.hooks[event] = settings.hooks[event]
            .map((g: any) => ({
              ...g,
              hooks: Array.isArray(g.hooks)
                ? g.hooks.filter((h: any) => {
                    const isBridge =
                      h &&
                      h.type === "command" &&
                      typeof h.command === "string" &&
                      h.command.startsWith("bridge capture ");
                    if (isBridge) stripped++;
                    return !isBridge;
                  })
                : [],
            }))
            .filter((g: any) => g.hooks && g.hooks.length > 0);
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
        if (stripped > 0) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          changes.push(`Removed ${stripped} hook${stripped === 1 ? "" : "s"} from .claude/settings.json`);
        }
      }
    } catch (err: any) {
      console.warn(`Could not parse ${settingsPath}: ${err.message}`);
    }
  }

  // 2) Remove bridge MCP server from .claude/mcp.json
  const mcpPath = path.join(root, ".claude", "mcp.json");
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
      if (mcp.mcpServers && mcp.mcpServers.bridge) {
        delete mcp.mcpServers.bridge;
        if (Object.keys(mcp.mcpServers).length === 0) delete mcp.mcpServers;
        if (Object.keys(mcp).length === 0) {
          fs.unlinkSync(mcpPath);
          changes.push("Deleted .claude/mcp.json (was empty after removing bridge)");
        } else {
          fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));
          changes.push("Removed bridge MCP server from .claude/mcp.json");
        }
      }
    } catch (err: any) {
      console.warn(`Could not parse ${mcpPath}: ${err.message}`);
    }
  }

  // 3) Strip Bridge block from CLAUDE.md (idempotent — leaves rest of file alone)
  const claudeMdPath = path.join(root, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    const startIdx = content.indexOf(CLAUDE_MD_MARKER_START);
    const endIdx = content.indexOf(CLAUDE_MD_MARKER_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = content.slice(0, startIdx).replace(/\n+$/, "");
      const after = content.slice(endIdx + CLAUDE_MD_MARKER_END.length).replace(/^\n+/, "");
      const cleaned = [before, after].filter((s) => s.length > 0).join("\n\n");
      if (cleaned.trim().length === 0) {
        fs.unlinkSync(claudeMdPath);
        changes.push("Deleted CLAUDE.md (was empty after removing Bridge block)");
      } else {
        fs.writeFileSync(claudeMdPath, cleaned + "\n");
        changes.push("Removed Bridge block from CLAUDE.md");
      }
    }
  }

  // 4) Optionally purge .bridge/ — by default we preserve it so re-installing
  //    via `bridge init` lands on the same workspace.
  if (opts.purge) {
    const bridgeDir = path.join(root, ".bridge");
    if (fs.existsSync(bridgeDir)) {
      fs.rmSync(bridgeDir, { recursive: true, force: true });
      changes.push("Purged .bridge/ directory");
    }
  }

  if (changes.length === 0) {
    console.log("Nothing to remove — Bridge wasn't installed in this project.");
    return;
  }

  console.log("");
  for (const c of changes) console.log(`  ✓ ${c}`);
  if (!opts.purge) {
    console.log(
      `\n.bridge/project.json kept — re-running \`bridge init\` will land on the same workspace.\nPass --purge to remove it.`
    );
  }
}
