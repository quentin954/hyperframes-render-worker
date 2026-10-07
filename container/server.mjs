// HTTP render job API.
// POST /jobs  { files: [{ path, content: base64 }], workers? } → 202 json{ job }
// GET  /jobs/:id → 200 json{ job }
// GET  /jobs/:id/output → 200 video/mp4
// DELETE /jobs/:id → 200 json{ deleted } | 202 json{ deleting }
// GET  /healthz → 200 "ok"

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const HYPERFRAMES_BIN = resolve("node_modules/.bin/hyperframes");
const FPS = 60;
const ABSOLUTE_MAX_WORKERS = 24;
const TERMINAL = new Set(["complete", "failed", "cancelled"]);

const jobs = new Map();
const pending = [];
let running = null;

function readBody(req, max = 2 * 1024 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error(`request body exceeded ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Reject paths that escape the workdir before any fs touch — the Worker's
// file list is trusted, but path traversal is the kind of footgun that's
// cheaper to reject everywhere than to reason about per-caller.
function safeJoin(root, rel) {
  const abs = resolve(root, rel);
  const rootSep = root.endsWith(sep) ? root : root + sep;
  if (!abs.startsWith(rootSep)) {
    throw new Error(`path escapes root: ${rel}`);
  }
  return abs;
}

function writeFiles(workdir, files) {
  return Promise.all(
    files.map(async (f) => {
      const abs = safeJoin(workdir, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.from(f.content, "base64"));
    }),
  );
}

function jobDir(jobId) {
  return join(DATA_DIR, "jobs", jobId);
}

async function writeJobFile(job) {
  const target = join(jobDir(job.jobId), "job.json");
  const tmp = `${target}.tmp`;
  const { compDir, outFile, workRoot, child, ...record } = job;
  await writeFile(tmp, JSON.stringify(record, null, 2));
  await rename(tmp, target);
}

function rehydrate(job) {
  return {
    ...job,
    compDir: join(jobDir(job.jobId), "project"),
    outFile: join(jobDir(job.jobId), "output.mp4"),
  };
}

async function recoverJobs() {
  let entries;
  try {
    entries = await readdir(join(DATA_DIR, "jobs"), { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    await mkdir(join(DATA_DIR, "jobs"), { recursive: true });
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let job;
    try {
      job = JSON.parse(await readFile(join(DATA_DIR, "jobs", entry.name, "job.json"), "utf8"));
    } catch {
      continue;
    }
    if (TERMINAL.has(job.status)) {
      jobs.set(job.jobId, rehydrate(job));
      continue;
    }
    job.status = "failed";
    job.error = "interrupted by a server restart";
    job.finishedAt = Date.now();
    const revived = rehydrate(job);
    jobs.set(job.jobId, revived);
    await writeJobFile(revived);
  }
}

function resolveWorkers(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, ABSOLUTE_MAX_WORKERS);
}

function positionOf(jobId) {
  const idx = pending.indexOf(jobId);
  return idx === -1 ? null : idx + 1;
}

function publicJob(job) {
  const view = {
    jobId: job.jobId,
    status: job.status,
    workers: job.workers ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: job.startedAt ? (job.finishedAt ?? Date.now()) - job.startedAt : 0,
    size: job.size ?? null,
    error: job.error ?? null,
  };
  const pos = positionOf(job.jobId);
  if (pos !== null) view.position = pos;
  if (job.status === "complete") view.download = `/jobs/${job.jobId}/output`;
  return view;
}

function runRender(job, onSpawn) {
  const args = ["render", job.compDir, "-o", job.outFile, "--fps", String(FPS), "--workers", job.workers ?? "auto"];
  return new Promise((resolveRun, reject) => {
    const child = spawn(HYPERFRAMES_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    onSpawn(child);

    const stderrChunks = [];
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => {
      stderrChunks.push(d);
      process.stderr.write(d);
    });

    let killTimer = null;
    const timeoutTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      reject(new Error(`render timed out after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) resolveRun();
      else
        reject(
          new Error(`hyperframes render exited ${code}\n${Buffer.concat(stderrChunks).toString()}`),
        );
    });
  });
}

