import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { rootDir } from "./helpers.mjs";

const source = await readFile(resolve(rootDir, "public/app.js"), "utf8");
const styles = await readFile(resolve(rootDir, "public/styles.css"), "utf8");
const markup = await readFile(resolve(rootDir, "public/index.html"), "utf8");

function createElement(extra = {}) {
  const classes = new Set();
  const listeners = new Map();
  const attributes = {};

  return {
    textContent: "",
    className: "",
    hidden: false,
    disabled: false,
    value: "",
    checked: false,
    classes,
    listeners,
    attributes,
    ...extra,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      }
    },
    setAttribute(name, value) {
      attributes[name] = value;
    },
    removeAttribute(name) {
      delete attributes[name];
    },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      return Promise.all((listeners.get(type) ?? []).map((handler) => handler(event)));
    },
    focus() {
      this.focused = true;
    }
  };
}

async function createDom({
  token = "test-token",
  session = { ok: false },
  responses = [],
  status = { submitted: false, answer: null },
  statusError = null,
  deferStatus = false,
  rememberedAnswer = null
} = {}) {
  const form = createElement();
  const submitButton = createElement({ disabled: true });
  const submitLabel = createElement();
  const statusElement = createElement();
  const success = createElement({ hidden: true });
  const successTitle = createElement();
  const successText = createElement();
  const website = createElement();
  const voterName = createElement();
  const tokenElement = createElement({ content: token });

  const yesOption = createElement();
  const noOption = createElement();
  const yes = createElement({ value: "yes", closest: () => yesOption });
  const no = createElement({ value: "no", closest: () => noOption });
  const radios = [yes, no];

  const elements = new Map([
    ["#survey-form", form],
    ["#submit-button", submitButton],
    ["#submit-label", submitLabel],
    ["#status", statusElement],
    ["#success", success],
    ["#success-title", successTitle],
    ["#success-text", successText],
    ["#website", website],
    ["#voter-name", voterName],
    ['meta[name="survey-token"]', tokenElement]
  ]);

  const calls = [];
  const queued = [...responses];
  const statusQueue = [{ ...status }];
  const storage = new Map();
  const documentElement = createElement();
  let releaseStatus;
  const statusGate = deferStatus
    ? new Promise((resolve) => {
        releaseStatus = resolve;
      })
    : null;
  let VmError;

  if (rememberedAnswer) storage.set("shams_survey_submitted", rememberedAnswer);

  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  };

  const document = {
    documentElement,
    querySelector: (selector) => elements.get(selector) ?? null,
    querySelectorAll: (selector) => (selector === 'input[name="answer"]' ? radios : [])
  };

  const fetchStub = async (url, init) => {
    calls.push({ url, init });

    if (url === "/api/survey/session") {
      const next = { ...session };
      return {
        ok: next.ok ?? false,
        status: next.status ?? 503,
        json: async () => next.body ?? {}
      };
    }

    if (url === "/api/survey/status") {
      if (statusGate) await statusGate;
      if (statusError) throw new VmError(statusError);
      const next = statusQueue.shift() ?? { submitted: false, answer: null };
      return { ok: true, status: 200, json: async () => next };
    }

    const next = queued.shift() ?? { ok: true, status: 200, body: { ok: true } };
    if (next.error) throw new VmError(next.error);
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body ?? {}
    };
  };

  const context = createContext({ document, fetch: fetchStub, localStorage, console });
  VmError = runInContext("Error", context);
  runInContext(source, context);
  await new Promise((done) => setImmediate(done));

  return {
    form,
    documentElement,
    localStorage: storage,
    releaseStatus: async () => {
      releaseStatus?.();
      await new Promise((done) => setImmediate(done));
      await new Promise((done) => setImmediate(done));
    },
    submitButton,
    submitLabel,
    status: statusElement,
    success,
    successTitle,
    successText,
    yes,
    no,
    voterName,
    yesOption,
    noOption,
    calls,
    select(radio) {
      for (const item of radios) item.checked = item === radio;
      return radio.dispatch("change");
    },
    enterName(value) {
      voterName.value = value;
      return voterName.dispatch("input");
    },
    submit() {
      return form.dispatch("submit", { preventDefault() {} });
    }
  };
}

