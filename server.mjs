import { createServer } from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateStore } from "./lib/state.mjs";
import { createDeviceStore } from "./lib/device-store.mjs";

const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = join(rootDir, "public");
const distDir = join(rootDir, "dist");
const staticDir =
  process.env.NODE_ENV === "development" || !existsSync(join(distDir, "index.html"))
    ? publicDir
    : distDir;

const dataDir = resolve(process.env.DATA_DIR ?? join(rootDir, "data"));
const dataFile = process.env.DATA_FILE ?? join(dataDir, "responses.ndjson");
const stateFile = process.env.STATE_FILE ?? join(dataDir, "state.json");
const deviceIndexDir = process.env.DEVICE_INDEX_DIR ?? join(dataDir, "device-index");
const adminToken = process.env.ADMIN_TOKEN ?? "";
const cookieSecure = process.env.COOKIE_SECURE === "1" ||
  (process.env.COOKIE_SECURE !== "0" && process.env.NODE_ENV === "production");
const DEVICE_COOKIE = "shams_device";
const DEVICE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const DUPLICATE_MESSAGE = "You have already submitted your response from this device.";
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const SESSION_TTL_MS = 15 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_FILL_MS = 700;
const MAX_BODY_BYTES = 4096;
const MAX_NAME_LENGTH = 80;
const MAX_COMMENT_LENGTH = 240;
const RATE_LIMITS = {
  session: { windowMs: 10 * 60 * 1000, max: 30 },
  submission: { windowMs: 10 * 60 * 1000, max: 5 },
  adminLogin: { windowMs: 10 * 60 * 1000, max: 5 }
};

const state = await createStateStore(stateFile);
const clientSalt = state.getClientSalt();

await mkdir(dirname(dataFile), { recursive: true, mode: 0o700 });

const devices = createDeviceStore({
  secret: state.getDeviceSecret(),
  indexDir: deviceIndexDir
});

const deviceRecords = new Map();
for (const record of await readResponses()) {
  if (typeof record.deviceHash === "string") {
    deviceRecords.set(record.deviceHash, record.answer);
  }
}
await devices.initialize(Array.from(deviceRecords.keys()));

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'"
};

const staticAssets = new Map([
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/favicon.ico", ["favicon.svg", "image/svg+xml"]],
  ["/assets/candidate-photo.svg", ["assets/candidate-photo.svg", "image/svg+xml"]],
  ["/assets/candidate-photo.jpg", ["assets/candidate-photo.jpg", "image/jpeg"]],
  ["/assets/election-symbol.svg", ["assets/election-symbol.svg", "image/svg+xml"]],
  ["/assets/election-symbol.jpg", ["assets/election-symbol.jpg", "image/jpeg"]],
  ["/admin.css", ["admin.css", "text/css; charset=utf-8"]],
  ["/admin.js", ["admin.js", "text/javascript; charset=utf-8"]]
]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...securityHeaders,
    ...extraHeaders
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...securityHeaders
  });
  res.end(body);
}

function download(res, status, contentType, body, filename) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${filename}"`,
    ...securityHeaders
  });
  res.end(body);
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const useForwarded = process.env.TRUST_PROXY === "1";
  const remote = useForwarded && typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress ?? "unknown";

  return createHash("sha256").update(clientSalt).update(remote).digest("hex");
}

async function checkRateLimit(clientKey, kind) {
  const now = Date.now();
  const config = RATE_LIMITS[kind];
  const key = `${kind}:${clientKey}`;
  const bucket = state.getRate(key);

  if (!bucket || bucket.resetAt <= now) {
    await state.setRate(key, { count: 1, resetAt: now + config.windowMs });
    return true;
  }

  if (bucket.count >= config.max) return false;

  await state.setRate(key, { count: bucket.count + 1, resetAt: bucket.resetAt });
  return true;
}

