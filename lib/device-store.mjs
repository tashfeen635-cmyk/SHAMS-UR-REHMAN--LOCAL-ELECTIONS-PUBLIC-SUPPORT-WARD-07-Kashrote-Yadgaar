import { open, mkdir, readdir, unlink } from "node:fs/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function createDeviceStore({ secret, indexDir }) {
  const claimed = new Set();

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

  function hasSubmitted(hash) {
    return claimed.has(hash);
  }

  async function initialize(existingHashes = []) {
    await mkdir(indexDir, { recursive: true, mode: 0o700 });

    const recorded = new Set(existingHashes.filter((hash) => HASH_PATTERN.test(hash)));
    let files = [];
    try {
      files = await readdir(indexDir);
    } catch {
      files = [];
    }

    for (const name of files) {
      if (!HASH_PATTERN.test(name)) continue;
      if (recorded.has(name)) {
        claimed.add(name);
      } else {
        await unlink(join(indexDir, name)).catch(() => {});
      }
    }
    for (const hash of recorded) claimed.add(hash);
  }

  async function claim(hash) {
    if (claimed.has(hash)) return false;

    try {
      const handle = await open(join(indexDir, hash), "wx", 0o600);
      await handle.close();
      claimed.add(hash);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") {
        claimed.add(hash);
        return false;
      }
      throw error;
    }
  }

  async function release(hash) {
    claimed.delete(hash);
    await unlink(join(indexDir, hash)).catch(() => {});
  }

  return {
    initialize,
    issueToken,
    isValidToken,
    hashToken,
    hasSubmitted,
    claim,
    release
  };
}
