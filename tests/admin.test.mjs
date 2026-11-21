import assert from "node:assert/strict";
import { appendFile, readFile, readdir } from "node:fs/promises";
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
  assert.deepEqual(empty.counts, { yes: 0, no: 0 });

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
  assert.deepEqual(results.counts, { yes: 1, no: 0 });
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
  assert.deepEqual(updated.counts, { yes: 1, no: 1 });
  assert.equal(updated.responses.length, 2);
  assert.deepEqual(updated.responses.map((item) => item.name), ["Sara Ahmed", "Ali Khan"]);
  assert.deepEqual(updated.responses.map((item) => item.answer), ["no", "yes"]);
  for (const item of updated.responses) {
    assert.ok(Number.isFinite(Date.parse(item.submittedAt)));
  }

  const csvResponse = await fetch(`${origin}/api/results/export?format=csv`, { headers: { Cookie: cookie } });
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get("content-disposition"), /shams-survey-report\.csv/);
  const csv = await csvResponse.text();
  assert.match(csv, /"Respondent Name"/);
  assert.match(csv, /"Response"/);
  assert.match(csv, /"Submission Date"/);
  assert.match(csv, /"Submission Time"/);
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

test("dashboard reports filter, paginate, export, and preserve unclassified records", async () => {
  const isolated = await startServer({ ADMIN_TOKEN });
  try {
    const ip = "10.30.0.1";
    const login = await postJson(isolated.origin, "/api/admin/login", { token: ADMIN_TOKEN }, ip);
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const records = [
      { id: "r1", name: "Ayesha", answer: "yes", submittedAt: "2026-01-02T10:00:00.000Z", deviceHash: "h1" },
      { id: "r2", name: "Bilal", answer: "no", submittedAt: "2026-01-03T10:00:00.000Z", deviceHash: "h2" },
      { id: "r3", name: "Ayesha Khan", answer: "yes", submittedAt: "2026-01-04T10:00:00.000Z", deviceHash: "h3" },
      { id: "r4", name: "Legacy Record", answer: "maybe", submittedAt: "2026-01-05T10:00:00.000Z", deviceHash: "h4" }
    ];
    await appendFile(isolated.dataFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    const adminFetch = (path) => fetch(`${isolated.origin}${path}`, { headers: { Cookie: cookie } });

    const all = await (await adminFetch("/api/results")).json();
    assert.equal(all.total, 4);
    assert.deepEqual(all.counts, { yes: 2, no: 1 });
    assert.equal(all.unclassified, 1);
    assert.equal("other" in all.counts, false);

    const searched = await (await adminFetch("/api/results?search=ayesha")).json();
    assert.equal(searched.filteredTotal, 2);
    assert.deepEqual(searched.responses.map((item) => item.name), ["Ayesha Khan", "Ayesha"]);

    const answered = await (await adminFetch("/api/results?answer=no")).json();
    assert.equal(answered.filteredTotal, 1);
    assert.deepEqual(answered.responses.map((item) => item.id), ["r2"]);

    const dated = await (await adminFetch("/api/results?date=2026-01-03")).json();
    assert.equal(dated.filteredTotal, 1);
    assert.deepEqual(dated.responses.map((item) => item.id), ["r2"]);

    const oldest = await (await adminFetch("/api/results?sort=oldest&pageSize=10")).json();
    assert.deepEqual(oldest.responses.map((item) => item.id), ["r1", "r2", "r3", "r4"]);

    const secondPage = await (await adminFetch("/api/results?page=2&pageSize=2&sort=oldest")).json();
    assert.equal(secondPage.page, 2);
    assert.equal(secondPage.totalPages, 2);
    assert.deepEqual(secondPage.responses.map((item) => item.id), ["r3", "r4"]);

    const filteredCsv = await (await adminFetch("/api/results/export?format=csv&answer=yes")).text();
    assert.match(filteredCsv, /"Ayesha"/);
    assert.match(filteredCsv, /"YES"/);
    assert.doesNotMatch(filteredCsv, /Bilal/);
    assert.doesNotMatch(filteredCsv, /maybe/i);

    assert.equal((await fetch(`${isolated.origin}/api/results/export?format=pdf`)).status, 401);
    const pdfResponse = await adminFetch("/api/results/export?format=pdf&answer=yes");
    assert.equal(pdfResponse.status, 200);
    assert.match(pdfResponse.headers.get("content-type"), /application\/pdf/);
    assert.match(pdfResponse.headers.get("content-disposition"), /shams-survey-report\.pdf/);
    const pdf = Buffer.from(await pdfResponse.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 1000);
    assert.match(pdf.toString("latin1"), /Page 1 of 1/);

    const ndjson = await (await adminFetch("/api/results/export?format=ndjson")).text();
    const preserved = ndjson.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(preserved.length, 4);
    assert.equal(preserved.find((record) => record.id === "r4").answer, "maybe");
  } finally {
    await isolated.stop();
  }
});

test("admin UI exposes dashboard navigation, filters, charts, and downloads", async () => {
  const html = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  for (const label of ["Dashboard", "Survey Reports", "Analytics", "Download Reports", "Sign Out"]) {
    assert.match(html, new RegExp(label));
  }
  for (const id of [
    "refresh-button",
    "filter-search",
    "filter-answer",
    "filter-date",
    "filter-sort",
    "download-pdf",
    "download-csv",
    "print-report-button"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-chart="dashboard"/);
  assert.match(html, /Submission Date/);
  assert.match(html, /Submission Time/);
  assert.doesNotMatch(html, /Other Responses/i);

  const script = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  assert.match(script, /api\/results\/export/);
  assert.match(script, /window\.print\(\)/);
  assert.doesNotMatch(script, /other/i);
});

test("clears all survey data only after full admin confirmation", async () => {
  const isolated = await startServer({ ADMIN_TOKEN });
  try {
    const ip = "10.40.0.1";
    const login = await postJson(isolated.origin, "/api/admin/login", { token: ADMIN_TOKEN }, ip);
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const visitor = await getSession(isolated.origin, ip);
    await delay(750);
    const submitted = await postResponse(
      isolated.origin,
      { name: "Ali Khan", answer: "yes", token: visitor.token, website: "" },
      ip,
      { Cookie: visitor.cookie }
    );
    assert.equal(submitted.status, 201);

    const deleteData = (payload, extraHeaders = {}, headersCookie = cookie) => postJson(
      isolated.origin,
      "/api/admin/delete-data",
      payload,
      ip,
      { Cookie: headersCookie, ...extraHeaders }
    );
    const validPayload = { confirmation: "DELETE ALL DATA", password: ADMIN_TOKEN };

    assert.equal((await deleteData(validPayload, {}, "")).status, 401);
    assert.equal((await deleteData({ ...validPayload, confirmation: "DELETE" })).status, 400);
    assert.equal((await deleteData({ ...validPayload, password: "wrong-password" })).status, 401);
    assert.equal((await deleteData(validPayload, { Origin: "https://evil.example" })).status, 403);

    const beforeInvalid = await (await fetch(`${isolated.origin}/api/results`, { headers: { Cookie: cookie } })).json();
    assert.equal(beforeInvalid.total, 1);

    const deletion = await deleteData(validPayload);
    assert.equal(deletion.status, 200);
    assert.deepEqual(await deletion.json(), { ok: true, deleted: true });

    const cleared = await (await fetch(`${isolated.origin}/api/results`, { headers: { Cookie: cookie } })).json();
    assert.equal(cleared.total, 0);
    assert.deepEqual(cleared.counts, { yes: 0, no: 0 });
    assert.equal(cleared.filteredTotal, 0);
    assert.deepEqual(cleared.responses, []);

    assert.deepEqual(
      await (await fetch(`${isolated.origin}/api/admin/session`, { headers: { Cookie: cookie } })).json(),
      { authenticated: true }
    );
    assert.equal(await readFile(isolated.dataFile, "utf8"), "");
    assert.ok(await readFile(isolated.stateFile, "utf8"));
    const deviceFiles = await readdir(`${isolated.tempDir}/device-index`).catch(() => []);
    assert.equal(deviceFiles.filter((name) => /^[a-f0-9]{64}$/.test(name)).length, 0);

    const freshVisitor = await getSession(isolated.origin, ip, visitor.cookie);
    await delay(750);
    const resubmitted = await postResponse(
      isolated.origin,
      { name: "New Vote", answer: "no", token: freshVisitor.token, website: "" },
      ip,
      { Cookie: visitor.cookie }
    );
    assert.equal(resubmitted.status, 201);
  } finally {
    await isolated.stop();
  }
});

test("admin UI includes an irreversible clear data confirmation", async () => {
  const html = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /Clear All Survey Data/i);
  assert.match(html, /DELETE ALL DATA/);
  assert.match(html, /Admin password/i);
  assert.match(html, /irreversible/i);
  assert.match(html, /id="delete-dialog"/);

  const script = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  assert.match(script, /api\/admin\/delete-data/);
  assert.match(script, /confirmation !== "DELETE ALL DATA"/);
});