function originAllowed(req) {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return false;

  const origin = req.headers.origin;
  if (!origin) return true;

  const hostHeader = req.headers.host;
  if (!hostHeader) return false;

  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

async function createSession(req) {
  await state.cleanup();
  const clientKey = getClientKey(req);

  if (!await checkRateLimit(clientKey, "session")) {
    return { error: "Too many page requests. Please try again shortly." };
  }

  const token = randomBytes(24).toString("base64url");
  const now = Date.now();
  await state.addSession(token, {
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    clientKey
  });

  return { token };
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        rejectBody(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!tooLarge) resolveBody(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", rejectBody);
  });
}

async function servePage(res, filename) {
  try {
    const html = await readFile(join(staticDir, filename), "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-store",
      ...securityHeaders
    });
    res.end(html);
  } catch {
    text(res, 404, "Not found");
  }
}

async function serveHtml(req, res) {
  const session = await createSession(req);
  if (session.error) {
    return json(res, 429, { message: session.error });
  }

  ensureDevice(req, res);

  const template = await readFile(join(staticDir, "index.html"), "utf8");
  const html = template.replace("__SURVEY_TOKEN__", escapeHtml(session.token));

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    ...securityHeaders
  });
  res.end(html);
}

async function serveStatic(res, filename, contentType) {
  try {
    const body = await readFile(join(staticDir, filename));
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      ...securityHeaders
    });
    res.end(body);
  } catch {
    text(res, 404, "Not found");
  }
}

async function handleSurveySession(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { message: "Method not allowed." });
  }

  const session = await createSession(req);
  if (session.error) {
    return json(res, 429, { message: session.error });
  }

  ensureDevice(req, res);
  return json(res, 200, { token: session.token });
}

async function handleSurveyStatus(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { message: "Method not allowed." });
  }

  const token = ensureDevice(req, res);
  const hash = devices.hashToken(token);

  return json(res, 200, {
    submitted: devices.hasSubmitted(hash),
    answer: deviceRecords.get(hash) ?? null
  });
}

