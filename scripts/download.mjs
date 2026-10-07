// Usage: node scripts/download.mjs <jobId> [output.mp4] [host] [port]

import { argv } from "node:process";
import { connection, download, run, status } from "./render-client.mjs";

await run(async () => {
  const jobId = argv[2];
  if (!jobId) {
    console.error("usage: node scripts/download.mjs <jobId> [output.mp4] [host] [port]");
    process.exit(1);
  }

  const outFile = argv[3] ?? `${jobId}.mp4`;
  const { base, host, port } = connection([argv[4], argv[5]]);

  const job = await status(base, jobId);
  if (job === null) {
    console.error(`unknown job ${jobId} on ${host}:${port}`);
    process.exit(1);
  }
  if (job.status !== "complete") {
    console.error(`job is ${job.status}, nothing to download yet`);
    process.exit(1);
  }

  console.log(`wrote ${await download(base, jobId, outFile)} bytes to ${outFile}`);
});
