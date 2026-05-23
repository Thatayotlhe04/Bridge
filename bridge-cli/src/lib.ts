import { execSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// ─── Paths ───────────────────────────────────────────────────────────────────

export const BRIDGE_HOME = path.join(os.homedir(), ".bridge");
export const CONFIG_PATH = path.join(BRIDGE_HOME, "config.json");
export const BUFFER_PATH = path.join(BRIDGE_HOME, "buffer.db");

function ensureBridgeHome(): void {
  if (!fs.existsSync(BRIDGE_HOME)) {
    fs.mkdirSync(BRIDGE_HOME, { recursive: true, mode: 0o700 });
  }
}

// ─── Config (~/.bridge/config.json) ──────────────────────────────────────────

export type BridgeConfig = {
  api_url: string;
  api_key: string;
  machine_id: string;
};

export function readConfig(): BridgeConfig | null {
  ensureBridgeHome();
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function writeConfig(config: BridgeConfig): void {
  ensureBridgeHome();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function requireConfig(): BridgeConfig {
  const cfg = readConfig();
  if (!cfg) {
    throw new Error("Not logged in. Run `bridge login <apiKey>` first.");
  }
  return cfg;
}

export function generateMachineId(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32);
  return `${host}-${randomBytes(4).toString("hex")}`;
}

// ─── Project (workspace) — written inside each repo ──────────────────────────

export type ProjectFile = {
  project_id_hash: string;
  workspace_id: string;
};

const PROJECT_DIR = ".bridge";
const PROJECT_FILE = "project.json";

export function findProjectRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, PROJECT_DIR, PROJECT_FILE))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return dir; // stop at git root
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readProject(root: string): ProjectFile | null {
  const p = path.join(root, PROJECT_DIR, PROJECT_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function writeProject(root: string, project: ProjectFile): void {
  const dir = path.join(root, PROJECT_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, PROJECT_FILE),
    JSON.stringify(project, null, 2)
  );
}

/**
 * Compute a stable project_id_hash for the given directory.
 * Prefers `git remote get-url origin`. Falls back to a generated UUID.
 * THIS IS THE WEDGE: same hash on every machine for the same repo.
 */
export function computeProjectIdHash(cwd: string): { hash: string; source: "git" | "uuid" } {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (remote) {
      const h = createHash("sha256").update(remote).digest("hex").slice(0, 32);
      return { hash: `sha256-${h}`, source: "git" };
    }
  } catch {
    // no remote, fall through
  }
  return { hash: `uuid-${randomUUID()}`, source: "uuid" };
}

// ─── Local buffer (SQLite) ───────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function buffer(): Database.Database {
  if (_db) return _db;
  ensureBridgeHome();
  _db = new Database(BUFFER_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_event_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS pending_workspace_idx ON pending(workspace_id, id);
  `);
  return _db;
}

export type PendingRow = {
  id: number;
  client_event_id: string;
  workspace_id: string;
  machine_id: string;
  event_type: string;
  payload: string;
  occurred_at: string;
  attempts: number;
};

export function pendingCount(): number {
  return (buffer().prepare("SELECT COUNT(*) AS c FROM pending").get() as { c: number }).c;
}

// ─── API client ──────────────────────────────────────────────────────────────

export async function apiRequest<T = unknown>(
  config: BridgeConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const url = config.api_url.replace(/\/$/, "") + path;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${config.api_key}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
