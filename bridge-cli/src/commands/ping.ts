import { apiRequest, requireConfig } from "../lib.js";

export async function pingCommand(): Promise<void> {
  const config = requireConfig();
  console.log(`Pinging ${config.api_url}…`);
  const t0 = Date.now();
  try {
    const whoami = await apiRequest<{ id: string; email: string }>(
      config,
      "GET",
      "/v1/whoami"
    );
    const elapsed = Date.now() - t0;
    console.log(`  OK · ${elapsed}ms · ${whoami.email}`);
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`  FAIL · ${elapsed}ms · ${err.message}`);
    process.exit(1);
  }
}
