import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = join(rootDir, "public");
const targetDir = join(rootDir, "dist");

const html = await readFile(join(sourceDir, "index.html"), "utf8");
if (!html.includes("__SURVEY_TOKEN__")) {
  throw new Error("index.html is missing the survey token placeholder");
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });

const files = await readdir(targetDir);
console.log(`Built ${files.length} static assets into dist/`);
