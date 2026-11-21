import test from "node:test";
import assert from "node:assert/strict";

process.env.MONGODB_URI = "not-a-valid-uri";
process.env.DEVICE_SECRET = "x";

const { handle } = await import("../lib/vercel-api.mjs");

function fakeResponse() {
  return {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    end(body) {
      this.body = body;
    }
  };
}

test("invalid MongoDB URI returns a diagnostic code", async () => {
  const res = fakeResponse();
  await handle({ url: "/api/health?db=1", method: "GET", headers: {} }, res);

  assert.equal(res.statusCode, 500);
  const body = JSON.parse(res.body);
  assert.equal(body.code, "MONGO_URI_INVALID");
  assert.equal(body.message, "Survey storage configuration is invalid.");
});
