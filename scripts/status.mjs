// Usage: node scripts/status.mjs <jobId> [host] [port]
// Resume a job from another terminal, hours after submitting it.

import { argv } from "node:process";
import { connection, run, status } from "./render-client.mjs";

await run(async () => {
  const jobId = argv[2];
  if (!jobId) {
    console.error("usage: node scripts/status.mjs <jobId> [host] [port]");
    process.exit(1);
  }

  const { base, host, port } = connection([argv[3], argv[4]]);
  const job = await status(base, jobId);
  if (job === null) {
    console.error(`unknown job ${jobId} on ${host}:${port}`);
    process.exit(1);
  }

  console.log(JSON.stringify(job, null, 2));
  if (job.status === "complete") console.log(`\ndownload: node scripts/download.mjs ${jobId}`);
});
