import {
  apiRequest,
  buffer,
  pendingCount,
  requireConfig,
  type PendingRow,
} from "../lib.js";

const BATCH_SIZE = 50;
const WATCH_INTERVAL_MS = 10_000;

export async function syncCommand(opts: { watch?: boolean }): Promise<void> {
  await runSync();
  if (!opts.watch) return;

  console.log(`\nWatching — syncing every ${WATCH_INTERVAL_MS / 1000}s. Ctrl-C to stop.`);
  while (true) {
    await sleep(WATCH_INTERVAL_MS);
    try {
      await runSync({ quiet: true });
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] sync error: ${err.message}`);
    }
  }
}

async function runSync(opts: { quiet?: boolean } = {}): Promise<void> {
  const config = requireConfig();
  const total = pendingCount();
  if (total === 0) {
    if (!opts.quiet) console.log("Nothing to sync.");
    return;
  }
  if (!opts.quiet) console.log(`Syncing ${total} event${total === 1 ? "" : "s"}…`);

  let synced = 0;
  let deduped = 0;
  let failed = 0;
  const orphanedWorkspaces = new Set<string>();

  while (true) {
    const rows = buffer()
      .prepare(
        `SELECT id, client_event_id, workspace_id, machine_id, event_type, payload, occurred_at, attempts
           FROM pending ORDER BY id ASC LIMIT ?`
      )
      .all(BATCH_SIZE) as PendingRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        const res = await apiRequest<{ id: string; deduped?: boolean }>(
          config,
          "POST",
          "/v1/memories",
          {
            workspace_id: row.workspace_id,
            client_event_id: row.client_event_id,
            machine_id: row.machine_id,
            event_type: row.event_type,
            payload: JSON.parse(row.payload),
            occurred_at: row.occurred_at,
          }
        );
        buffer().prepare("DELETE FROM pending WHERE id = ?").run(row.id);
        if (res.deduped) deduped++;
        else synced++;
      } catch (err: any) {
        const msg = err.message ?? String(err);

        // 404 on workspace = workspace doesn't exist server-side anymore.
        // Don't retry; drop immediately and warn the user once.
        if (msg.includes("404") && msg.includes("workspace_not_found")) {
          buffer().prepare("DELETE FROM pending WHERE id = ?").run(row.id);
          failed++;
          orphanedWorkspaces.add(row.workspace_id);
          continue;
        }

        // Bump attempts; drop after 5 tries (likely malformed)
        const next = row.attempts + 1;
        if (next >= 5) {
          buffer().prepare("DELETE FROM pending WHERE id = ?").run(row.id);
          failed++;
          console.error(`  Dropped event ${row.id} (${row.event_type}) after 5 attempts: ${msg}`);
        } else {
          buffer()
            .prepare("UPDATE pending SET attempts = ? WHERE id = ?")
            .run(next, row.id);
          // Transient error — stop this batch, retry next sync
          if (!opts.quiet) {
            console.error(`  Pausing batch: ${msg}`);
          }
          return;
        }
      }
    }
  }

  if (orphanedWorkspaces.size > 0) {
    console.error(
      `  ${failed} event${failed === 1 ? "" : "s"} dropped — workspace ${
        [...orphanedWorkspaces].join(", ")
      } no longer exists on server. Re-run \`bridge init\` to recreate.`
    );
  }

  if (!opts.quiet || synced > 0 || deduped > 0) {
    const parts = [`Synced ${synced}`];
    if (deduped > 0) parts.push(`${deduped} already on server`);
    if (failed > 0 && orphanedWorkspaces.size === 0) parts.push(`${failed} dropped`);
    console.log(`  ${parts.join(", ")}.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
