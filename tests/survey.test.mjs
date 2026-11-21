import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { getSession, getStatus, postResponse, startServer } from "./helpers.mjs";

const DUPLICATE_MESSAGE = "You have already submitted your response from this device.";
const server = await startServer();
const { origin, dataFile } = server;

after(async () => {
  await server.stop();
});

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function readRecords() {
  const content = await readFile(dataFile, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("first-time visitor submits YES and the device is blocked afterwards", async () => {
  const ip = "10.10.0.1";
  const { token, cookie } = await getSession(origin, ip);
  const before = await getStatus(origin, ip, cookie);
  assert.equal(before.submitted, false);
  assert.equal(before.answer, null);

  await delay(750);
  const response = await postResponse(
    origin,
    { name: "Ali Khan", answer: "yes", token, website: "" },
    ip,
    { Cookie: cookie }
  );
  assert.equal(response.status, 201);

  const records = await readRecords();
  assert.equal(records.length, 1);
  assert.deepEqual(
    Object.keys(records[0]).sort(),
    ["answer", "deviceHash", "id", "name", "submittedAt"]
  );
  assert.match(records[0].deviceHash, /^[a-f0-9]{64}$/);
  assert.equal(records[0].name, "Ali Khan");
  assert.equal(records[0].answer, "yes");
  assert.ok(Number.isFinite(Date.parse(records[0].submittedAt)));
  assert.equal(JSON.stringify(records[0]).includes(cookie), false);

  const after = await getStatus(origin, ip, cookie);
  assert.equal(after.submitted, true);
  assert.equal(after.answer, "yes");
});

test("a different first-time browser can submit NO", async () => {
  const ip = "10.10.0.2";
  const before = (await readRecords()).length;
  const { token, cookie } = await getSession(origin, ip);

  await delay(750);
  const response = await postResponse(
    origin,
    { name: "Ali Khan", answer: "no", token, website: "" },
    ip,
    { Cookie: cookie }
  );
  assert.equal(response.status, 201);

  const records = await readRecords();
  assert.equal(records.length, before + 1);
  assert.equal(records.at(-1).answer, "no");
  assert.notEqual(records.at(-1).deviceHash, records[0].deviceHash);
});

test("refreshing after submission blocks another submission", async () => {
  const ip = "10.10.0.3";
  const visitor = await getSession(origin, ip);
  await delay(750);
  assert.equal(
    (await postResponse(origin, { name: "Ali Khan", answer: "yes", token: visitor.token, website: "" }, ip, { Cookie: visitor.cookie })).status,
    201
  );

  const refreshed = await getSession(origin, ip, visitor.cookie);
  assert.equal(refreshed.cookie, visitor.cookie);
  const status = await getStatus(origin, ip, refreshed.cookie);
  assert.equal(status.submitted, true);

  const before = (await readRecords()).length;
  const duplicate = await postResponse(
    origin,
    { name: "Ali Khan", answer: "no", token: refreshed.token, website: "" },
    ip,
    { Cookie: refreshed.cookie }
  );
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).message, DUPLICATE_MESSAGE);
  assert.equal((await readRecords()).length, before);
});

test("reopening the browser keeps the submitted status", async () => {
  const ip = "10.10.0.4";
  const visitor = await getSession(origin, ip);
  await delay(750);
  assert.equal(
    (await postResponse(origin, { name: "Ali Khan", answer: "yes", token: visitor.token, website: "" }, ip, { Cookie: visitor.cookie })).status,
    201
  );

  const reopened = await getStatus(origin, ip, visitor.cookie);
  assert.equal(reopened.submitted, true);
  assert.equal(reopened.answer, "yes");

  const newSession = await getSession(origin, ip, visitor.cookie);
  const duplicate = await postResponse(
    origin,
    { name: "Ali Khan", answer: "no", token: newSession.token, website: "" },
    ip,
    { Cookie: visitor.cookie }
  );
  assert.equal(duplicate.status, 409);
});

