#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { statusCommand } from "./commands/status.js";
import { captureCommand } from "./commands/capture.js";
import { syncCommand } from "./commands/sync.js";
import { pingCommand } from "./commands/ping.js";
import { mcpServerCommand } from "./commands/mcp-server.js";
import { uninstallCommand } from "./commands/uninstall.js";

const program = new Command();

program
  .name("bridge")
  .description("Cross-device memory sync for Claude Code")
  .version("0.1.0");

program
  .command("init")
  .description("Register Bridge hooks in the current project")
  .option("-n, --name <name>", "Workspace name (defaults to git repo name)")
  .action(initCommand);

program
  .command("uninstall")
  .description("Remove Bridge hooks, MCP server, and CLAUDE.md block from this project")
  .option("--purge", "Also delete .bridge/ (loses workspace ID; re-init creates a new one)")
  .action(uninstallCommand);

program
  .command("login <apiKey>")
  .description("Save your Bridge API key locally")
  .option(
    "--api <url>",
    "Bridge backend URL",
    "http://localhost:8787"
  )
  .action(loginCommand);

program
  .command("status")
  .description("Show current config + pending events")
  .action(statusCommand);

program
  .command("ping")
  .description("Check that the backend is reachable and your API key works")
  .action(pingCommand);

program
  .command("capture <eventType>")
  .description("Internal — invoked by Claude Code hooks (reads JSON on stdin)")
  .action(captureCommand);

program
  .command("sync")
  .description("Flush local buffer to the Bridge backend")
  .option("-w, --watch", "Keep running, sync every 10 seconds")
  .action(syncCommand);

program
  .command("mcp-server")
  .description("Internal — runs the Bridge MCP server over stdio (invoked by Claude Code)")
  .action(mcpServerCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error("bridge:", err.message ?? err);
  process.exit(1);
});
