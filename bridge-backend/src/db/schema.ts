import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Users — one row per Bridge account.
 * v0 auth is a bearer API key. Replace with Clerk / Auth0 user IDs later.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  apiKey: text("api_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Workspaces — one row per (user, project).
 *
 * `projectIdHash` is the load-bearing column. The Bridge plugin computes it
 * once per repo as sha256(git remote get-url origin) and writes it to
 * .bridge/project-id. Every machine on the same git repo resolves to the
 * same workspace row — independent of absolute file path.
 *
 * This is the thing that breaks in Claude Sync / claude-memsync today.
 * Do not key memories by path.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectIdHash: text("project_id_hash").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    userProjectUnique: uniqueIndex("workspaces_user_project_unique").on(
      t.userId,
      t.projectIdHash
    ),
  })
);

/**
 * Memories — the append-only log of events the plugin captures.
 *
 * eventType ∈ {
 *   "session_start", "session_end",
 *   "user_prompt", "assistant_response",
 *   "tool_use", "file_edit",
 *   "decision", "note"
 * }
 *
 * payload is jsonb — schema varies by event type. Don't over-normalize in v0.
 *
 * clientEventId is the CLI's UUID for this event. Used for idempotent retries:
 * if the network drops between POST and ack, the CLI retries with the same
 * UUID and the backend dedupes via the (workspace_id, client_event_id) unique
 * index. Nullable so legacy clients still work.
 */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    clientEventId: text("client_event_id"),
    machineId: text("machine_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    workspaceTimeIdx: index("memories_workspace_time_idx").on(
      t.workspaceId,
      t.occurredAt
    ),
    clientIdemp: uniqueIndex("memories_client_idemp_unique").on(
      t.workspaceId,
      t.clientEventId
    ),
  })
);

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Memory = typeof memories.$inferSelect;

export const demoRequests = pgTable("demo_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company"),
  teamSize: text("team_size"),
  message: text("message"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type DemoRequest = typeof demoRequests.$inferSelect;
export type NewDemoRequest = typeof demoRequests.$inferInsert;
export type NewMemory = typeof memories.$inferInsert;