test("enables submission only after a name and response are provided", async () => {
  const dom = await createDom();
  assert.equal(dom.submitButton.disabled, true);

  await dom.enterName("Ali Khan");
  assert.equal(dom.submitButton.disabled, true);

  await dom.select(dom.yes);
  assert.equal(dom.submitButton.disabled, false);
  assert.equal(dom.yesOption.classes.has("is-selected"), true);

  await dom.select(dom.no);
  assert.equal(dom.noOption.classes.has("is-selected"), true);
  assert.equal(dom.yesOption.classes.has("is-selected"), false);

  await dom.enterName("   ");
  assert.equal(dom.submitButton.disabled, true);

  await dom.enterName("Ali Khan");
  assert.equal(dom.submitButton.disabled, false);
});

test("posts the name and answer, then shows success", async () => {
  const dom = await createDom();
  await dom.enterName("  Ali Khan  ");
  await dom.select(dom.yes);
  await dom.submit();

  const post = dom.calls.find((call) => call.url === "/api/responses");
  assert.ok(post);
  assert.equal(post.init.method, "POST");
  assert.deepEqual(JSON.parse(post.init.body), {
    name: "Ali Khan",
    answer: "yes",
    token: "test-token",
    website: ""
  });
  assert.equal(dom.form.hidden, true);
  assert.equal(dom.success.hidden, false);
  assert.equal(dom.successTitle.textContent, "Thank you for participating!");
  assert.equal(dom.successText.textContent, "Your response has been successfully submitted.");
  assert.equal(dom.successTitle.focused, true);
});

test("blocks submission until a name is entered", async () => {
  const dom = await createDom();
  await dom.select(dom.no);
  await dom.submit();

  assert.equal(dom.calls.filter((call) => call.url === "/api/responses").length, 0);
  assert.match(dom.status.textContent, /enter your name/i);
  assert.equal(dom.status.classes.has("status--error"), true);
  assert.equal(dom.voterName.focused, true);
});

test("shows the form immediately without a checking gate", () => {
  assert.doesNotMatch(markup, /class="is-checking"/);
  assert.doesNotMatch(styles, /html\.is-checking \.survey-form/);
});

test("renders the campaign header, symbol card, full choices, and campaign footer", () => {
  assert.match(markup, /src="\/assets\/candidate-photo\.jpg"/);
  assert.match(markup, /src="\/assets\/election-symbol\.jpg"/);
  assert.match(markup, /LOCAL ELECTIONS &middot; PUBLIC SUPPORT/);
  assert.match(markup, /WARD <strong>07<\/strong> &ndash; Kashrote Yadgaar/);
  assert.match(markup, /YOUR CANDIDATE/);
  assert.match(markup, /ELECTION SYMBOL/);
  assert.match(markup, /VOLUNTARY PUBLIC SUPPORT SURVEY/);
  assert.match(markup, /YES, I SUPPORT/);
  assert.match(markup, /NO, I DO NOT SUPPORT/);
  assert.match(markup, /میرا شیر، میری ذمہ داری/);
  assert.match(
    markup,
    /Participation is voluntary\. Your response is an informal opinion and does not constitute an official election vote\./
  );
  assert.doesNotMatch(markup, /option__short/);
  assert.doesNotMatch(markup, /developed by/);
});

test("shows the form immediately while saved status is still loading", async () => {
  const dom = await createDom({
    deferStatus: true,
    status: { submitted: true, answer: "yes" }
  });

  assert.equal(dom.form.hidden, false);
  assert.equal(dom.success.hidden, true);

  await dom.enterName("Ali Khan");
  await dom.select(dom.yes);
  assert.equal(dom.submitButton.disabled, false);

  await dom.releaseStatus();

  assert.equal(dom.form.hidden, true);
  assert.equal(dom.success.hidden, false);
});

test("does not unlock a form after a submission made while status was pending", async () => {
  const dom = await createDom({ deferStatus: true });
  await dom.enterName("Ali Khan");
  await dom.select(dom.yes);
  await dom.submit();

  assert.equal(dom.form.hidden, true);

  await dom.releaseStatus();

  assert.equal(dom.form.hidden, true);
  assert.equal(dom.success.hidden, false);
  assert.equal(dom.submitButton.disabled, true);
});

