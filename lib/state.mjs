import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export async function createStateStore(stateFile) {
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });

  let sessions = new Map();
  let rateLimits = new Map();
  let adminSessions = new Map();
  let clientSalt = randomBytes(32).toString("hex");
  let deviceSecret = randomBytes(32).toString("hex");
  let needsInitialSave = false;

  if (existsSync(stateFile)) {
    try {
      const saved = JSON.parse(await readFile(stateFile, "utf8"));
      sessions = new Map(saved.sessions ?? []);
      rateLimits = new Map(saved.rateLimits ?? []);
      adminSessions = new Map(saved.adminSessions ?? []);
      if (typeof saved.clientSalt === "string" && saved.clientSalt.length >= 32) {
        clientSalt = saved.clientSalt;
      } else {
        needsInitialSave = true;
      }
      if (typeof saved.deviceSecret === "string" && saved.deviceSecret.length >= 32) {
        deviceSecret = saved.deviceSecret;
      } else {
        needsInitialSave = true;
      }
    } catch (error) {
      console.error("Could not read saved state; starting with an empty state", error);
      needsInitialSave = true;
    }
  } else {
    needsInitialSave = true;
  }

  let writeQueue = Promise.resolve();

  function save() {
    const snapshot = JSON.stringify({
      clientSalt,
      deviceSecret,
      sessions: [...sessions],
      rateLimits: [...rateLimits],
      adminSessions: [...adminSessions]
    });

    writeQueue = writeQueue.then(async () => {
      const tempFile = `${stateFile}.${process.pid}.tmp`;
      try {
        await writeFile(tempFile, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(tempFile, stateFile);
      } catch {
        await writeFile(stateFile, snapshot, { encoding: "utf8", mode: 0o600 });
      }
    }).catch((error) => {
      console.error("Failed to persist state", error);
    });

    return writeQueue;
  }

  if (needsInitialSave) await save();

  return {
    getClientSalt: () => clientSalt,

    getDeviceSecret: () => deviceSecret,

    getSession: (token) => sessions.get(token),

    async addSession(token, session) {
      sessions.set(token, session);
      await save();
    },

    async removeSession(token) {
      if (!sessions.delete(token)) return;
      await save();
    },

    getRate: (key) => rateLimits.get(key),

    async setRate(key, bucket) {
      rateLimits.set(key, bucket);
      await save();
    },

    getAdminSession: (id) => adminSessions.get(id),

    async addAdminSession(id, session) {
      adminSessions.set(id, session);
      await save();
    },

    async removeAdminSession(id) {
      if (!adminSessions.delete(id)) return;
      await save();
    },

    async cleanup(now = Date.now()) {
      let changed = false;

      for (const [token, session] of sessions) {
        if (session.expiresAt <= now) {
          sessions.delete(token);
          changed = true;
        }
      }
      for (const [key, bucket] of rateLimits) {
        if (bucket.resetAt <= now) {
          rateLimits.delete(key);
          changed = true;
        }
      }
      for (const [id, session] of adminSessions) {
        if (session.expiresAt <= now) {
          adminSessions.delete(id);
          changed = true;
        }
      }

      if (changed) await save();
    }
  };
}
