import {
  apiRequest,
  generateMachineId,
  readConfig,
  writeConfig,
  type BridgeConfig,
} from "../lib.js";

export async function loginCommand(
  apiKey: string,
  opts: { api: string }
): Promise<void> {
  const existing = readConfig();
  const config: BridgeConfig = {
    api_url: opts.api,
    api_key: apiKey,
    machine_id: existing?.machine_id ?? generateMachineId(),
  };

  // Verify by hitting the authenticated whoami endpoint. This actually
  // exercises the API key, so a typo or wrong key fails here instead of
  // silently saving bad creds.
  let whoami: { id: string; email: string };
  try {
    whoami = await apiRequest<{ id: string; email: string }>(
      config,
      "GET",
      "/v1/whoami"
    );
  } catch (err: any) {
    throw new Error(`Login failed: ${err.message}`);
  }

  writeConfig(config);
  console.log(`Logged in as ${whoami.email}`);
  console.log(`  Machine ID: ${config.machine_id}`);
  console.log(`  API:        ${config.api_url}`);
}
