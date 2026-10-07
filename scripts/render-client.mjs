// Shared job-API client for the render scripts.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { argv, env } from "node:process";

export function connection(extra = []) {
  const host = extra[0] ?? env.HF_TEST_HOST ?? "localhost";
  const raw = extra[1] ?? env.HF_TEST_PORT ?? "18080";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port "${raw}" — expected a number between 1 and 65535`);
  }
  return { base: `http://${host}:${port}`, host, port };
}

export async function req(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(`cannot reach ${url} — is the server up and the host right? (${err.cause?.code ?? err.message})`);
  }
}

export async function walkComposition(dir, root = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkComposition(full, root)));
    else files.push(relative(root, full).replaceAll("\\", "/"));
  }

  return files;
}

export async function encodeTree(dir, files) {
  return Promise.all(
    files.map(async (rel) => ({
      path: rel,
      content: (await readFile(join(dir, rel))).toString("base64"),
    })),
  );
}

export async function submit(base, files, workers) {
  const body = { files };
  if (workers !== undefined) body.workers = workers;
  const res = await req(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`submit failed ${res.status}: ${json.error}`);
  return json;
}

export async function status(base, jobId) {
  const res = await req(`${base}/jobs/${jobId}`);
  if (res.status === 404) return null;
  const json = await res.json();
  if (!res.ok) throw new Error(`status failed ${res.status}: ${json.error}`);
  return json;
}

const POLL_MS = Number(env.HF_POLL_MS ?? 10_000);

export async function poll(base, jobId, onTick) {
  for (;;) {
    const job = await status(base, jobId);
    if (job === null) throw new Error(`unknown job ${jobId}`);
    onTick(job);
    if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export function describe(job) {
  const stamp = new Date().toISOString().slice(11, 19);
  const bits = [`[${stamp}] ${job.status}`];
  if (job.position) bits.push(`position ${job.position}`);
  if (job.progress) bits.push(`${job.progress}%`);
  if (job.capturedFrames && job.totalFrames) bits.push(`${job.capturedFrames}/${job.totalFrames} frames`);
  if (job.workers) bits.push(`${job.workers} workers`);
  if (job.elapsedMs) bits.push(`${Math.round(job.elapsedMs / 1000)}s`);
  return bits.join(" — ");
}

export async function download(base, jobId, outFile) {
  const res = await req(`${base}/jobs/${jobId}/output`);
  if (!res.ok) {
    throw new Error(`download failed ${res.status}: ${await res.text()}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outFile, buf);
  return buf.length;
}

export function usage(defaultOutput) {
  const [a, b, c, d] = argv.slice(2);
  const root = resolve(a ?? ".");
  const outFile = b ?? defaultOutput;
  const { base, host, port } = connection([c, d]);
  return { root, outFile, base, host, port };
}

export async function run(main) {
  try {
    await main();
  } catch (err) {
    console.error(`[error] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