async function execute(job) {
  running = job.jobId;
  job.status = "rendering";
  job.startedAt = Date.now();
  await writeJobFile(job);
  try {
    await runRender(job, (child) => {
      job.child = child;
    });
    job.size = (await stat(job.outFile)).size;
    job.status = "complete";
  } catch (err) {
    if (job.status !== "cancelled") {
      job.error = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      console.error(`[job ${job.jobId}] failed\n${job.error}`);
    }
  } finally {
    job.child = null;
    job.finishedAt = Date.now();
    await writeJobFile(job).catch((err) => console.error(`[job ${job.jobId}] persist failed`, err));
    running = null;
    pump();
  }
}

async function handleDeleteJob(job, res) {
  const idx = pending.indexOf(job.jobId);
  if (idx !== -1) pending.splice(idx, 1);

  if (!TERMINAL.has(job.status)) {
    job.status = "cancelled";
    job.error = "cancelled by client";
    job.finishedAt = Date.now();
    if (job.child) {
      job.child.kill("SIGTERM");
      setTimeout(() => job.child?.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }
    await writeJobFile(job).catch(() => {});
  }

  jobs.delete(job.jobId);
  purgeJobDir(job.jobId, res);
}

function purgeJobDir(jobId, res) {
  rm(jobDir(jobId), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).then(
    () => {
      if (res.headersSent) return;
      json(res, 200, { jobId, status: "deleted" });
    },
    (err) => {
      console.error(`[job ${jobId}] purge failed: ${err.message}`);
      if (res.headersSent) return;
      json(res, 202, { jobId, status: "deleting", note: "renderer still flushing its files" });
    },
  );
}

async function handleJobOutput(job, res) {
  if (job.status !== "complete") {
    return json(res, 409, { error: `job is ${job.status}`, status: job.status });
  }
  const { size } = await stat(job.outFile);
  res.writeHead(200, {
    "content-type": "video/mp4",
    "content-length": size,
    "content-disposition": `attachment; filename="${job.jobId}.mp4"`,
  });
  createReadStream(job.outFile).on("error", (err) => res.destroy(err)).pipe(res);
}

function pump() {
  if (running !== null) return;
  const jobId = pending.shift();
  if (jobId === undefined) return;
  const job = jobs.get(jobId);
  if (job && !TERMINAL.has(job.status)) void execute(job);
  else pump();
}

async function handleCreateJob(req, res) {
  const raw = await readBody(req);
  const body = JSON.parse(raw.toString("utf8"));
  if (!Array.isArray(body?.files) || body.files.length === 0) {
    throw new Error("body.files must be a non-empty array");
  }

  const jobId = randomUUID();
  const compDir = join(jobDir(jobId), "project");
  try {
    await mkdir(compDir, { recursive: true });
    await writeFiles(compDir, body.files);
  } catch (err) {
    await rm(jobDir(jobId), { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const job = rehydrate({
    jobId,
    status: "queued",
    workers: resolveWorkers(body.workers),
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    size: null,
    error: null,
    child: null,
  });
  await writeJobFile(job);
  jobs.set(jobId, job);
  pending.push(jobId);
  pump();

  json(res, 202, publicJob(job));
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;

  try {
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method === "POST" && path === "/jobs") {
      await handleCreateJob(req, res);
      return;
    }
    const jobMatch = /^\/jobs\/([^/]+)$/.exec(path);
    if (jobMatch && req.method === "GET") {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { error: "unknown job" });
      return json(res, 200, publicJob(job));
    }
    if (jobMatch && req.method === "DELETE") {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { error: "unknown job" });
      return await handleDeleteJob(job, res);
    }
    const outputMatch = /^\/jobs\/([^/]+)\/output$/.exec(path);
    if (outputMatch && req.method === "GET") {
      const job = jobs.get(outputMatch[1]);
      if (!job) return json(res, 404, { error: "unknown job" });
      return await handleJobOutput(job, res);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[request] failed", message);
    if (res.headersSent) return res.destroy();
    return json(res, 400, { error: message });
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

await recoverJobs();
server.listen(PORT, () => {
  console.log(`[render-server] listening on :${PORT} data=${join(DATA_DIR, "jobs")}`);
});
