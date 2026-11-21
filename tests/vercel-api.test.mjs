import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../lib/vercel-api.mjs";

delete process.env.MONGODB_URI;
delete process.env.MONGODB_DB;
delete process.env.DEVICE_SECRET;
delete process.env.ADMIN_TOKEN;

function fakeResponse() {
  return {
    statusCode: 0,
    headersSent: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    }
  };
}

test("health endpoint works without Mongo configuration", async () => {
  const res = fakeResponse();
  await handle({ url: "/api/health", method: "GET", headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test("async route failures return coded JSON errors", async () => {
  const res = fakeResponse();
  await handle({ url: "/api/health?db=1", method: "GET", headers: {} }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), {
    message: "Survey storage is not configured.",
    code: "CONFIG_ERROR",
    errorName: "Error"
  });
});