async function handleSubmission(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { message: "Method not allowed." });
  }

  if (!originAllowed(req)) {
    return json(res, 403, { message: "Invalid request origin." });
  }

  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return json(res, 415, { message: "Invalid request format." });
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    return json(res, error.status ?? 400, { message: error.message ?? "Invalid request." });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(res, 400, { message: "Invalid submission." });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json(res, 400, { message: "Invalid submission." });
  }

  const { name, answer, token, website, comment } = payload;

  if (comment !== undefined && typeof comment !== "string") {
    return json(res, 400, { message: "Invalid submission." });
  }
  const cleanComment = typeof comment === "string" ? comment.trim() : "";
  if (cleanComment.length > MAX_COMMENT_LENGTH) {
    return json(res, 400, { message: `Please keep your comment under ${MAX_COMMENT_LENGTH} characters.` });
  }

  if (website !== undefined && (typeof website !== "string" || website.trim() !== "")) {
    return json(res, 400, { message: "Invalid submission." });
  }

  if (typeof name !== "string") {
    return json(res, 400, { message: "Please enter your name." });
  }
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > MAX_NAME_LENGTH) {
    return json(res, 400, { message: `Please enter a name up to ${MAX_NAME_LENGTH} characters.` });
  }

  if (answer !== "yes" && answer !== "no") {
    return json(res, 400, { message: "Please select a valid response." });
  }

  const deviceToken = getDeviceToken(req);
  if (!deviceToken) {
    return json(res, 403, { message: "Your survey session is invalid. Please reload the page." });
  }

  const deviceHash = devices.hashToken(deviceToken);
  if (devices.hasSubmitted(deviceHash)) {
    return duplicateResponse(res);
  }

  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
    return json(res, 403, { message: "Your survey session is invalid. Please reload the page." });
  }

  await state.cleanup();

  const session = state.getSession(token);
  if (!session) {
    return json(res, 403, { message: "Your survey session is invalid. Please reload the page." });
  }

  const clientKey = getClientKey(req);
  if (session.clientKey !== clientKey) {
    return json(res, 403, { message: "Your survey session is invalid. Please reload the page." });
  }

  if (Date.now() - session.createdAt < MIN_FILL_MS) {
    return json(res, 429, { message: "Please take a moment to review the question before submitting." });
  }

  if (!await checkRateLimit(clientKey, "submission")) {
    return json(res, 429, { message: "Too many submissions. Please try again later." });
  }

  if (!await devices.claim(deviceHash)) {
    return duplicateResponse(res);
  }

  await state.removeSession(token);

  const record = {
    id: randomUUID(),
    name: cleanName,
    answer,
    ...(cleanComment ? { comment: cleanComment } : {}),
    deviceHash,
    submittedAt: new Date().toISOString()
  };

  try {
    await appendFile(dataFile, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch (error) {
    await devices.release(deviceHash);
    await state.addSession(token, session);
    console.error("Failed to persist survey response", error);
    return json(res, 500, { message: "We could not save your response. Please try again." });
  }

  deviceRecords.set(deviceHash, answer);

  return json(res, 201, { ok: true, message: "Response recorded." });
}

function adminEnabled() {
  return adminToken.length > 0;
}

function safeEqual(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key) cookies[key] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function getDeviceToken(req) {
  const token = parseCookies(req)[DEVICE_COOKIE];
  return devices.isValidToken(token) ? token : null;
}

function ensureDevice(req, res) {
  const existing = getDeviceToken(req);
  if (existing) return existing;

  const token = devices.issueToken();
  const parts = [
    `${DEVICE_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${DEVICE_COOKIE_MAX_AGE}`
  ];
  if (cookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
  return token;
}

function duplicateResponse(res) {
  return json(res, 409, { message: DUPLICATE_MESSAGE });
}

async function currentAdmin(req) {
  if (!adminEnabled()) return null;
  const id = parseCookies(req).shams_admin;
  if (!id || !/^[A-Za-z0-9_-]{32}$/.test(id)) return null;
  const session = state.getAdminSession(id);
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
}

function setAdminCookie(res, id, maxAge) {
  const parts = [
    `shams_admin=${id}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`
  ];
  if (cookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function handleAdminLogin(req, res) {
  if (!adminEnabled()) {
    return json(res, 503, { message: "Admin access is not configured." });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { message: "Method not allowed." });
  }

  if (!originAllowed(req)) {
    return json(res, 403, { message: "Invalid request origin." });
  }

  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return json(res, 415, { message: "Invalid request format." });
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    return json(res, error.status ?? 400, { message: error.message ?? "Invalid request." });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(res, 400, { message: "Invalid submission." });
  }

  if (!await checkRateLimit(getClientKey(req), "adminLogin")) {
    return json(res, 429, { message: "Too many login attempts. Please try again later." });
  }

  const token = payload?.token;
  if (typeof token !== "string" || !safeEqual(token, adminToken)) {
    return json(res, 401, { message: "Invalid admin token." });
  }

  const id = randomBytes(24).toString("base64url");
  const now = Date.now();
  await state.cleanup();
  await state.addAdminSession(id, {
    createdAt: now,
    expiresAt: now + ADMIN_SESSION_TTL_MS
  });
  setAdminCookie(res, id, Math.floor(ADMIN_SESSION_TTL_MS / 1000));

  return json(res, 200, { ok: true });
}

async function handleAdminSession(req, res) {
  if (!adminEnabled()) {
    return json(res, 503, { message: "Admin access is not configured." });
  }
  await state.cleanup();
  return json(res, 200, { authenticated: Boolean(await currentAdmin(req)) });
}

async function handleAdminLogout(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { message: "Method not allowed." });
  }

  const id = parseCookies(req).shams_admin;
  if (id) await state.removeAdminSession(id);
  setAdminCookie(res, "", 0);

  return json(res, 200, { ok: true });
}

function firstStringField(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function readResponses() {
  let content;
  try {
    content = await readFile(dataFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || !["yes", "no", "other"].includes(record.answer)) {
        continue;
      }

      records.push({
        ...record,
        id: typeof record.id === "string" ? record.id : "",
        name: firstStringField(record, ["name", "voterName", "respondentName", "fullName", "submittedBy"]),
        submittedAt: typeof record.submittedAt === "string" ? record.submittedAt : ""
      });
    } catch {
      continue;
    }
  }
  return records;
}

