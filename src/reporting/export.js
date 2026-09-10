import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';

const REPORT_FONT = fileURLToPath(new URL('../../assets/fonts/NotoSansDevanagari-Regular.ttf', import.meta.url));

export function csvCell(value) {
  let text = String(value ?? '');
  // Spreadsheet programs interpret formulas even inside CSV double quotes.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function attendanceCsv(report) {
  const columns = ['employeeId', 'employeeName', 'status', 'punchedInAt', 'punchedOutAt',
    'openingOdoKm', 'closingOdoKm', 'distanceKm', 'workedMinutes', 'punchOutLabel'];
  return '\uFEFF' + [columns, ...report.sessions.map((row) => columns.map((key) =>
    row[key] instanceof Date ? row[key].toISOString() : row[key]))]
    .map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function attendancePdf(report) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'GPSS attendance report' } });
  const buffers = [];
  const ready = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });
  doc.fontSize(20).text('GPSS Attendance Report');
  doc.moveDown().fontSize(10).text(`${report.range.from} to ${report.range.to} | UTC | Shifts starting in this range`);
  const showOvertime = Object.hasOwn(report, 'dailyOvertimeMinutes');
  doc.text('Open shifts excluded from worked time.');
  if (showOvertime) doc.text('Overtime follows the configured daily rule.');
  doc.moveDown();
  for (const row of report.summaries) {
    const name = `${row.employeeId}  ${row.employeeName}`;
    doc.font('Helvetica').fontSize(12);
    const needed = Math.max(100, doc.heightOfString(name) + 64);
    if (doc.y + needed > doc.page.height - 48) doc.addPage();
    const runs = name.split(/([\u0900-\u097f]+)/u).filter(Boolean);
    runs.forEach((run, index) => doc.font(/[\u0900-\u097f]/u.test(run) ? REPORT_FONT : 'Helvetica')
      .text(run, { continued: index < runs.length - 1 }));
    doc.font('Helvetica').fontSize(10).text(`${row.sessions} shifts | ${row.workedMinutes} worked minutes | ${row.distanceKm == null ? 'Distance not recorded' : `${row.distanceKm} km`}`);
    doc.text(`Open shifts: ${row.openSessions}${showOvertime ? ` | Overtime: ${row.overtimeMinutes ?? 'Not configured'}` : ''}`);
    doc.moveDown();
  }
  if (!report.summaries.length) doc.text('No attendance sessions in this range.');
  doc.end();
  return ready;
}
