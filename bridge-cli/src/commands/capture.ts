import { randomUUID } from "node:crypto";
import { buffer, findProjectRoot, readConfig, readProject } from "../lib.js";

/**
 * Invoked by Claude Code hooks. Reads the hook event JSON from stdin,
 * extracts the interesting bits, and inserts into the local SQLite buffer.
 *
 * Must NEVER throw — hooks are async, but if this errors out it might
 * still pollute Claude's logs. Swallow everything except invalid args.
 */
export async function captureCommand(eventType: string): Promise<void> {
  try {
    // Quick env checks — silently bail if Bridge isn't fully set up here
    const config = readConfig();
    if (!config) return;
    const root = findProjectRoot();
    if (!root) return;
    const project = readProject(root);
    if (!project) return;

    // Read stdin (hook JSON payload). Some events have no stdin — handle both.
    const raw = await readStdin();
    let parsed: any = null;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { _raw: raw.slice(0, 4096) };
      }
    }

    const payload = trimPayload(eventType, parsed);
    const occurredAt = new Date().toISOString();
    const clientEventId = randomUUID();

    buffer()
      .prepare(
        `INSERT INTO pending
           (client_event_id, workspace_id, machine_id, event_type, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        clientEventId,
        project.workspace_id,
        config.machine_id,
        eventType,
        JSON.stringify(payload ?? {}),
        occurredAt
      );
  } catch (err) {
    // Last-resort silence — capture must not break Claude Code
    if (process.env.BRIDGE_DEBUG) {
      console.error("bridge capture failed:", err);
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    // Safety timeout — hooks must be fast; 500ms is plenty for any payload Claude Code emits
    setTimeout(() => resolve(data), 500);
  });
}

/**
 * Hook payloads can be large (full file contents on Edit, full Bash output).
 * Cap individual string fields at 8KB so the buffer doesn't bloat.
 * v1 should compress; v0 just truncates.
 */
function trimPayload(eventType: string, payload: any, maxFieldLen = 8192): any {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") {
    return payload.length > maxFieldLen
      ? payload.slice(0, maxFieldLen) + `…[truncated ${payload.length - maxFieldLen} chars]`
      : payload;
  }
  if (Array.isArray(payload)) {
    return payload.slice(0, 200).map((v) => trimPayload(eventType, v, maxFieldLen));
  }
  if (typeof payload === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(payload)) {
      out[k] = trimPayload(eventType, v, maxFieldLen);
    }
    return out;
  }
  return payload;
}
