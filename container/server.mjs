// HTTP render job API.
// POST /jobs  { files: [{ path, content: base64 }], workers? } → 202 json{ job }
// GET  /jobs/:id → 200 json{ job }
// GET  /healthz → 200 "ok"

import { createServer } from "node:http";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
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
    running = null;
    pump();
  }
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
  const workRoot = await mkdtemp(join(tmpdir(), "render-"));
  const compDir = join(workRoot, "composition");
  await mkdir(compDir, { recursive: true });
  await writeFiles(compDir, body.files);

  const job = {
    jobId,
    status: "queued",
    workers: resolveWorkers(body.workers),
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    size: null,
    error: null,
    workRoot,
    compDir,
    outFile: join(workRoot, "out.mp4"),
  };
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[request] failed", message);
    if (res.headersSent) return res.destroy();
    return json(res, 400, { error: message });
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`[render-server] listening on :${PORT}`);
});
