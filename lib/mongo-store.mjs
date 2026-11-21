import { MongoClient } from "mongodb";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MONGO_PROMISE_KEY = "__shamsSurveyMongoPromise";

function publicError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw publicError("CONFIG_ERROR", `${name} is not configured.`);
  return value;
}

function getClientPromise() {
  if (!globalThis[MONGO_PROMISE_KEY]) {
    const uri = requiredEnv("MONGODB_URI").trim();
    if (!/^mongodb(?:\+srv)?:\/\//.test(uri) || /[<>\s]/.test(uri)) {
      throw publicError("MONGO_URI_INVALID", "MongoDB URI is invalid.");
    }

    let client;
    try {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    } catch (error) {
      throw publicError("MONGO_URI_INVALID", "MongoDB URI is invalid.", error);
    }

    globalThis[MONGO_PROMISE_KEY] = client.connect().catch((error) => {
      const message = error instanceof Error ? error.message.replaceAll(uri, "[redacted]") : String(error);
      throw publicError("MONGO_CONNECT_ERROR", `MongoDB connection failed: ${message}`, error);
    });
  }
  return globalThis[MONGO_PROMISE_KEY];
}

function normalizeResponse(document) {
  if (!document) return null;
  const { _id, submittedAt, ...rest } = document;
  return {
    ...rest,
    id: typeof _id === "string" ? _id : String(_id),
    submittedAt: submittedAt instanceof Date ? submittedAt.toISOString() : String(submittedAt ?? "")
  };
}

export function createDeviceTokens(secret) {
  function issueToken() {
    const nonce = randomBytes(24).toString("base64url");
    const signature = createHmac("sha256", secret).update(nonce).digest("base64url");
    return `${nonce}.${signature}`;
  }

  function isValidToken(token) {
    if (typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [nonce, signature] = parts;
    if (!NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature)) return false;
    const expected = createHmac("sha256", secret).update(nonce).digest("base64url");
    const received = Buffer.from(signature);
    const calculated = Buffer.from(expected);
    return received.length === calculated.length && timingSafeEqual(received, calculated);
  }

  function hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
  }

  return { issueToken, isValidToken, hashToken };
}

export async function createMongoStore() {
  const deviceSecret = requiredEnv("DEVICE_SECRET");
  const client = await getClientPromise();
  const db = client.db(process.env.MONGODB_DB ?? "shams_survey");
  const responses = db.collection("responses");
  const sessions = db.collection("sessions");
  const rateLimits = db.collection("rate_limits");
  const adminSessions = db.collection("admin_sessions");

  try {
    await Promise.all([
      responses.createIndex(
        { deviceHash: 1 },
        {
          unique: true,
          name: "unique_device_hash",
          partialFilterExpression: { deviceHash: { $type: "string" } }
        }
      ),
      sessions.createIndex({ token: 1 }, { unique: true, name: "unique_session_token" }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "session_ttl" }),
      rateLimits.createIndex({ key: 1 }, { unique: true, name: "unique_rate_key" }),
      adminSessions.createIndex({ id: 1 }, { unique: true, name: "unique_admin_session" }),
      adminSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "admin_session_ttl" })
    ]);
  } catch (error) {
    throw publicError("MONGO_INDEX_ERROR", "MongoDB index setup failed.", error);
  }

  const devices = createDeviceTokens(deviceSecret);
  const clientSalt = createHash("sha256").update(`${deviceSecret}:client`).digest("hex");

  async function cleanup() {
    const now = new Date();
    await Promise.all([
      sessions.deleteMany({ expiresAt: { $lte: now } }),
      adminSessions.deleteMany({ expiresAt: { $lte: now } }),
      rateLimits.deleteMany({ resetAt: { $lte: now } })
    ]);
  }

  async function addSession(token, data) {
    await sessions.updateOne(
      { token },
      {
        $set: {
          token,
          clientKey: data.clientKey,
          createdAt: new Date(data.createdAt),
          expiresAt: new Date(data.expiresAt)
        }
      },
      { upsert: true }
    );
  }

  async function getSession(token) {
    const document = await sessions.findOne({ token });
    if (!document || document.expiresAt.getTime() <= Date.now()) return null;
    return {
      clientKey: document.clientKey,
      createdAt: document.createdAt.getTime(),
      expiresAt: document.expiresAt.getTime()
    };
  }

  async function removeSession(token) {
    await sessions.deleteOne({ token });
  }

  async function getRate(key) {
    const document = await rateLimits.findOne({ key });
    if (!document) return null;
    return { count: document.count, resetAt: document.resetAt.getTime() };
  }

  async function setRate(key, bucket) {
    await rateLimits.updateOne(
      { key },
      { $set: { key, count: bucket.count, resetAt: new Date(bucket.resetAt) } },
      { upsert: true }
    );
  }

  async function addAdminSession(id, data) {
    await adminSessions.updateOne(
      { id },
      { $set: { id, createdAt: new Date(data.createdAt), expiresAt: new Date(data.expiresAt) } },
      { upsert: true }
    );
  }

  async function getAdminSession(id) {
    const document = await adminSessions.findOne({ id });
    if (!document || document.expiresAt.getTime() <= Date.now()) return null;
    return {
      createdAt: document.createdAt.getTime(),
      expiresAt: document.expiresAt.getTime()
    };
  }

  async function removeAdminSession(id) {
    await adminSessions.deleteOne({ id });
  }

  async function insertResponse(record) {
    try {
      await responses.insertOne({
        _id: record.id,
        id: record.id,
        name: record.name,
        answer: record.answer,
        deviceHash: record.deviceHash,
        submittedAt: new Date(record.submittedAt)
      });
      return true;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  async function hasSubmitted(hash) {
    return (await responses.countDocuments({ deviceHash: hash }, { limit: 1 })) > 0;
  }

  async function findResponse(hash) {
    return normalizeResponse(await responses.findOne({ deviceHash: hash }));
  }

  async function readResponses() {
    const documents = await responses.find({}).sort({ submittedAt: -1 }).toArray();
    return documents.map(normalizeResponse);
  }

  return {
    cleanup,
    addSession,
    getSession,
    removeSession,
    getRate,
    setRate,
    addAdminSession,
    getAdminSession,
    removeAdminSession,
    insertResponse,
    hasSubmitted,
    findResponse,
    readResponses,
    devices,
    clientSalt
  };
}
