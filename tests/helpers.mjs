import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const freePort = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(freePort));
    });
  });
}

function waitForOutput(child, getStderr) {
  return new Promise((resolveOutput, rejectOutput) => {
    let output = "";
    const timer = setTimeout(() => rejectOutput(new Error(`Server did not start. ${getStderr()}`)), 10000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!output.includes("Survey portal listening")) return;
      clearTimeout(timer);
      resolveOutput(output);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectOutput(new Error(`Server exited with code ${code}. ${getStderr()}`));
    });
  });
}

export async function startServer(env = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "shams-survey-"));
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataFile = join(tempDir, "responses.ndjson");
  const stateFile = join(tempDir, "state.json");
  const currentEnv = {
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: tempDir,
    NODE_ENV: "development",
    TRUST_PROXY: "1",
    ...env
  };

  let child;
  let stderr = "";

  async function spawnChild() {
    stderr = "";
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: rootDir,
      env: { ...process.env, ...currentEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    await waitForOutput(child, () => stderr);
  }

  await spawnChild();

  return {
    origin,
    dataFile,
    stateFile,
    tempDir,

    async restart(overrides = {}) {
      child.kill();
      await new Promise((done) => child.once("exit", done));
      Object.assign(currentEnv, overrides);
      await spawnChild();
    },

    async stop() {
      child.kill();
      await new Promise((done) => child.once("exit", done));
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

function deviceCookieFrom(response) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.split(";").map((part) => part.trim()).find((part) => part.startsWith("shams_device="));
  assert.ok(match, "Response should set a device cookie");
  return match;
}

export async function getSession(origin, ip, cookie) {
  const response = await fetch(origin, {
    headers: {
      "x-forwarded-for": ip,
      ...(cookie ? { Cookie: cookie } : {})
    },
    cache: "no-store"
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  const token = html.match(/name="survey-token" content="([^"]+)"/)?.[1];
  assert.ok(token, "HTML should contain a survey token");
  return { token, cookie: cookie ?? deviceCookieFrom(response) };
}

export async function getStatus(origin, ip, cookie) {
  const response = await fetch(`${origin}/api/survey/status`, {
    headers: {
      "x-forwarded-for": ip,
      ...(cookie ? { Cookie: cookie } : {})
    },
    cache: "no-store"
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  return { ...data, cookie: cookie ?? deviceCookieFrom(response) };
}

export function postResponse(origin, payload, ip, extraHeaders = {}) {
  return fetch(`${origin}/api/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: origin,
      "x-forwarded-for": ip,
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  });
}

export function postJson(origin, path, payload, ip, extraHeaders = {}) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: origin,
      "x-forwarded-for": ip,
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  });
}
