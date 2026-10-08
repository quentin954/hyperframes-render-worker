// HTTP render job API.
// GET  /jobs → 200 json{ count, jobs }
// POST /jobs  { files: [{ path, content: base64 }], workers? } → 202 json{ job }
// GET  /jobs/:id → 200 json{ job }
// GET  /jobs/:id/output → 200 video/mp4
// DELETE /jobs/:id → 200 json{ deleted } | 202 json{ deleting }
// GET  /queue → 200 json{ running, queued, jobs }
// GET  /healthz → 200 "ok"

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const FPS = 60;
const QUALITY = process.env.RENDER_QUALITY ?? "standard";
const ENTRY_FILE = process.env.ENTRY_FILE ?? "index.html";
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 0);
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
  const { compDir, outFile, controller, timedOut, cancelRequested, ...record } = job;
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
    job.failedStage ??= job.stage ?? "pipeline";
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
    progress: job.progress ?? 0,
    stage: job.stage ?? null,
    totalFrames: job.totalFrames ?? null,
    capturedFrames: job.capturedFrames ?? null,
    size: job.size ?? null,
    error: job.error ?? null,
  };
  const pos = positionOf(job.jobId);
  if (pos !== null) view.position = pos;
  if (job.status === "complete") view.download = `/jobs/${job.jobId}/output`;
  if (job.failedStage) view.failedStage = job.failedStage;
  if (job.errorDetails) view.errorDetails = job.errorDetails;
  return view;
}

async function runRender(job) {
  const request = createRenderJob({
    fps: FPS,
    quality: QUALITY,
    entryFile: ENTRY_FILE,
    workers: job.workers ?? undefined,
  });

  const timer =
    RENDER_TIMEOUT_MS > 0
      ? setTimeout(() => {
          job.timedOut = true;
          job.controller.abort();
        }, RENDER_TIMEOUT_MS)
      : null;

  try {
    await executeRenderJob(request, job.compDir, job.outFile, (current) => {
      job.status = current.status;
      job.progress = current.progress;
      if (!TERMINAL.has(current.status)) job.stage = current.currentStage;
      job.totalFrames = current.totalFrames ?? null;
      job.capturedFrames = current.framesRendered ?? null;
      // Failure diagnostics ride on the job, not the thrown error.
      if (current.errorDetails) job.errorDetails = current.errorDetails;
      if (current.failedStage) job.failedStage = current.failedStage;
    }, job.controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function execute(job) {
  running = job.jobId;
  job.status = "rendering";
  job.startedAt = Date.now();
  job.controller = new AbortController();
  await writeJobFile(job);
  try {
    await runRender(job);
    job.size = (await stat(job.outFile)).size;
    job.status = "complete";
    job.progress = 100;
  } catch (err) {
    // A timeout abort and a client DELETE both surface as `cancelled`, so the
    // abort site sets the flag that tells them apart.
    if (job.timedOut) {
      job.status = "failed";
      job.error = `render exceeded RENDER_TIMEOUT_MS (${RENDER_TIMEOUT_MS})`;
      console.error(`[job ${job.jobId}] failed\n${job.error}`);
    } else if (!job.cancelRequested) {
      job.error = err instanceof Error ? err.message : String(err);
      job.status = "failed";
      console.error(`[job ${job.jobId}] failed\n${job.error}`);
      if (job.failedStage) console.error(`[job ${job.jobId}] failed in stage: ${job.failedStage}`);
      if (job.errorDetails?.browserConsoleTail) {
        console.error(`[job ${job.jobId}] browser console tail:\n${job.errorDetails.browserConsoleTail.join("\n")}`);
      }
    }
  } finally {
    job.controller = null;
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
    job.cancelRequested = true;
    job.status = "cancelled";
    job.error = "cancelled by client";
    job.finishedAt = Date.now();
    job.controller?.abort();
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
    progress: 0,
    stage: null,
    totalFrames: null,
    capturedFrames: null,
    size: null,
    error: null,
    failedStage: null,
    errorDetails: null,
    timedOut: false,
    cancelRequested: false,
    controller: null,
  });
  await writeJobFile(job);
  jobs.set(jobId, job);
  pending.push(jobId);
  pump();

  json(res, 202, publicJob(job));
}

function jobListing(job) {
  const entry = {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
    size: job.size ?? null,
  };
  if (job.status === "complete") entry.download = `/jobs/${job.jobId}/output`;
  return entry;
}

function jobList() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(jobListing);
}

function queueSnapshot() {
  const listed = [];
  const runningJob = running === null ? null : jobs.get(running);
  if (runningJob) {
    listed.push({ jobId: runningJob.jobId, status: runningJob.status, workers: runningJob.workers ?? null });
  }
  pending.forEach((jobId, i) => {
    const job = jobs.get(jobId);
    if (job) listed.push({ jobId, status: job.status, workers: job.workers ?? null, position: i + 1 });
  });
  return { running: runningJob ? 1 : 0, queued: pending.length, jobs: listed };
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
    if (req.method === "GET" && path === "/queue") {
      json(res, 200, queueSnapshot());
      return;
    }
    if (req.method === "GET" && path === "/jobs") {
      const listed = jobList();
      return json(res, 200, { count: listed.length, jobs: listed });
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
