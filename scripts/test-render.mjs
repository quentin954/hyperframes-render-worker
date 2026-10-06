// Usage: node test-render.mjs <port> <output.mp4>

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { argv } from "node:process";

const port = Number(argv[2] ?? 18080);
const outFile = argv[3] ?? "test-render.mp4";

const serverHost = "192.168.1.77";
const projectRoot = ".";

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    // Ignore hidden files/directories.
    if (entry.name.startsWith(".")) {
      continue;
    }

    // Ignore generated video files.
    if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".mp4")
    ) {
      continue;
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else {
      // IMPORTANT:
      // Node on Windows returns paths with "\"
      // but the Linux server needs "/".
      const relPath = relative(projectRoot, fullPath)
        .replaceAll("\\", "/");

      files.push(relPath);
    }
  }

  return files;
}

const files = await collectFiles(projectRoot);

console.log(`[test] found ${files.length} files`);
console.log("");
console.log("[test] files being sent:");

for (const file of files) {
  console.log(`  ${file}`);
}

const encodedFiles = await Promise.all(
  files.map(async (filePath) => ({
    path: filePath,
    content: (await readFile(filePath)).toString("base64"),
  })),
);

console.log("");
console.log(
  `[test] sending ${encodedFiles.length} files to ${serverHost}:${port}/render`,
);

const t0 = Date.now();

const res = await fetch(
  `http://${serverHost}:${port}/render`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      files: encodedFiles,
    }),
  },
);

if (!res.ok) {
  const body = await res.text();

  console.error(`[test] FAIL ${res.status}: ${body}`);
  process.exit(1);
}

const mp4 = Buffer.from(await res.arrayBuffer());

await writeFile(outFile, mp4);

console.log(
  `[test] OK in ${Date.now() - t0}ms — ` +
  `wrote ${mp4.length} bytes to ${outFile} ` +
  `(server reported ${res.headers.get("x-render-duration-ms")}ms)`,
);