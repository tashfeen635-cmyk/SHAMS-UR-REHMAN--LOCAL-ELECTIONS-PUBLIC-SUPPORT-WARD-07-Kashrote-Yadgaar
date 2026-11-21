import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createMongoStore } from "./mongo-store.mjs";

const DEVICE_COOKIE = "shams_device";
const DEVICE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const ADMIN_COOKIE = "shams_admin";
const DUPLICATE_MESSAGE = "You have already submitted your response from this device.";
const SESSION_TTL_MS = 15 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_FILL_MS = 700;
const MAX_BODY_BYTES = 4096;
const MAX_NAME_LENGTH = 80;
const MAX_COMMENT_LENGTH = 240;
const RATE_LIMITS = {
  session: { windowMs: 10 * 60 * 1000, max: 120 },
  submission: { windowMs: 10 * 60 * 1000, max: 5 },
  adminLogin: { windowMs: 10 * 60 * 1000, max: 5 }
};

function apiError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

let storePromise;

function getStore() {
  if (!storePromise) storePromise = createMongoStore();
  return storePromise;
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  };
}

function send(res, status, contentType, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries({ ...securityHeaders(), ...extraHeaders })) {
    res.setHeader(name, value);
  }
  res.end(body);
}

function json(res, status, payload, extraHeaders = {}) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(payload), extraHeaders);
}

function download(res, status, contentType, body, filename) {
  send(res, status, contentType, body, {
    "Content-Disposition": `attachment; filename="${filename}"`
  });
}

function cookieParts(name, value, maxAge) {
  const parts = [
    `${name}=${value}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`
  ];
  if (process.env.COOKIE_SECURE !== "0") parts.push("Secure");
  return parts.join("; ");
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

function getClientKey(store, req) {
  const forwarded = req.headers["x-forwarded-for"];
  const remote =
    process.env.TRUST_PROXY !== "0" && typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.socket?.remoteAddress ?? "unknown";

  return createHash("sha256").update(store.clientSalt).update(remote).digest("hex");
}

async function checkRateLimit(store, clientKey, kind) {
  const now = Date.now();
  const config = RATE_LIMITS[kind];
  const key = `${kind}:${clientKey}`;
  const bucket = await store.getRate(key);

  if (!bucket || bucket.resetAt <= now) {
    await store.setRate(key, { count: 1, resetAt: now + config.windowMs });
    return true;
  }

  if (bucket.count >= config.max) return false;

  await store.setRate(key, { count: bucket.count + 1, resetAt: bucket.resetAt });
  return true;
}

function originAllowed(req) {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return false;

  const origin = req.headers.origin;
  if (!origin) return true;

  const hostHeader = req.headers["x-forwarded-host"] ?? req.headers.host;
  if (!hostHeader) return false;

  try {
    return new URL(origin).host === hostHeader.split(",")[0].trim();
  } catch {
    return false;
  }
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

function getDeviceToken(store, req) {
  const token = parseCookies(req)[DEVICE_COOKIE];
  return store.devices.isValidToken(token) ? token : null;
}

function ensureDevice(store, req) {
  const existing = getDeviceToken(store, req);
  if (existing) return { token: existing, cookie: null };
  const token = store.devices.issueToken();
  return {
    token,
    cookie: cookieParts(DEVICE_COOKIE, token, DEVICE_COOKIE_MAX_AGE)
  };
}

function safeEqual(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function adminEnabled() {
  return Boolean(process.env.ADMIN_TOKEN);
}

async function currentAdmin(store, req) {
  if (!adminEnabled()) return null;
  const id = parseCookies(req)[ADMIN_COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{32}$/.test(id)) return null;
  const session = await store.getAdminSession(id);
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
}

async function requireAdmin(store, req, res) {
  if (!adminEnabled()) {
    json(res, 503, { message: "Admin access is not configured." });
    return false;
  }
  if (!await currentAdmin(store, req)) {
    json(res, 401, { message: "Admin authentication required." });
    return false;
  }
  return true;
}

async function handleHealth(req, res, url) {
  if (url.searchParams.get("db") !== "1") {
    return json(res, 200, { ok: true });
  }

  const store = await getStore();
  const count = (await store.readResponses()).length;
  return json(res, 200, { ok: true, db: true, responses: count });
}

async function issueSurveySession(store, req) {
  try {
    await store.cleanup();
    const clientKey = getClientKey(store, req);
    if (!await checkRateLimit(store, clientKey, "session")) {
      return { error: "Too many page requests. Please try again shortly." };
    }

    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    await store.addSession(token, {
      clientKey,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS
    });

    return { token };
  } catch (error) {
    throw apiError("SESSION_STORAGE_ERROR", "Survey session storage failed.", error);
  }
}

async function handleSurveySession(store, req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { message: "Method not allowed." });
  }

  const session = await issueSurveySession(store, req);
  if (session.error) {
    return json(res, 429, { message: session.error });
  }

  const device = ensureDevice(store, req);
  return json(res, 200, { token: session.token }, device.cookie ? { "Set-Cookie": device.cookie } : {});
}

async function handleSurveyStatus(store, req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { message: "Method not allowed." });
  }

  const device = ensureDevice(store, req);
  const hash = store.devices.hashToken(device.token);
  let record;
  try {
    record = await store.findResponse(hash);
  } catch (error) {
    throw apiError("STATUS_READ_ERROR", "Survey status read failed.", error);
  }
  const session = await issueSurveySession(store, req);

  return json(
    res,
    200,
    {
      submitted: Boolean(record),
      answer: record?.answer ?? null,
      ...(session.token ? { token: session.token } : {})
    },
    device.cookie ? { "Set-Cookie": device.cookie } : {}
  );
}

