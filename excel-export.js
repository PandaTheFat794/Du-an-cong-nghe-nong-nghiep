// Xuất Excel (.xlsx) bằng ExcelJS: nhật ký canh tác chi tiết + tổng hợp,
// và dashboard thống kê admin. Không dùng dữ liệu người dùng trong công thức.
const ExcelJS = require('exceljs');

const ACTIVITY_LABELS = {
  sowing: 'Gieo hạt',
  fertilizing: 'Bón phân',
  watering: 'Tưới nước',
  pesticide: 'Phun thuốc',
  pruning: 'Tỉa cành',
  harvest: 'Thu hoạch',
  other: 'Khác',
};

const QUALITY_LABELS = {
  1: 'Kém',
  2: 'Yếu',
  3: 'Trung bình',
  4: 'Tốt',
  5: 'Rất tốt',
};

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0068FF' } };

function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tư vấn Nông nghiệp';
  wb.created = new Date();
  return wb;
}

function styleHeaderRow(row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle' };
  });
}

function finishSheet(ws, columnCount) {
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (columnCount) {
    const last = ws.getColumn(columnCount).letter;
    ws.autoFilter = { from: 'A1', to: `${last}1` };
  }
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function qualityText(rating) {
  if (!rating) return 'Chưa đánh giá';
  return `${rating}/5 · ${QUALITY_LABELS[rating] || ''}`;
}

function addJournalSheet(wb, entries, { sheetName = 'Nhật ký', includeUser = false } = {}) {
  const ws = wb.addWorksheet(sheetName);
  const columns = [
    ...(includeUser ? [{ header: 'Khách hàng', key: 'userName', width: 22 }] : []),
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Hoạt động', key: 'activity', width: 14 },
    { header: 'Ngày thực hiện', key: 'date', width: 14 },
    { header: 'Tiêu đề', key: 'title', width: 30 },
    { header: 'Phương pháp', key: 'method', width: 22 },
    { header: 'Chi tiết', key: 'details', width: 42 },
    { header: 'Diện tích (ha)', key: 'area', width: 14 },
    { header: 'Năng suất (tấn/ha)', key: 'yield', width: 17 },
    { header: 'Sản lượng (tấn)', key: 'output', width: 16 },
    { header: 'Chất lượng', key: 'quality', width: 17 },
    { header: 'Nhận xét chất lượng', key: 'qualityNote', width: 38 },
    { header: 'Ngày đánh giá', key: 'ratedAt', width: 18 },
    { header: 'Tệp đính kèm', key: 'attachments', width: 34 },
  ];
  ws.columns = columns;

  entries.forEach((entry, index) => {
    ws.addRow({
      ...(includeUser ? { userName: entry.userName || '' } : {}),
      stt: index + 1,
      activity: ACTIVITY_LABELS[entry.activity] || entry.activity,
      date: entry.performedAt || '',
      title: entry.title || '',
      method: entry.method || '',
      details: entry.details || '',
      area: entry.areaHa ?? null,
      yield: entry.yieldPerHa ?? null,
      output: entry.outputTons ?? null,
      quality: qualityText(entry.qualityRating),
      qualityNote: entry.qualityNote || '',
      ratedAt: entry.qualityRatedAt || '',
      attachments: (entry.attachments || []).map((a) => a.name || a.url).join('; '),
    });
  });

  styleHeaderRow(ws.getRow(1));
  finishSheet(ws, columns.length);
  for (const key of ['area', 'yield', 'output']) {
    ws.getColumn(key).numFmt = '0.00';
    ws.getColumn(key).alignment = { horizontal: 'right' };
  }
  ws.getColumn('details').alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn('qualityNote').alignment = { wrapText: true, vertical: 'top' };
  return ws;
}

function addSummarySheet(wb, entries, { userName = '', filters = 'Tất cả', sheetName = 'Tổng hợp' } = {}) {
  const ws = wb.addWorksheet(sheetName);
  ws.columns = [
    { header: 'Chỉ tiêu', key: 'label', width: 38 },
    { header: 'Giá trị', key: 'value', width: 26 },
  ];

  const harvest = entries.filter((e) => e.activity === 'harvest');
  const rated = entries.filter((e) => Number.isInteger(e.qualityRating));
  const totalArea = harvest.reduce((sum, e) => sum + (Number(e.areaHa) || 0), 0);
  const totalOutput = harvest.reduce((sum, e) => sum + (Number(e.outputTons) || 0), 0);
  const yields = harvest.map((e) => Number(e.yieldPerHa)).filter((v) => Number.isFinite(v));
  const avgYield = yields.length ? yields.reduce((a, b) => a + b, 0) / yields.length : 0;
  const avgQuality = rated.length
    ? rated.reduce((sum, e) => sum + e.qualityRating, 0) / rated.length
    : 0;

  const summaryRows = [
    ['Người ghi nhật ký', userName || 'Tất cả khách hàng'],
    ['Bộ lọc', filters],
    ['Thời điểm xuất', new Date().toLocaleString('vi-VN')],
    ['Tổng số mục nhật ký', entries.length],
    ['Số mục thu hoạch', harvest.length],
    ['Tổng diện tích thu hoạch (ha)', round2(totalArea)],
    ['Tổng sản lượng (tấn)', round2(totalOutput)],
    ['Năng suất trung bình (tấn/ha)', round2(avgYield)],
    ['Số mục đã đánh giá chất lượng', rated.length],
    ['Điểm chất lượng trung bình (1-5)', round2(avgQuality)],
    ['Mục chất lượng Tốt/Rất tốt (4-5)', rated.filter((e) => e.qualityRating >= 4).length],
    ['Mục chất lượng Kém/Yếu (1-2)', rated.filter((e) => e.qualityRating <= 2).length],
  ];
  summaryRows.forEach(([label, value]) => ws.addRow({ label, value }));
  styleHeaderRow(ws.getRow(1));
  ws.getColumn('label').font = { bold: true };

  ws.addRow([]);
  const distHeader = ws.addRow({ label: 'Phân bố chất lượng', value: 'Số mục' });
  styleHeaderRow(distHeader);
  for (let rating = 1; rating <= 5; rating += 1) {
    ws.addRow({
      label: `${rating} · ${QUALITY_LABELS[rating]}`,
      value: rated.filter((e) => e.qualityRating === rating).length,
    });
  }
  return ws;
}

async function journalWorkbookBuffer({ entries, userName, filters }) {
  const wb = newWorkbook();
  addJournalSheet(wb, entries);
  addSummarySheet(wb, entries, { userName, filters });
  return wb.xlsx.writeBuffer();
}

async function statsWorkbookBuffer({ days, totals, messagesByDay, processByActivity, topCustomers, journal }) {
  const wb = newWorkbook();

  const overview = wb.addWorksheet('Tổng quan');
  overview.columns = [
    { header: 'Chỉ tiêu', key: 'label', width: 32 },
    { header: 'Giá trị', key: 'value', width: 24 },
  ];
  [
    ['Khoảng thời gian', `${days} ngày gần nhất`],
    ['Thời điểm xuất', new Date().toLocaleString('vi-VN')],
    ['Khách hàng (toàn hệ thống)', totals.customers],
    ['Partner (toàn hệ thống)', totals.partners],
    ['Tin nhắn trong kỳ', totals.messages],
    ['Mục nhật ký trong kỳ', totals.processEntries],
  ].forEach(([label, value]) => overview.addRow({ label, value }));
  styleHeaderRow(overview.getRow(1));
  overview.getColumn('label').font = { bold: true };

  const byDay = wb.addWorksheet('Tin nhắn theo ngày');
  byDay.columns = [
    { header: 'Ngày', key: 'date', width: 16 },
    { header: 'Số tin nhắn', key: 'count', width: 16 },
  ];
  messagesByDay.forEach((item) => byDay.addRow({ date: item.date, count: item.count }));
  styleHeaderRow(byDay.getRow(1));
  finishSheet(byDay, 2);

  const activities = wb.addWorksheet('Hoạt động nhật ký');
  activities.columns = [
    { header: 'Hoạt động', key: 'activity', width: 20 },
    { header: 'Số mục', key: 'count', width: 14 },
  ];
  processByActivity.forEach((item) => activities.addRow({
    activity: ACTIVITY_LABELS[item.activity] || item.activity,
    count: item.count,
  }));
  styleHeaderRow(activities.getRow(1));
  finishSheet(activities, 2);

  const top = wb.addWorksheet('Top khách hàng');
  top.columns = [
    { header: 'Khách hàng', key: 'name', width: 28 },
    { header: 'Số tin nhắn', key: 'count', width: 16 },
  ];
  topCustomers.forEach((item) => top.addRow({ name: item.display_name, count: item.message_count }));
  styleHeaderRow(top.getRow(1));
  finishSheet(top, 2);

  addJournalSheet(wb, journal, { sheetName: 'Nhật ký trong kỳ', includeUser: true });
  addSummarySheet(wb, journal, {
    userName: 'Tất cả khách hàng',
    filters: `${days} ngày gần nhất`,
    sheetName: 'Tổng hợp nhật ký',
  });

  return wb.xlsx.writeBuffer();
}

module.exports = {
  journalWorkbookBuffer,
  statsWorkbookBuffer,
  ACTIVITY_LABELS,
  QUALITY_LABELS,
};
