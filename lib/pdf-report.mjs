import { answerLabel, formatSubmission, percentage } from "./report.mjs";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const COLORS = {
  dark: [6, 69, 47],
  green: [8, 117, 45],
  yellow: [245, 212, 0],
  red: [227, 27, 35],
  white: [255, 255, 255],
  background: [247, 249, 245],
  text: [16, 42, 32],
  muted: [93, 113, 103],
  line: [219, 231, 223],
  light: [232, 239, 234]
};

function rgb([red, green, blue]) {
  return `${(red / 255).toFixed(3)} ${(green / 255).toFixed(3)} ${(blue / 255).toFixed(3)}`;
}

function escapeText(value) {
  return String(value ?? "")
    .split("")
    .map((character) => {
      const code = character.codePointAt(0);
      if (character === "\\" || character === "(" || character === ")") return `\\${character}`;
      if (code === 0x2013) return "\\226";
      if (code === 0x2014) return "\\227";
      if (code === 0x2018) return "\\221";
      if (code === 0x2019) return "\\222";
      if (code === 0x201c) return "\\223";
      if (code === 0x201d) return "\\224";
      if (code === 0x2022) return "\\225";
      if (code >= 32 && code <= 126) return character;
      if (code === 10 || code === 13) return " ";
      return "?";
    })
    .join("");
}

function drawText(content, x, top, value, options = {}) {
  const size = options.size ?? 10;
  const font = options.bold ? "/F2" : "/F1";
  const color = rgb(options.color ?? COLORS.text);
  content.push(`BT ${color} ${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${(PAGE_HEIGHT - top).toFixed(2)} Tm (${escapeText(value)}) Tj ET`);
}

function drawRect(content, x, top, width, height, color, radius = 0) {
  const bottom = PAGE_HEIGHT - top - height;
  if (radius > 0) {
    content.push(`${rgb(color)} ${x.toFixed(2)} ${bottom.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`);
    return;
  }
  content.push(`${rgb(color)} ${x.toFixed(2)} ${bottom.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`);
}

function drawRule(content, x, top, width, color = COLORS.line) {
  const y = PAGE_HEIGHT - top;
  content.push(`${rgb(color)} ${x.toFixed(2)} ${y.toFixed(2)} m ${(x + width).toFixed(2)} ${y.toFixed(2)} l 0.8 w S`);
}

function arcPoint(cx, cy, radius, angle) {
  return [cx + radius * Math.cos(angle), PAGE_HEIGHT - (cy + radius * Math.sin(angle))];
}

function drawArc(content, cx, cy, radius, start, end, width, color) {
  const steps = Math.max(12, Math.ceil(Math.abs(end - start) / (Math.PI / 36)));
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    points.push(arcPoint(cx, cy, radius, start + ((end - start) * index) / steps));
  }
  content.push(`${rgb(color)} ${width} w 1 J 1 j`);
  content.push(`n ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)} m`);
  for (const [x, y] of points.slice(1)) content.push(`${x.toFixed(2)} ${y.toFixed(2)} l`);
  content.push("S");
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function drawTableHeader(content, top) {
  drawRect(content, MARGIN, top, PAGE_WIDTH - MARGIN * 2, 24, COLORS.background);
  drawText(content, MARGIN + 8, top + 16, "Respondent Name", { bold: true, size: 8.5, color: COLORS.dark });
  drawText(content, 220, top + 16, "Response", { bold: true, size: 8.5, color: COLORS.dark });
  drawText(content, 310, top + 16, "Submission Date", { bold: true, size: 8.5, color: COLORS.dark });
  drawText(content, 425, top + 16, "Submission Time", { bold: true, size: 8.5, color: COLORS.dark });
}

function drawTableRow(content, record, top, striped) {
  if (striped) drawRect(content, MARGIN, top, PAGE_WIDTH - MARGIN * 2, 20, COLORS.background);
  const formatted = formatSubmission(record.submittedAt);
  drawText(content, MARGIN + 8, top + 14, truncate(record.name || "Not provided", 28), { size: 9, color: COLORS.text });
  drawText(content, 220, top + 14, answerLabel(record.answer), { bold: true, size: 9, color: record.answer === "no" ? COLORS.red : COLORS.green });
  drawText(content, 310, top + 14, formatted.date || "Unknown", { size: 9, color: COLORS.muted });
  drawText(content, 425, top + 14, formatted.time || "—", { size: 9, color: COLORS.muted });
  drawRule(content, MARGIN, top + 20, PAGE_WIDTH - MARGIN * 2);
}

function drawFooter(content, pageNumber, totalPages) {
  drawRule(content, MARGIN, 802, PAGE_WIDTH - MARGIN * 2);
  drawText(content, MARGIN, 818, "Confidential · Authorized administrators only", { size: 8, color: COLORS.muted });
  drawText(content, PAGE_WIDTH - MARGIN - 90, 818, `Page ${pageNumber} of ${totalPages}`, { size: 8, color: COLORS.muted });
}

function drawSummaryCard(content, x, top, label, value, detail) {
  drawRect(content, x, top, 154, 66, COLORS.background);
  drawText(content, x + 12, top + 20, label, { size: 8, bold: true, color: COLORS.muted });
  drawText(content, x + 12, top + 45, String(value), { size: 22, bold: true, color: COLORS.dark });
  drawText(content, x + 12, top + 59, detail, { size: 8, color: COLORS.muted });
}