test("shows thank-you immediately for a remembered submission", async () => {
  const dom = await createDom({ rememberedAnswer: "yes" });

  assert.equal(dom.form.hidden, true);
  assert.equal(dom.success.hidden, false);
  assert.equal(dom.successText.textContent, "You have already submitted your response from this device.");
  assert.equal(dom.calls.filter((call) => call.url === "/api/survey/status").length, 0);
});

test("shows the already-submitted view on load", async () => {
  const dom = await createDom({ status: { submitted: true, answer: "no" } });

  assert.equal(dom.form.hidden, true);
  assert.equal(dom.success.hidden, false);
  assert.equal(dom.successTitle.textContent, "Thank you for participating!");
  assert.equal(dom.successText.textContent, "You have already submitted your response from this device.");
  assert.equal(dom.yes.disabled, true);
  assert.equal(dom.no.disabled, true);
  assert.equal(dom.no.checked, true);
  assert.equal(dom.submitButton.disabled, true);
  assert.equal(dom.voterName.disabled, true);

  await dom.select(dom.yes);
  await dom.submit();
  assert.equal(dom.calls.filter((call) => call.url === "/api/responses").length, 0);
});

test("shows the already-submitted view when the API reports a duplicate", async () => {
  const dom = await createDom({
    responses: [{ ok: false, status: 409, body: { message: "already submitted" } }]
  });
  await dom.enterName("Ali Khan");
  await dom.select(dom.no);
  await dom.submit();

  assert.equal(dom.form.hidden, true);
  assert.equal(dom.success.hidden, false);
  assert.equal(dom.successText.textContent, "You have already submitted your response from this device.");
  assert.equal(dom.no.disabled, true);
  assert.equal(dom.no.checked, true);
  assert.equal(dom.submitButton.disabled, true);
});

test("recovers from network failures and shows an error", async () => {
  const dom = await createDom({ responses: [{ error: "Network down" }] });
  await dom.enterName("Ali Khan");
  await dom.select(dom.yes);
  await dom.submit();

  assert.equal(dom.submitButton.disabled, false);
  assert.equal(dom.status.textContent, "Network down");
  assert.equal(dom.status.classes.has("status--error"), true);
  assert.equal(dom.status.attributes.role, "alert");
});

test("uses the token returned by the status endpoint", async () => {
  const token = "b".repeat(32);
  const dom = await createDom({
    token: "__SURVEY_TOKEN__",
    status: { submitted: false, answer: null, token }
  });
  await dom.enterName("Ali Khan");
  await dom.select(dom.yes);
  await dom.submit();

  const post = dom.calls.find((call) => call.url === "/api/responses");
  assert.equal(JSON.parse(post.init.body).token, token);
  assert.equal(dom.calls.filter((call) => call.url === "/api/survey/session").length, 0);
});

test("loads a session token when the page is served statically", async () => {
  const token = "a".repeat(32);
  const dom = await createDom({
    token: "__SURVEY_TOKEN__",
    session: { ok: true, body: { token } }
  });
  await dom.enterName("Ali Khan");
  await dom.select(dom.yes);
  await dom.submit();

  const post = dom.calls.find((call) => call.url === "/api/responses");
  assert.equal(JSON.parse(post.init.body).token, token);
});

test("blocks submission when the session token is missing", async () => {
  const dom = await createDom({ token: "" });
  await dom.enterName("Ali Khan");
  await dom.select(dom.yes);
  await dom.submit();

  assert.equal(dom.calls.filter((call) => call.url === "/api/responses").length, 0);
  assert.match(dom.status.textContent, /session has expired/i);
  assert.equal(dom.status.classes.has("status--error"), true);
});

test("changing selection after success cannot submit again", async () => {
  const dom = await createDom();
  await dom.enterName("Ali Khan");
  await dom.select(dom.yes);
  await dom.submit();
  const postCount = dom.calls.filter((call) => call.url === "/api/responses").length;

  await dom.select(dom.no);
  await dom.submit();

  assert.equal(dom.calls.filter((call) => call.url === "/api/responses").length, postCount);
  assert.equal(dom.yes.disabled, true);
  assert.equal(dom.no.disabled, true);
});
