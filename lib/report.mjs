const TIME_ZONE = "Asia/Karachi";
const VALID_ANSWERS = new Set(["yes", "no"]);

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

function firstStringField(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function normalizeRecords(records) {
  return records
    .filter((record) => record && typeof record === "object" && !Array.isArray(record))
    .map((record) => ({
      ...record,
      id: typeof record.id === "string" ? record.id : "",
      name: firstStringField(record, ["name", "voterName", "respondentName", "fullName", "submittedBy"]),
      answer: typeof record.answer === "string" ? record.answer : "",
      submittedAt: typeof record.submittedAt === "string" ? record.submittedAt : ""
    }));
}

export function parseReportQuery(params) {
  const rawPage = Number.parseInt(params.get("page") ?? "1", 10);
  const rawPageSize = Number.parseInt(params.get("pageSize") ?? "10", 10);
  const answer = params.get("answer") ?? "";
  const date = params.get("date") ?? "";
  const sort = params.get("sort") ?? "newest";

  return {
    search: (params.get("search") ?? "").trim(),
    answer: VALID_ANSWERS.has(answer) ? answer : "",
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    sort: sort === "oldest" ? "oldest" : "newest",
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    pageSize: Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, 100) : 10
  };
}

function dateParts(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    date: dateTimeFormatter.format(new Date(timestamp)).split(",")[0].trim(),
    time: `${parts.hour}:${parts.minute}`
  };
}

export function formatSubmission(value) {
  return dateParts(value) ?? { dateKey: "", date: "", time: "" };
}

export function answerLabel(answer) {
  if (answer === "yes") return "YES";
  if (answer === "no") return "NO";
  return "—";
}

export function percentage(count, total) {
  if (!total) return 0;
  return Math.round((count / total) * 1000) / 10;
}

export function selectReportRecords(records, query = {}) {
  const search = String(query.search ?? "").trim().toLocaleLowerCase();
  const answer = VALID_ANSWERS.has(query.answer) ? query.answer : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(query.date ?? "") ? query.date : "";

  return normalizeRecords(records)
    .filter((record) => {
      if (search && !record.name.toLocaleLowerCase().includes(search)) return false;
      if (answer && record.answer !== answer) return false;
      if (date && dateParts(record.submittedAt)?.dateKey !== date) return false;
      return true;
    })
    .sort((left, right) => {
      const direction = query.sort === "oldest" ? 1 : -1;
      const leftTime = Date.parse(left.submittedAt);
      const rightTime = Date.parse(right.submittedAt);
      const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
      const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
      if (safeLeft !== safeRight) return (safeLeft - safeRight) * direction;
      return left.id.localeCompare(right.id) * direction;
    });
}

export function buildReport(records, query = {}) {
  const normalized = normalizeRecords(records);
  const counts = { yes: 0, no: 0 };
  let unclassified = 0;
  let firstSubmittedAt = null;
  let lastSubmittedAt = null;

  for (const record of normalized) {
    if (VALID_ANSWERS.has(record.answer)) counts[record.answer] += 1;
    else unclassified += 1;

    const value = record.submittedAt;
    if (Number.isFinite(Date.parse(value))) {
      if (!firstSubmittedAt || value < firstSubmittedAt) firstSubmittedAt = value;
      if (!lastSubmittedAt || value > lastSubmittedAt) lastSubmittedAt = value;
    }
  }

  const filtered = selectReportRecords(normalized, query);
  const pageSize = Number.isFinite(query.pageSize) && query.pageSize > 0
    ? Math.min(Math.trunc(query.pageSize), 100)
    : 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requestedPage = Number.isFinite(query.page) && query.page > 0 ? Math.trunc(query.page) : 1;
  const page = Math.min(requestedPage, totalPages);
  const responses = filtered.slice((page - 1) * pageSize, page * pageSize).map((record) => ({
    id: record.id,
    name: record.name || "Not provided",
    answer: record.answer,
    submittedAt: record.submittedAt
  }));

  return {
    total: normalized.length,
    counts,
    unclassified,
    filteredTotal: filtered.length,
    page,
    pageSize,
    totalPages,
    responses,
    filteredRecords: filtered,
    firstSubmittedAt,
    lastSubmittedAt,
    generatedAt: new Date().toISOString()
  };
}

function csvCell(value) {
  let cell = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}

export function buildCsv(records) {
  const rows = [["Respondent Name", "Response", "Submission Date", "Submission Time"].map(csvCell).join(",")];
  for (const record of normalizeRecords(records)) {
    const formatted = formatSubmission(record.submittedAt);
    rows.push([
      record.name || "Not provided",
      answerLabel(record.answer) === "—" ? String(record.answer || "UNKNOWN").toUpperCase() : answerLabel(record.answer),
      formatted.dateKey,
      formatted.time
    ].map(csvCell).join(","));
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

export function buildNdjson(records) {
  const body = normalizeRecords(records)
    .map((record) => JSON.stringify(record))
    .join("\n");
  return body ? `${body}\n` : "";
}