async function handleSubmission(store, req, res) {
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

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return json(res, error.status ?? 400, { message: error.message ?? "Invalid submission." });
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

  const deviceToken = getDeviceToken(store, req);
  if (!deviceToken) {
    return json(res, 403, { message: "Your survey session is invalid. Please reload the page." });
  }

  const deviceHash = store.devices.hashToken(deviceToken);
  if (await store.hasSubmitted(deviceHash)) {
    return json(res, 409, { message: DUPLICATE_MESSAGE });
  }

  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
    return json(res, 403, { message: "Your survey session is invalid. Please reload the page." });
  }

  await store.cleanup();
  const session = await store.getSession(token);
  if (!session) {
    return json(res, 403, { message: "Your survey session is invalid. Please reload the page." });
  }

  const clientKey = getClientKey(store, req);
  if (session.clientKey !== clientKey) {
    return json(res, 403, { message: "Your survey session is invalid. Please reload the page." });
  }

  if (Date.now() - session.createdAt < MIN_FILL_MS) {
    return json(res, 429, { message: "Please take a moment to review the question before submitting." });
  }

  if (!await checkRateLimit(store, clientKey, "submission")) {
    return json(res, 429, { message: "Too many submissions. Please try again later." });
  }

  const record = {
    id: randomUUID(),
    name: cleanName,
    answer,
    ...(cleanComment ? { comment: cleanComment } : {}),
    deviceHash,
    submittedAt: new Date().toISOString()
  };

  if (!await store.insertResponse(record)) {
    return json(res, 409, { message: DUPLICATE_MESSAGE });
  }

  await store.removeSession(token);
  return json(res, 201, { ok: true, message: "Response recorded." });
}

async function handleAdminLogin(store, req, res) {
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

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { message: "Invalid submission." });
  }

  if (!await checkRateLimit(store, getClientKey(store, req), "adminLogin")) {
    return json(res, 429, { message: "Too many login attempts. Please try again later." });
  }

  if (typeof payload?.token !== "string" || !safeEqual(payload.token, process.env.ADMIN_TOKEN)) {
    return json(res, 401, { message: "Invalid admin token." });
  }

  const id = randomBytes(24).toString("base64url");
  const now = Date.now();
  await store.cleanup();
  await store.addAdminSession(id, {
    createdAt: now,
    expiresAt: now + ADMIN_SESSION_TTL_MS
  });

  return json(res, 200, { ok: true }, {
    "Set-Cookie": cookieParts(ADMIN_COOKIE, id, Math.floor(ADMIN_SESSION_TTL_MS / 1000))
  });
}

async function handleAdminSession(store, req, res) {
  if (!adminEnabled()) {
    return json(res, 503, { message: "Admin access is not configured." });
  }
  await store.cleanup();
  return json(res, 200, { authenticated: Boolean(await currentAdmin(store, req)) });
}

async function handleAdminLogout(store, req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { message: "Method not allowed." });
  }

  const id = parseCookies(req)[ADMIN_COOKIE];
  if (id) await store.removeAdminSession(id);
  return json(res, 200, { ok: true }, { "Set-Cookie": cookieParts(ADMIN_COOKIE, "", 0) });
}

async function handleResults(store, req, res) {
  if (!await requireAdmin(store, req, res)) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { message: "Method not allowed." });
  }

  const records = await store.readResponses();
  const counts = { yes: 0, no: 0, other: 0 };
  let firstSubmittedAt = null;
  let lastSubmittedAt = null;

  for (const record of records) {
    if (record.answer in counts) counts[record.answer] += 1;
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

async function handleResultsExport(store, req, res) {
  if (!await requireAdmin(store, req, res)) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { message: "Method not allowed." });
  }

  const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
  const format = url.searchParams.get("format") ?? "csv";
  const records = await store.readResponses();

  if (format === "json" || format === "ndjson") {
    const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
    return download(res, 200, "application/x-ndjson; charset=utf-8", body, "shams-responses.ndjson");
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

export async function handle(req, res) {
  try {
    const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    if (pathname === "/api/health") return await handleHealth(req, res, url);

    const store = await getStore();

    if (pathname === "/api/survey/session") return await handleSurveySession(store, req, res);
    if (pathname === "/api/survey/status") return await handleSurveyStatus(store, req, res);
    if (pathname === "/api/responses") return await handleSubmission(store, req, res);
    if (pathname === "/api/admin/login") return await handleAdminLogin(store, req, res);
    if (pathname === "/api/admin/session") return await handleAdminSession(store, req, res);
    if (pathname === "/api/admin/logout") return await handleAdminLogout(store, req, res);
    if (pathname === "/api/results") return await handleResults(store, req, res);
    if (pathname === "/api/results/export") return await handleResultsExport(store, req, res);

    return json(res, 404, { message: "Not found." });
  } catch (error) {
    console.error("Vercel API request failed", error);
    const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
    const message =
      code === "CONFIG_ERROR"
        ? "Survey storage is not configured."
        : code.endsWith("_ERROR") && code !== "INTERNAL_ERROR"
          ? "Survey storage is unavailable."
          : "Unexpected server error.";
    if (!res.headersSent) return json(res, 500, { message, code });
    return res.end();
  }
}
