import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { and, eq, gte, asc } from "drizzle-orm";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { users, workspaces, memories } from "./db/schema.js";

// ─── DB ──────────────────────────────────────────────────────────────────────

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema: { users, workspaces, memories } });

// ─── App ─────────────────────────────────────────────────────────────────────

type Variables = { userId: string };
const app = new Hono<{ Variables: Variables }>();

app.use("*", logger());
app.use("*", cors({ origin: "*" }));

app.get("/", (c) => c.json({ ok: true, service: "bridge", version: "0.1.0" }));

// ─── Admin (create users) ────────────────────────────────────────────────────

app.post("/admin/users", async (c) => {
  const token = c.req.header("x-admin-token");
  if (token !== process.env.ADMIN_TOKEN) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ email: z.string().email() }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.flatten() }, 400);
  }
  const apiKey = `bridge_${randomBytes(24).toString("hex")}`;
  try {
    const [u] = await db
      .insert(users)
      .values({ email: parsed.data.email, apiKey })
      .returning();
    return c.json({ id: u.id, email: u.email, api_key: u.apiKey });
  } catch (err: any) {
    if (err?.message?.includes("unique")) {
      return c.json({ error: "email_already_exists" }, 409);
    }
    throw err;
  }
});

// ─── Auth middleware (for /v1/*) ─────────────────────────────────────────────

app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key) return c.json({ error: "missing_bearer_token" }, 401);
  const [u] = await db.select().from(users).where(eq(users.apiKey, key)).limit(1);
  if (!u) return c.json({ error: "invalid_api_key" }, 401);
  c.set("userId", u.id);
  await next();
});

// ─── /v1/workspaces — get-or-create by project_id_hash ──────────────────────

const workspaceBody = z.object({
  project_id_hash: z.string().min(8).max(128),
  name: z.string().max(200).optional(),
});

app.post("/v1/workspaces", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = workspaceBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.flatten() }, 400);
  }
  const userId = c.get("userId");
  const { project_id_hash, name } = parsed.data;

  // Idempotent get-or-create via the unique index on (user_id, project_id_hash)
  const inserted = await db
    .insert(workspaces)
    .values({ userId, projectIdHash: project_id_hash, name })
    .onConflictDoNothing({ target: [workspaces.userId, workspaces.projectIdHash] })
    .returning();

  const row =
    inserted[0] ??
    (
      await db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.userId, userId),
            eq(workspaces.projectIdHash, project_id_hash)
          )
        )
        .limit(1)
    )[0];

  return c.json({
    id: row.id,
    project_id_hash: row.projectIdHash,
    name: row.name,
    created_at: row.createdAt,
  });
});

// ─── /v1/whoami — verify API key, return user info ──────────────────────────

app.get("/v1/whoami", async (c) => {
  const userId = c.get("userId");
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return c.json({ error: "user_not_found" }, 404);
  return c.json({ id: u.id, email: u.email });
});

// ─── /v1/memories — append (idempotent on client_event_id) ──────────────────

const memoryBody = z.object({
  workspace_id: z.string().uuid(),
  client_event_id: z.string().min(8).max(64).optional(),
  machine_id: z.string().min(1).max(200),
  event_type: z.enum([
    "session_start",
    "session_end",
    "user_prompt",
    "assistant_response",
    "tool_use",
    "file_edit",
    "decision",
    "note",
  ]),
  payload: z.record(z.unknown()),
  occurred_at: z.string().datetime(),
});

app.post("/v1/memories", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = memoryBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.flatten() }, 400);
  }
  const userId = c.get("userId");

  // Verify workspace belongs to this user — never trust workspace_id from the client
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(
      and(eq(workspaces.id, parsed.data.workspace_id), eq(workspaces.userId, userId))
    )
    .limit(1);
  if (!ws) return c.json({ error: "workspace_not_found" }, 404);

  // Idempotent insert. If (workspace_id, client_event_id) already exists,
  // return the existing row instead of erroring.
  const inserted = await db
    .insert(memories)
    .values({
      workspaceId: parsed.data.workspace_id,
      clientEventId: parsed.data.client_event_id ?? null,
      machineId: parsed.data.machine_id,
      eventType: parsed.data.event_type,
      payload: parsed.data.payload,
      occurredAt: new Date(parsed.data.occurred_at),
    })
    .onConflictDoNothing({
      target: [memories.workspaceId, memories.clientEventId],
    })
    .returning();

  if (inserted.length > 0) {
    return c.json({ id: inserted[0].id, created_at: inserted[0].createdAt, deduped: false });
  }

  // Conflict — fetch the existing row and return its id
  if (parsed.data.client_event_id) {
    const [existing] = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.workspaceId, parsed.data.workspace_id),
          eq(memories.clientEventId, parsed.data.client_event_id)
        )
      )
      .limit(1);
    if (existing) {
      return c.json({ id: existing.id, created_at: existing.createdAt, deduped: true });
    }
  }
  return c.json({ error: "insert_failed" }, 500);
});

// ─── /v1/memories — read ────────────────────────────────────────────────────

const memoryQuery = z.object({
  workspace_id: z.string().uuid(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

app.get("/v1/memories", async (c) => {
  const parsed = memoryQuery.safeParse({
    workspace_id: c.req.query("workspace_id"),
    since: c.req.query("since"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_query", details: parsed.error.flatten() }, 400);
  }
  const userId = c.get("userId");

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(
      and(eq(workspaces.id, parsed.data.workspace_id), eq(workspaces.userId, userId))
    )
    .limit(1);
  if (!ws) return c.json({ error: "workspace_not_found" }, 404);

  const conditions = [eq(memories.workspaceId, parsed.data.workspace_id)];
  if (parsed.data.since) {
    conditions.push(gte(memories.occurredAt, new Date(parsed.data.since)));
  }

  const rows = await db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(asc(memories.occurredAt))
    .limit(parsed.data.limit);

  return c.json({
    workspace_id: parsed.data.workspace_id,
    count: rows.length,
    memories: rows.map((r) => ({
      id: r.id,
      machine_id: r.machineId,
      event_type: r.eventType,
      payload: r.payload,
      occurred_at: r.occurredAt,
    })),
  });
});

// ─── Boot ───────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`bridge api listening on http://localhost:${info.port}`);
});
