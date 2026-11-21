const loginView = document.querySelector("#login-view");
const dashboardView = document.querySelector("#dashboard-view");
const loginForm = document.querySelector("#login-form");
const loginButton = document.querySelector("#login-button");
const loginError = document.querySelector("#login-error");
const dashboardError = document.querySelector("#dashboard-error");
const adminToken = document.querySelector("#admin-token");
const stats = document.querySelector("#stats");
const meta = document.querySelector("#meta");
const report = document.querySelector("#report");
const reportBody = document.querySelector("#report-body");
const reportEmpty = document.querySelector("#report-empty");
const loading = document.querySelector("#loading");
const logoutButton = document.querySelector("#logout-button");

function showView(name) {
  loginView.hidden = name !== "login";
  dashboardView.hidden = name !== "dashboard";
  loading.hidden = true;
}

function setError(element, message) {
  element.textContent = message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.message ?? "Request failed. Please try again.");
  }
  return data;
}

function renderStats(data) {
  stats.replaceChildren();

  const cards = [
    { label: "Total responses", value: data.total },
    { label: "Yes", value: data.counts?.yes ?? 0 },
    { label: "No", value: data.counts?.no ?? 0 },
    { label: "Other", value: data.counts?.other ?? 0 }
  ];

  for (const card of cards) {
    const item = document.createElement("div");
    item.className = "stat";

    const value = document.createElement("strong");
    value.className = "stat__value";
    value.textContent = String(card.value);

    const label = document.createElement("span");
    label.className = "stat__label";
    label.textContent = card.label;

    item.append(value, label);
    stats.append(item);
  }

  const parts = [];
  if (data.firstSubmittedAt) parts.push(`First: ${formatDate(data.firstSubmittedAt)}`);
  if (data.lastSubmittedAt) parts.push(`Last: ${formatDate(data.lastSubmittedAt)}`);
  parts.push(`Updated: ${formatDate(data.generatedAt)}`);
  meta.textContent = parts.join(" · ");
}

function createCell(text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderReport(data) {
  const responses = data.responses ?? [];
  reportBody.replaceChildren();
  report.hidden = responses.length === 0;
  reportEmpty.hidden = responses.length !== 0;

  for (const item of responses) {
    const row = document.createElement("tr");
    const answer = String(item.answer);
    const answerKey = ["yes", "no", "other"].includes(answer) ? answer : "other";
    const answerCell = createCell("");
    const badge = document.createElement("span");
    badge.className = `report__answer report__answer--${answerKey}`;
    badge.textContent = answer.toUpperCase() || "UNKNOWN";
    answerCell.append(badge);

    row.append(
      createCell(item.name || "Not provided", "report__name"),
      answerCell,
      createCell(item.submittedAt ? formatDate(item.submittedAt) : "Unknown", "report__date")
    );
    reportBody.append(row);
  }
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

async function loadDashboard() {
  const data = await api("/api/results");
  renderStats(data);
  renderReport(data);
  setError(dashboardError, "");
  showView("dashboard");
}

async function refresh() {
  loading.hidden = false;
  setError(loginError, "");
  setError(dashboardError, "");

  try {
    const session = await api("/api/admin/session");
    if (session.authenticated) {
      await loadDashboard();
      return;
    }
    showView("login");
  } catch (error) {
    setError(loginError, error.message);
    showView("login");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loginButton.disabled) return;

  if (!adminToken.value) {
    setError(loginError, "Enter the admin token.");
    return;
  }

  loginButton.disabled = true;
  setError(loginError, "");

  try {
    await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: adminToken.value })
    });
    adminToken.value = "";
    await refresh();
  } catch (error) {
    setError(loginError, error.message);
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await api("/api/admin/logout", { method: "POST" });
    await refresh();
  } catch (error) {
    setError(dashboardError, error.message);
  } finally {
    logoutButton.disabled = false;
  }
});

refresh();