test("direct API requests require a valid device cookie", async () => {
  const ip = "10.10.0.5";
  const before = (await readRecords()).length;
  const visitor = await getSession(origin, ip);

  const missing = await postResponse(origin, { name: "Ali Khan", answer: "yes", token: visitor.token, website: "" }, ip);
  assert.equal(missing.status, 403);

  const forged = await postResponse(
    origin,
    { name: "Ali Khan", answer: "yes", token: visitor.token, website: "" },
    ip,
    { Cookie: "shams_device=forged.token" }
  );
  assert.equal(forged.status, 403);
  assert.equal((await readRecords()).length, before);

  await delay(750);
  const valid = await postResponse(
    origin,
    { name: "Ali Khan", answer: "yes", token: visitor.token, website: "" },
    ip,
    { Cookie: visitor.cookie }
  );
  assert.equal(valid.status, 201);
});

test("two simultaneous submissions from one device yield only one record", async () => {
  const ip = "10.10.0.6";
  const first = await getSession(origin, ip);
  const second = await getSession(origin, ip, first.cookie);
  await delay(750);
  const before = (await readRecords()).length;

  const [yes, no] = await Promise.all([
    postResponse(origin, { name: "Ali Khan", answer: "yes", token: first.token, website: "" }, ip, { Cookie: first.cookie }),
    postResponse(origin, { name: "Ali Khan", answer: "no", token: second.token, website: "" }, ip, { Cookie: first.cookie })
  ]);

  assert.deepEqual([yes.status, no.status].sort(), [201, 409]);
  const rejected = yes.status === 409 ? yes : no;
  assert.equal((await rejected.json()).message, DUPLICATE_MESSAGE);
  assert.equal((await readRecords()).length, before + 1);
});

test("validates the name and response", async () => {
  const ip = "10.10.0.9";
  const before = (await readRecords()).length;
  const visitor = await getSession(origin, ip);

  const missingName = await postResponse(
    origin,
    { name: "   ", answer: "yes", token: visitor.token, website: "" },
    ip,
    { Cookie: visitor.cookie }
  );
  assert.equal(missingName.status, 400);

  const longName = await postResponse(
    origin,
    { name: "x".repeat(81), answer: "yes", token: visitor.token, website: "" },
    ip,
    { Cookie: visitor.cookie }
  );
  assert.equal(longName.status, 400);

  const invalidAnswer = await postResponse(
    origin,
    { name: "Ali Khan", answer: "maybe", token: visitor.token, website: "" },
    ip,
    { Cookie: visitor.cookie }
  );
  assert.equal(invalidAnswer.status, 400);

  assert.equal((await readRecords()).length, before);

  await delay(750);
  const response = await postResponse(
    origin,
    {
      name: "  Ali Khan  ",
      answer: "yes",
      token: visitor.token,
      website: ""
    },
    ip,
    { Cookie: visitor.cookie }
  );
  assert.equal(response.status, 201);

  const record = (await readRecords()).at(-1);
  assert.equal(record.name, "Ali Khan");
  assert.equal(record.answer, "yes");
});

test("existing responses survive a server restart", async () => {
  const ip = "10.10.0.7";
  const visitor = await getSession(origin, ip);
  await delay(750);
  assert.equal(
    (await postResponse(origin, { name: "Ali Khan", answer: "no", token: visitor.token, website: "" }, ip, { Cookie: visitor.cookie })).status,
    201
  );
  const before = (await readRecords()).length;

  await server.restart();

  const status = await getStatus(origin, ip, visitor.cookie);
  assert.equal(status.submitted, true);
  assert.equal(status.answer, "no");
  assert.equal((await readRecords()).length, before);

  const fresh = await getSession(origin, "10.10.0.8");
  await delay(750);
  assert.equal(
    (await postResponse(origin, { name: "Ali Khan", answer: "yes", token: fresh.token, website: "" }, "10.10.0.8", { Cookie: fresh.cookie })).status,
    201
  );
});
