import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { after, test } from "node:test";
import { getSession, postJson, postResponse, startServer } from "./helpers.mjs";

const ADMIN_TOKEN = "test-admin-secret-value";
const server = await startServer({ ADMIN_TOKEN });
const { origin } = server;

after(async () => {
  await server.stop();
});

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

test("admin endpoints are disabled when no admin token is configured", async () => {
  const plain = await startServer();
  try {
    assert.equal((await fetch(`${plain.origin}/api/results`)).status, 503);
    assert.equal((await fetch(`${plain.origin}/api/admin/session`)).status, 503);
    const login = await postJson(plain.origin, "/api/admin/login", { token: ADMIN_TOKEN }, "10.20.0.9");
    assert.equal(login.status, 503);
  } finally {
    await plain.stop();
  }
});

test("authenticates admin and exposes aggregates and exports", async () => {
  const ip = "10.20.0.1";

  const wrong = await postJson(origin, "/api/admin/login", { token: "wrong-token" }, ip);
  assert.equal(wrong.status, 401);

  const login = await postJson(origin, "/api/admin/login", { token: ADMIN_TOKEN }, ip);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.match(cookie, /^shams_admin=[A-Za-z0-9_-]{32}$/);

  assert.equal((await fetch(`${origin}/api/results`)).status, 401);
  assert.deepEqual(await (await fetch(`${origin}/api/admin/session`)).json(), { authenticated: false });

  const empty = await (await fetch(`${origin}/api/results`, { headers: { Cookie: cookie } })).json();
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.counts, { yes: 0, no: 0, other: 0 });

  const visitor = await getSession(origin, ip);
  await delay(750);
  const submitted = await postResponse(
    origin,
    { name: "Ali Khan", answer: "yes", token: visitor.token, website: "" },
    ip,
    { Cookie: visitor.cookie }
  );
  assert.equal(submitted.status, 201);

  const resultsResponse = await fetch(`${origin}/api/results`, { headers: { Cookie: cookie } });
  const results = await resultsResponse.json();
  assert.equal(results.total, 1);
  assert.deepEqual(results.counts, { yes: 1, no: 0, other: 0 });
  assert.ok(Number.isFinite(Date.parse(results.firstSubmittedAt)));

  const secondIp = "10.20.0.3";
  const secondVisitor = await getSession(origin, secondIp);
  await delay(750);
  const secondResponse = await postResponse(
    origin,
    { name: "Sara Ahmed", answer: "no", token: secondVisitor.token, website: "" },
    secondIp,
    { Cookie: secondVisitor.cookie }
  );
  assert.equal(secondResponse.status, 201);

  const updated = await (await fetch(`${origin}/api/results`, { headers: { Cookie: cookie } })).json();
  assert.equal(updated.total, 2);
  assert.deepEqual(updated.counts, { yes: 1, no: 1, other: 0 });
  assert.equal(updated.responses.length, 2);
  assert.deepEqual(updated.responses.map((item) => item.name), ["Sara Ahmed", "Ali Khan"]);
  assert.deepEqual(updated.responses.map((item) => item.answer), ["no", "yes"]);
  for (const item of updated.responses) {
    assert.ok(Number.isFinite(Date.parse(item.submittedAt)));
  }

  const csvResponse = await fetch(`${origin}/api/results/export?format=csv`, { headers: { Cookie: cookie } });
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get("content-disposition"), /shams-responses\.csv/);
  const csv = await csvResponse.text();
  assert.match(csv, /"name"/);
  assert.match(csv, /"answer"/);
  assert.match(csv, /"Ali Khan"/);
  assert.doesNotMatch(csv, /"review"/);

  const ndjsonResponse = await fetch(`${origin}/api/results/export?format=ndjson`, { headers: { Cookie: cookie } });
  assert.match(ndjsonResponse.headers.get("content-type"), /ndjson/);
  const ndjson = await ndjsonResponse.text();
  const records = ndjson.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.deepEqual(
    Object.keys(records[0]).sort(),
    ["answer", "deviceHash", "id", "name", "submittedAt"]
  );

  const logout = await fetch(`${origin}/api/admin/logout`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie }
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${origin}/api/results`, { headers: { Cookie: cookie } })).status, 401);
  assert.deepEqual(
    await (await fetch(`${origin}/api/admin/session`, { headers: { Cookie: cookie } })).json(),
    { authenticated: false }
  );
});

test("keeps sessions, rate limits, and admin login across a restart", async () => {
  const ip = "10.20.0.2";
  const visitor = await getSession(origin, ip);
  const login = await postJson(origin, "/api/admin/login", { token: ADMIN_TOKEN }, ip);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  await server.restart();

  const session = await (await fetch(`${origin}/api/admin/session`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(session, { authenticated: true });

  await delay(750);
  const submitted = await postResponse(
    origin,
    { name: "Sara Ahmed", answer: "no", token: visitor.token, website: "" },
    ip,
    { Cookie: visitor.cookie }
  );
  assert.equal(submitted.status, 201);

  const results = await (await fetch(`${origin}/api/results`, { headers: { Cookie: cookie } })).json();
  assert.ok(results.counts.no >= 1);
  assert.ok(results.counts.yes >= 1);
});

test("maps legacy name fields in the admin report", async () => {
  const ip = "10.20.0.4";
  const login = await postJson(origin, "/api/admin/login", { token: ADMIN_TOKEN }, ip);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const legacyName = {
    id: "legacy-name",
    voterName: "Legacy Voter",
    answer: "yes",
    submittedAt: new Date().toISOString()
  };
  const legacyAnonymous = {
    id: "legacy-anonymous",
    answer: "no",
    submittedAt: new Date(Date.now() + 1000).toISOString()
  };
  await appendFile(
    server.dataFile,
    `${JSON.stringify(legacyName)}\n${JSON.stringify(legacyAnonymous)}\n`,
    "utf8"
  );

  const results = await (await fetch(`${origin}/api/results`, { headers: { Cookie: cookie } })).json();
  const mappedName = results.responses.find((item) => item.id === legacyName.id);
  const mappedAnonymous = results.responses.find((item) => item.id === legacyAnonymous.id);

  assert.deepEqual(mappedName, {
    id: "legacy-name",
    name: "Legacy Voter",
    answer: "yes",
    submittedAt: legacyName.submittedAt
  });
  assert.deepEqual(mappedAnonymous, {
    id: "legacy-anonymous",
    name: "Not provided",
    answer: "no",
    submittedAt: legacyAnonymous.submittedAt
  });
  assert.equal(results.responses[0].id, legacyAnonymous.id);
});
