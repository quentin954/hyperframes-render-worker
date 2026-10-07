// Usage: node scripts/submit-render.mjs [compositionDir] [output.mp4] [host] [port]
// Env:   HF_WORKERS pins the worker count (default: let the renderer decide).

import { env } from "node:process";
import { describe, download, encodeTree, poll, run, submit, usage, walkComposition } from "./render-client.mjs";

await run(async () => {
  const { root, outFile, base, host, port } = usage("render.mp4");

  const files = await walkComposition(root);
  console.log(`[render] ${files.length} files in ${root} -> ${host}:${port}`);

  const workers = env.HF_WORKERS ? Number(env.HF_WORKERS) : undefined;
  const job = await submit(base, await encodeTree(root, files), workers);
  console.log(`[render] job ${job.jobId} status=${job.status} workers=${job.workers ?? "auto"}`);

  const done = await poll(base, job.jobId, (j) => console.log(describe(j)));
  if (done.status !== "complete") {
    console.error(`[render] ${done.status}: ${done.error ?? "no error recorded"}`);
    process.exit(1);
  }

  console.log(`[render] wrote ${await download(base, job.jobId, outFile)} bytes to ${outFile}`);
});