function drawDonut(content, summary, top) {
  const cx = 140;
  const cy = top + 58;
  drawArc(content, cx, cy, 48, 0, Math.PI * 2, 18, COLORS.light);

  if (summary.total > 0) {
    const start = -Math.PI / 2;
    const yesEnd = start + Math.PI * 2 * (summary.counts.yes / summary.total);
    const noEnd = start + Math.PI * 2 * ((summary.counts.yes + summary.counts.no) / summary.total);
    if (summary.counts.yes > 0) drawArc(content, cx, cy, 48, start, yesEnd, 18, COLORS.green);
    if (summary.counts.no > 0) drawArc(content, cx, cy, 48, yesEnd, noEnd, 18, COLORS.red);
  }

  drawText(content, cx - 22, cy + 2, String(summary.total), { bold: true, size: 19, color: COLORS.dark });
  drawText(content, cx - 34, cy + 17, "Total responses", { size: 7.5, color: COLORS.muted });
}

function renderFirstPage(summary, rows, pageNumber, totalPages, generated) {
  const content = [];
  drawRect(content, 0, 0, PAGE_WIDTH, 104, COLORS.dark);
  drawRect(content, 0, 104, PAGE_WIDTH, 4, COLORS.yellow);
  drawText(content, MARGIN, 34, "SURVEY REPORT", { bold: true, size: 22, color: COLORS.white });
  drawText(content, MARGIN, 56, "Ward 07 – Kashrote Yadgaar", { size: 11, color: COLORS.yellow });
  drawText(content, MARGIN, 74, "Shams-ur-Rehman · Public Support Survey", { size: 10, color: COLORS.white });
  drawText(content, MARGIN, 90, `Generated: ${generated.date} ${generated.time}`, { size: 8, color: COLORS.white });

  drawSummaryCard(content, MARGIN, 126, "TOTAL RESPONSES", summary.total, "Recorded responses");
  drawSummaryCard(content, MARGIN + 166, 126, "YES RESPONSES", summary.counts.yes, `${summary.yesPercent.toFixed(1)}% of total`);
  drawSummaryCard(content, MARGIN + 332, 126, "NO RESPONSES", summary.counts.no, `${summary.noPercent.toFixed(1)}% of total`);

  drawText(content, MARGIN, 220, "Response distribution", { bold: true, size: 12, color: COLORS.dark });
  drawDonut(content, summary, 234);

  drawRect(content, 300, 252, 12, 12, COLORS.green);
  drawText(content, 320, 262, `YES   ${summary.counts.yes}   ${summary.yesPercent.toFixed(1)}%`, { size: 10, color: COLORS.text });
  drawRect(content, 300, 280, 12, 12, COLORS.red);
  drawText(content, 320, 290, `NO    ${summary.counts.no}   ${summary.noPercent.toFixed(1)}%`, { size: 10, color: COLORS.text });
  drawText(content, 300, 316, `Filtered records: ${summary.filteredTotal}`, { size: 9, color: COLORS.muted });
  if (summary.unclassified > 0) {
    drawText(content, 300, 332, `${summary.unclassified} older record(s) preserved without a valid response.`, { size: 8, color: COLORS.muted });
  }

  drawText(content, MARGIN, 368, "Survey responses", { bold: true, size: 12, color: COLORS.dark });
  drawTableHeader(content, 380);
  rows.forEach((record, index) => drawTableRow(content, record, 404 + index * 20, index % 2 === 1));
  if (!rows.length) drawText(content, MARGIN + 8, 424, "No responses match the selected filters.", { size: 10, color: COLORS.muted });
  drawFooter(content, pageNumber, totalPages);
  return content.join("\n");
}

function renderLaterPage(summary, rows, pageNumber, totalPages) {
  const content = [];
  drawRect(content, 0, 0, PAGE_WIDTH, 66, COLORS.dark);
  drawText(content, MARGIN, 28, "SURVEY REPORT · RESPONSES CONTINUED", { bold: true, size: 13, color: COLORS.white });
  drawText(content, MARGIN, 48, "Ward 07 – Kashrote Yadgaar · Shams-ur-Rehman", { size: 9, color: COLORS.yellow });
  drawText(content, MARGIN, 88, `Total responses: ${summary.total}   ·   YES: ${summary.counts.yes} (${summary.yesPercent.toFixed(1)}%)   ·   NO: ${summary.counts.no} (${summary.noPercent.toFixed(1)}%)`, { size: 9, color: COLORS.muted });
  drawTableHeader(content, 104);
  rows.forEach((record, index) => drawTableRow(content, record, 128 + index * 20, index % 2 === 1));
  drawFooter(content, pageNumber, totalPages);
  return content.join("\n");
}

function assemblePdf(contents) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [] /Count 0 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
  ];
  const pageObjectNumbers = [];

  for (const content of contents) {
    const pageNumber = objects.length + 1;
    const contentNumber = pageNumber + 1;
    pageObjectNumbers.push(pageNumber);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNumber} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

export function buildPdfReport(report) {
  const records = report.filteredRecords ?? [];
  const summary = {
    total: report.total,
    counts: report.counts,
    unclassified: report.unclassified ?? 0,
    filteredTotal: report.filteredTotal ?? records.length,
    yesPercent: percentage(report.counts.yes, report.total),
    noPercent: percentage(report.counts.no, report.total)
  };
  const generated = formatSubmission(report.generatedAt ?? new Date().toISOString());

  const chunks = [];
  if (records.length === 0) chunks.push([]);
  else {
    let cursor = 0;
    let first = true;
    while (cursor < records.length) {
      const size = first ? 15 : 30;
      chunks.push(records.slice(cursor, cursor + size));
      cursor += size;
      first = false;
    }
  }

  const contents = chunks.map((rows, index) => (
    index === 0
      ? renderFirstPage(summary, rows, 1, chunks.length, generated)
      : renderLaterPage(summary, rows, index + 1, chunks.length)
  ));
  return assemblePdf(contents);
}
