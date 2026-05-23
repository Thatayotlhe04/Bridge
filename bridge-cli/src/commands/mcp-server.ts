import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  apiRequest,
  findProjectRoot,
  readConfig,
  readProject,
} from "../lib.js";

type MemoryRow = {
  id: string;
  machine_id: string;
  event_type: string;
  payload: any;
  occurred_at: string;
};

/**
 * Bridge MCP server. Runs over stdio — Claude Code spawns it on demand
 * after `bridge init` registers it in .claude/mcp.json.
 *
 * Exposes one tool: recall_context(since_hours?, limit?).
 *
 * Reads the current project's workspace_id from .bridge/project.json
 * (found by walking up from cwd), then GETs /v1/memories from the backend.
 * Returns a markdown-formatted summary that Claude can read directly.
 */
export async function mcpServerCommand(): Promise<void> {
  const server = new Server(
    { name: "bridge", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "recall_context",
        description:
          "Retrieve recent Bridge memories for the current project, " +
          "synced across all the user's devices and AI coding tools. " +
          "Call this at the start of a session and any time you need " +
          "to remember what was discussed or decided earlier — including " +
          "work the user did from a different machine or in a different tool.",
        inputSchema: {
          type: "object",
          properties: {
            since_hours: {
              type: "number",
              description: "Look back this many hours. Default: 168 (one week).",
              default: 168,
            },
            limit: {
              type: "number",
              description: "Max number of memories to return. Default: 50.",
              default: 50,
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "recall_context") {
      return errorContent(`Unknown tool: ${request.params.name}`);
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const sinceHours = typeof args.since_hours === "number" ? args.since_hours : 168;
    const limit = typeof args.limit === "number" ? Math.min(args.limit, 500) : 50;

    const config = readConfig();
    if (!config) {
      return errorContent(
        "Bridge isn't logged in on this machine. Run `bridge login <apiKey> --api <url>`."
      );
    }
    const root = findProjectRoot();
    if (!root) {
      return errorContent(
        "Not inside a Bridge project. Run `bridge init` in this repo first."
      );
    }
    const project = readProject(root);
    if (!project) {
      return errorContent(
        "Bridge project file missing. Run `bridge init` in this repo."
      );
    }

    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const query = new URLSearchParams({
      workspace_id: project.workspace_id,
      since,
      limit: String(limit),
    });

    let response: { count: number; memories: MemoryRow[] };
    try {
      response = await apiRequest(config, "GET", `/v1/memories?${query.toString()}`);
    } catch (err: any) {
      return errorContent(`Bridge backend error: ${err.message}`);
    }

    return {
      content: [{ type: "text", text: formatMemories(response.memories, sinceHours) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function errorContent(msg: string) {
  return { content: [{ type: "text", text: `**Bridge:** ${msg}` }] };
}

function formatMemories(memories: MemoryRow[], sinceHours: number): string {
  if (memories.length === 0) {
    return `No Bridge memories in the last ${sinceHours}h for this project. ` +
      `Either nothing's been captured yet, or \`bridge sync\` hasn't run since the last events.`;
  }

  const lines: string[] = [
    `# Bridge — ${memories.length} memor${memories.length === 1 ? "y" : "ies"} from the last ${sinceHours}h`,
    "",
    "_These are events captured by Bridge across all your devices and AI tools for this project. The most recent are at the bottom._",
    "",
  ];

  // Group by machine for readability
  const byMachine = new Map<string, MemoryRow[]>();
  for (const m of memories) {
    if (!byMachine.has(m.machine_id)) byMachine.set(m.machine_id, []);
    byMachine.get(m.machine_id)!.push(m);
  }

  for (const m of memories) {
    const time = new Date(m.occurred_at).toISOString().replace("T", " ").slice(0, 16);
    lines.push(`### ${time} · \`${m.machine_id}\` · ${m.event_type}`);
    lines.push(renderPayload(m.event_type, m.payload));
    lines.push("");
  }

  return lines.join("\n");
}

function renderPayload(eventType: string, payload: any): string {
  if (!payload || typeof payload !== "object") return "_(no payload)_";
  switch (eventType) {
    case "user_prompt": {
      const text = payload.prompt ?? payload.text ?? payload.message ?? "";
      return text ? `> ${truncate(String(text), 600)}` : "_(empty prompt)_";
    }
    case "assistant_response": {
      const text = payload.message ?? payload.response ?? payload.text ?? "";
      return text ? `> ${truncate(String(text), 600)}` : "_(assistant finished)_";
    }
    case "tool_use": {
      const tool = payload.tool_name ?? payload.name ?? "tool";
      const inp = payload.tool_input ?? payload.input;
      const inpStr = inp ? truncate(JSON.stringify(inp), 240) : "";
      return inpStr ? `Used **${tool}** — \`${inpStr}\`` : `Used **${tool}**`;
    }
    case "session_start":
      return "_Session started._";
    case "session_end":
      return "_Session ended._";
    case "decision":
    case "note":
      return `> ${truncate(JSON.stringify(payload), 600)}`;
    default:
      return `> ${truncate(JSON.stringify(payload), 400)}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
