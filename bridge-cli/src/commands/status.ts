import {
  buffer,
  findProjectRoot,
  pendingCount,
  readConfig,
  readProject,
} from "../lib.js";

export async function statusCommand(): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.log("Not logged in.  Run `bridge login <apiKey> --api <url>` first.");
    return;
  }
  console.log("Config");
  console.log(`  API URL:     ${config.api_url}`);
  console.log(`  API key:     ${maskKey(config.api_key)}`);
  console.log(`  Machine ID:  ${config.machine_id}`);

  const root = findProjectRoot();
  if (root) {
    const project = readProject(root);
    if (project) {
      console.log("");
      console.log("Project");
      console.log(`  Root:           ${root}`);
      console.log(`  Project hash:   ${project.project_id_hash}`);
      console.log(`  Workspace ID:   ${project.workspace_id}`);
    }
  } else {
    console.log("\nNo .bridge/project.json found in cwd or any parent. Run `bridge init` to set one up.");
  }

  const count = pendingCount();
  console.log("");
  console.log("Buffer");
  console.log(`  Pending events: ${count}`);

  if (count > 0) {
    const byType = buffer()
      .prepare(
        "SELECT event_type, COUNT(*) AS c FROM pending GROUP BY event_type ORDER BY c DESC"
      )
      .all() as Array<{ event_type: string; c: number }>;
    for (const row of byType) {
      console.log(`    ${row.event_type.padEnd(22)} ${row.c}`);
    }
  }
}

function maskKey(key: string): string {
  if (key.length < 12) return "***";
  return key.slice(0, 10) + "…" + key.slice(-4);
}
