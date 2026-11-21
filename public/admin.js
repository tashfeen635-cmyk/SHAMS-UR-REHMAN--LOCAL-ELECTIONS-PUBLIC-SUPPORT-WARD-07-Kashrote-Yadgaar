const loginView = document.getElementById("login-view");
const dashboardView = document.getElementById("dashboard-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const appError = document.getElementById("app-error");
const appLoading = document.getElementById("app-loading");
const refreshButton = document.getElementById("refresh-button");
const logoutButton = document.getElementById("logout-button");
const reportBody = document.getElementById("report-body");
const reportCount = document.getElementById("report-count");
const pageInfo = document.getElementById("page-info");
const previousPageButton = document.getElementById("prev-page");
const nextPageButton = document.getElementById("next-page");
const lastUpdated = document.getElementById("last-updated");
const unclassifiedNote = document.getElementById("unclassified-note");
const latestActivity = document.getElementById("latest-activity");
const printReport = document.getElementById("print-report");

const filterSearch = document.getElementById("filter-search");
const filterAnswer = document.getElementById("filter-answer");
const filterDate = document.getElementById("filter-date");
const filterSort = document.getElementById("filter-sort");
const applyFiltersButton = document.getElementById("apply-filters");
const clearFiltersButton = document.getElementById("clear-filters");

const state = {
  section: "dashboard",
  page: 1,
  report: null
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setMessage(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

function setLoading(loading) {
  appLoading.hidden = !loading;
  refreshButton.disabled = loading;
  refreshButton.textContent = loading ? "Refreshing…" : "Refresh Data";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message ?? "Request failed.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showLogin(message = "") {
  dashboardView.hidden = true;
  loginView.hidden = false;
  setMessage(loginError, message);
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
  setSection(state.section);
}

function setSection(section) {
  state.section = section;
  for (const button of document.querySelectorAll(".nav-item[data-section]")) {
    button.classList.toggle("is-active", button.dataset.section === section);
  }
  for (const panel of document.querySelectorAll("[data-section-panel]")) {
    panel.hidden = panel.dataset.sectionPanel !== section;
  }
}

function currentQuery() {
  const params = new URLSearchParams();
  params.set("search", filterSearch.value.trim());
  params.set("answer", filterAnswer.value);
  params.set("date", filterDate.value);
  params.set("sort", filterSort.value);
  params.set("page", String(state.page));
  params.set("pageSize", "10");
  return params;
}

function exportQuery(format) {
  const params = currentQuery();
  params.delete("page");
  params.delete("pageSize");
  params.set("format", format);
  return params.toString();
}

async function fetchReport(params) {
  return api(`/api/results?${params.toString()}`);
}

async function fetchLatest() {
  const params = new URLSearchParams();
  params.set("page", "1");
  params.set("pageSize", "4");
  params.set("sort", "newest");
  return fetchReport(params);
}

async function fetchAllFiltered() {
  const params = currentQuery();
  params.delete("page");
  params.set("pageSize", "100");

  let page = 1;
  let totalPages = 1;
  let latestPayload = null;
  const responses = [];

  do {
    params.set("page", String(page));
    latestPayload = await fetchReport(params);
    responses.push(...latestPayload.responses);
    totalPages = latestPayload.totalPages;
    page += 1;
  } while (page <= totalPages);

  return { summary: latestPayload, responses };
}

function submissionParts(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { date: "Unknown", time: "—" };
  const dateParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
  );
  return {
    date: `${dateParts.day} ${dateParts.month} ${dateParts.year}`,
    time: `${dateParts.hour}:${dateParts.minute}`
  };
}

function percent(count, total) {
  if (!total) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function answerText(answer) {
  if (answer === "yes") return "YES";
  if (answer === "no") return "NO";
  return "—";
}

function renderChart(root, report) {
  const yesPercent = percent(report.counts.yes, report.total);
  const noPercent = percent(report.counts.no, report.total);
  root.replaceChildren();

  const donut = element("div", "donut");
  donut.style.setProperty("--yes-stop", `${yesPercent}%`);
  donut.style.setProperty("--no-stop", `${yesPercent + noPercent}%`);
  donut.setAttribute("role", "img");
  donut.setAttribute("aria-label", `${report.total} total responses. YES ${report.counts.yes}, ${yesPercent} percent. NO ${report.counts.no}, ${noPercent} percent.`);

  const center = element("div", "donut__center");
  center.append(element("strong", "", String(report.total)), element("span", "", "Total responses"));
  donut.append(center);

  const legend = element("div", "legend");
  for (const [label, count, value, modifier] of [
    ["YES", report.counts.yes, yesPercent, ""],
    ["NO", report.counts.no, noPercent, "legend__swatch--no"]
  ]) {
    const item = element("div", "legend__item");
    const swatch = element("span", `legend__swatch ${modifier}`.trim());
    swatch.setAttribute("aria-hidden", "true");
    const details = element("div");
    details.append(
      element("span", "legend__label", label),
      element("span", "legend__value", `${count} response${count === 1 ? "" : "s"} · ${value.toFixed(1)}%`)
    );
    item.append(swatch, details);
    legend.append(item);
  }

  root.append(donut, legend);
}

function renderStats(report) {
  const yesPercent = percent(report.counts.yes, report.total);
  const noPercent = percent(report.counts.no, report.total);
  for (const node of document.querySelectorAll("[data-stat]")) {
    const key = node.dataset.stat;
    if (key === "total") node.textContent = String(report.total);
    if (key === "yes") node.textContent = String(report.counts.yes);
    if (key === "no") node.textContent = String(report.counts.no);
    if (key === "yes-percent") node.textContent = `${yesPercent.toFixed(1)}% of total`;
    if (key === "no-percent") node.textContent = `${noPercent.toFixed(1)}% of total`;
  }

  for (const chart of document.querySelectorAll("[data-chart]")) renderChart(chart, report);
  lastUpdated.textContent = `Updated ${submissionParts(report.generatedAt).date}, ${submissionParts(report.generatedAt).time}`;
  unclassifiedNote.hidden = !report.unclassified;
  if (report.unclassified) {
    unclassifiedNote.textContent = `${report.unclassified} older record${report.unclassified === 1 ? "" : "s"} without a valid response were preserved unchanged and are excluded from YES and NO counts.`;
  }
}

function renderLatest(report) {
  latestActivity.replaceChildren();
  if (!report.responses.length) {
    latestActivity.append(element("p", "table-empty", "No submissions yet."));
    return;
  }

  for (const response of report.responses) {
    const row = element("div", "latest-item");
    const details = element("div");
    const time = submissionParts(response.submittedAt);
    details.append(
      element("span", "latest-item__name", response.name || "Not provided"),
      element("span", "latest-item__time", `${time.date} · ${time.time}`)
    );
    const answer = element("span", `answer answer--${response.answer === "yes" || response.answer === "no" ? response.answer : "unknown"}`, answerText(response.answer));
    row.append(details, answer);
    latestActivity.append(row);
  }
}

function renderTable(report) {
  reportBody.replaceChildren();
  if (!report.responses.length) {
    const row = element("tr");
    const cell = element("td", "table-empty", "No responses match the selected filters.");
    cell.colSpan = 4;
    row.append(cell);
    reportBody.append(row);
  }

  for (const response of report.responses) {
    const row = element("tr");
    const time = submissionParts(response.submittedAt);
    const answerClass = response.answer === "yes" || response.answer === "no" ? response.answer : "unknown";
    row.append(
      element("td", "", response.name || "Not provided"),
      (() => {
        const cell = element("td");
        cell.append(element("span", `answer answer--${answerClass}`, answerText(response.answer)));
        return cell;
      })(),
      element("td", "", time.date),
      element("td", "", time.time)
    );
    reportBody.append(row);
  }

  reportCount.textContent = `${report.filteredTotal} record${report.filteredTotal === 1 ? "" : "s"}`;
  pageInfo.textContent = `Page ${report.page} of ${report.totalPages}`;
  previousPageButton.disabled = report.page <= 1;
  nextPageButton.disabled = report.page >= report.totalPages;
}

async function loadReport() {
  setLoading(true);
  setMessage(appError, "");
  try {
    const [report, latest] = await Promise.all([fetchReport(currentQuery()), fetchLatest()]);
    state.report = report;
    state.page = report.page;
    renderStats(report);
    renderLatest(latest);
    renderTable(report);
  } catch (error) {
    setMessage(appError, error.message || "Could not load dashboard data.");
  } finally {
    setLoading(false);
  }
}

function applyFilters() {
  state.page = 1;
  loadReport();
}

function buildPrintSheet(report, responses) {
  printReport.replaceChildren();

  const header = element("header", "print-header");
  header.append(
    element("h1", "", "Shams-ur-Rehman · Survey Report"),
    element("p", "", `Ward 07 – Kashrote Yadgaar · Generated ${submissionParts(report.generatedAt).date}, ${submissionParts(report.generatedAt).time}`)
  );

  const summary = element("div", "print-summary");
  const yesPercent = percent(report.counts.yes, report.total);
  const noPercent = percent(report.counts.no, report.total);
  for (const [label, value, hint] of [
    ["Total responses", report.total, "Recorded in the database"],
    ["YES responses", report.counts.yes, `${yesPercent.toFixed(1)}% of total`],
    ["NO responses", report.counts.no, `${noPercent.toFixed(1)}% of total`]
  ]) {
    const card = element("div");
    card.append(element("span", "", label), element("strong", "", String(value)), element("span", "", hint));
    summary.append(card);
  }

  const chart = element("div", "print-chart chart-layout");
  renderChart(chart, report);

  const table = element("table");
  const thead = element("thead");
  const headRow = element("tr");
  for (const label of ["Respondent Name", "Response", "Submission Date", "Submission Time"]) {
    headRow.append(element("th", "", label));
  }
  thead.append(headRow);

  const tbody = element("tbody");
  if (!responses.length) {
    const row = element("tr");
    const cell = element("td", "table-empty", "No responses match the selected filters.");
    cell.colSpan = 4;
    row.append(cell);
    tbody.append(row);
  }
  for (const response of responses) {
    const row = element("tr");
    const time = submissionParts(response.submittedAt);
    row.append(
      element("td", "", response.name || "Not provided"),
      element("td", "", answerText(response.answer)),
      element("td", "", time.date),
      element("td", "", time.time)
    );
    tbody.append(row);
  }
  table.append(thead, tbody);

  printReport.append(header, summary, chart, table, element("p", "print-footer", "Confidential · Authorized administrators only · Responses show public support, not verified election votes."));
}

async function preparePrint() {
  setLoading(true);
  try {
    const { summary, responses } = await fetchAllFiltered();
    buildPrintSheet(summary, responses);
    printReport.hidden = false;
    const cleanup = () => {
      printReport.hidden = true;
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    window.setTimeout(cleanup, 60000);
  } catch (error) {
    setMessage(appError, error.message || "Could not prepare the print report.");
  } finally {
    setLoading(false);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(loginError, "");
  const token = document.getElementById("admin-token").value.trim();
  if (!token) return;

  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    document.getElementById("admin-token").value = "";
    showDashboard();
    loadReport();
  } catch (error) {
    setMessage(loginError, error.message || "Sign in failed.");
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST" });
  } catch {
    setMessage(appError, "Could not end the admin session.");
  }
  showLogin();
});

for (const button of document.querySelectorAll(".nav-item[data-section]")) {
  button.addEventListener("click", () => setSection(button.dataset.section));
}

refreshButton.addEventListener("click", loadReport);
applyFiltersButton.addEventListener("click", applyFilters);
clearFiltersButton.addEventListener("click", () => {
  filterSearch.value = "";
  filterAnswer.value = "";
  filterDate.value = "";
  filterSort.value = "newest";
  applyFilters();
});

previousPageButton.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    loadReport();
  }
});

nextPageButton.addEventListener("click", () => {
  const totalPages = state.report?.totalPages ?? 1;
  if (state.page < totalPages) {
    state.page += 1;
    loadReport();
  }
});

document.getElementById("download-pdf").addEventListener("click", () => {
  window.location.href = `/api/results/export?${exportQuery("pdf")}`;
});

document.getElementById("download-csv").addEventListener("click", () => {
  window.location.href = `/api/results/export?${exportQuery("csv")}`;
});

document.getElementById("print-report-button").addEventListener("click", preparePrint);

filterSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyFilters();
  }
});

async function initialize() {
  try {
    const session = await api("/api/admin/session");
    if (!session.authenticated) {
      showLogin();
      return;
    }
    showDashboard();
    loadReport();
  } catch {
    showLogin();
  }
}

initialize();
