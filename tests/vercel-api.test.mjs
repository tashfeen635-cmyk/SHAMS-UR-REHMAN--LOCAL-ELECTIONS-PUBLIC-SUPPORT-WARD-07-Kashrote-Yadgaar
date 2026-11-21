import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
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

test("serverless delete endpoint verifies phrase and password before deleting", async () => {
  const previousToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "vercel-delete-token";

  let deleted = 0;
  const store = {
    clientSalt: "test-client-salt",
    cleanup: async () => {},
    getAdminSession: async (id) => (
      id === "valid-session-id-000000000000000" ? { expiresAt: Date.now() + 60000 } : null
    ),
    getRate: async () => null,
    setRate: async () => {},
    deleteAllSurveyData: async () => {
      deleted += 1;
    }
  };

  function request(payload) {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
    Object.assign(req, {
      url: "/api/admin/delete-data",
      method: "POST",
      headers: {
        cookie: "shams_admin=valid-session-id-000000000000000",
        origin: "https://shams.test",
        host: "shams.test",
        "content-type": "application/json"
      }
    });
    return req;
  }

  try {
    const wrongPassword = fakeResponse();
    await handle(
      request({ confirmation: "DELETE ALL DATA", password: "wrong-password" }),
      wrongPassword,
      store
    );
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(deleted, 0);

    const valid = fakeResponse();
    await handle(
      request({ confirmation: "DELETE ALL DATA", password: "vercel-delete-token" }),
      valid,
      store
    );
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(JSON.parse(valid.body), { ok: true, deleted: true });
    assert.equal(deleted, 1);
  } finally {
    if (previousToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousToken;
  }
});