async function requireAdmin(req, res) {
  if (!adminEnabled()) {
    json(res, 503, { message: "Admin access is not configured." });
    return null;
  }
  if (!await currentAdmin(req)) {
    json(res, 401, { message: "Admin authentication required." });
    return null;
  }
  return true;
}

async function handleResults(req, res) {
  if (!await requireAdmin(req, res)) return;

  const records = await readResponses();
  const counts = { yes: 0, no: 0, other: 0 };
  let firstSubmittedAt = null;
  let lastSubmittedAt = null;

  for (const record of records) {
    counts[record.answer] += 1;

    const value = record.submittedAt;
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
      if (!firstSubmittedAt || value < firstSubmittedAt) firstSubmittedAt = value;
      if (!lastSubmittedAt || value > lastSubmittedAt) lastSubmittedAt = value;
    }
  }

  const responses = records
    .map((record) => ({
      id: record.id,
      name: record.name || "Not provided",
      answer: record.answer,
      submittedAt: record.submittedAt
    }))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));

  return json(res, 200, {
    total: records.length,
    counts,
    responses,
    firstSubmittedAt,
    lastSubmittedAt,
    generatedAt: new Date().toISOString()
  });
}

function csvCell(value) {
  let cell = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}

async function handleResultsExport(req, res) {
  if (!await requireAdmin(req, res)) return;

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const format = url.searchParams.get("format") ?? "csv";
  const records = await readResponses();

  if (format === "json" || format === "ndjson") {
    const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
    return download(
      res,
      200,
      "application/x-ndjson; charset=utf-8",
      body,
      "shams-responses.ndjson"
    );
  }

  const rows = [["id", "name", "answer", "comment", "deviceHash", "submittedAt"].map(csvCell).join(",")];
  for (const record of records) {
    rows.push([
      record.id,
      record.name,
      record.answer,
      typeof record.comment === "string" ? record.comment : "",
      record.deviceHash ?? "",
      record.submittedAt
    ].map(csvCell).join(","));
  }
  return download(
    res,
    200,
    "text/csv; charset=utf-8",
    `${rows.join("\r\n")}\r\n`,
    "shams-responses.csv"
  );
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/health" && req.method === "GET") {
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/survey/session") {
      return handleSurveySession(req, res);
    }

    if (pathname === "/api/survey/status") {
      return handleSurveyStatus(req, res);
    }

    if (pathname === "/api/responses") {
      return handleSubmission(req, res);
    }

    if (pathname === "/api/admin/login") {
      return handleAdminLogin(req, res);
    }

    if (pathname === "/api/admin/session" && req.method === "GET") {
      return handleAdminSession(req, res);
    }

    if (pathname === "/api/admin/logout") {
      return handleAdminLogout(req, res);
    }

    if (pathname === "/api/results" && req.method === "GET") {
      return handleResults(req, res);
    }

    if (pathname === "/api/results/export" && req.method === "GET") {
      return handleResultsExport(req, res);
    }

    if (pathname === "/admin" || pathname === "/admin.html") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        return json(res, 405, { message: "Method not allowed." });
      }
      return servePage(res, "admin.html");
    }

    if (pathname === "/" || pathname === "/index.html") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        return json(res, 405, { message: "Method not allowed." });
      }
      return serveHtml(req, res);
    }

    const asset = staticAssets.get(pathname);
    if (asset) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        return json(res, 405, { message: "Method not allowed." });
      }
      return serveStatic(res, asset[0], asset[1]);
    }

    return text(res, 404, "Not found");
  } catch (error) {
    console.error("Request failed", error);
    if (!res.headersSent) return json(res, 500, { message: "Unexpected server error." });
    return res.end();
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  console.log(`Survey portal listening on http://${host}:${activePort}`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
