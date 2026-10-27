const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const {
  db,
  getOrCreateConversation,
  getProcessEntries,
  getProcessEntry,
  insertProcessEntry,
  rateProcessEntry,
  deleteProcessEntry,
  getUserById,
  parseEntryAttachments,
} = require('../db');
const { journalWorkbookBuffer, ACTIVITY_LABELS } = require('../excel-export');

const ACTIVITIES = new Set([
  'sowing',
  'fertilizing',
  'watering',
  'pesticide',
  'pruning',
  'harvest',
  'other',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UPLOAD_URL_RE = /^\/uploads\/[A-Za-z0-9._-]+$/;
const TITLE_MAX = 120;
const METHOD_MAX = 160;
const DETAILS_MAX = 2000;
const ATTACHMENT_NAME_MAX = 200;
const ATTACHMENTS_MAX = 5;
const QUALITY_NOTE_MAX = 500;

// Năng suất/sản lượng: số không âm, làm tròn 2 chữ số thập phân (null = không nhập)
const METRICS = [
  { key: 'area_ha', label: 'Diện tích (ha)', max: 1000000 },
  { key: 'yield_per_ha', label: 'Năng suất (tấn/ha)', max: 100 },
  { key: 'output_tons', label: 'Sản lượng (tấn)', max: 10000000 },
];

function parseMetric(value, label, max) {
  if (value === undefined || value === null || value === '') return { value: null };
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > max) {
    return { error: `${label} phải là số từ 0 đến ${max}` };
  }
  return { value: Math.round(num * 100) / 100 };
}

function isValidCalendarDate(value) {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Partner chỉ xem được nhật ký của khách đã được admin gán cho mình. */
function canViewProcess(user, targetUserId) {
  if (user.role === 'admin') return true;
  if (user.role === 'user') return user.id === targetUserId;
  if (user.role === 'partner') {
    // Chỉ partner đang được gán trong thread user_admin của khách mới xem được nhật ký
    const conv = db
      .prepare("SELECT id FROM conversations WHERE kind = 'user_admin' AND user_id = ? AND partner_id = ?")
      .get(targetUserId, user.id);
    return !!conv;
  }
  return false;
}

function broadcastProcessUpdate(req, userId, action, entryId) {
  const io = req.app.get('io');
  if (!io) return;
  const user = getUserById(userId);
  if (!user) return;
  const conversation = getOrCreateConversation(userId);
  const payload = {
    userId,
    userName: user.display_name,
    convId: conversation.id,
    action,
    entryId,
  };
  io.to('admins').emit('process-updated', payload);
  io.to(`conv_${conversation.id}`).emit('process-updated', payload);
  // Partner đang được gán theo dõi nhật ký qua thread partner_user (join cả 2 thread
  // riêng nhưng chỉ nhận 1 bản tin để không toast trùng).
  if (conversation.partner_id) {
    const partnerThread = db
      .prepare(
        "SELECT id FROM conversations WHERE kind = 'partner_user' AND user_id = ? AND partner_id = ?"
      )
      .get(userId, conversation.partner_id);
    if (partnerThread) io.to(`conv_${partnerThread.id}`).emit('process-updated', payload);
  }
}

function parseTargetUser(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const SEASON_MONTHS = {
  'dong-xuan': [12, 1, 2, 3, 4],
  'he-thu': [5, 6, 7, 8],
  'thu-dong': [9, 10, 11],
};
const SEASON_LABELS = { 'dong-xuan': 'Đông Xuân', 'he-thu': 'Hè Thu', 'thu-dong': 'Thu Đông' };
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Lọc giống client (mùa vụ / hoạt động / khoảng ngày) cho file Excel
function filterProcessEntries(entries, query) {
  const season = typeof query.season === 'string' ? query.season : '';
  const activity = typeof query.activity === 'string' ? query.activity : '';
  const from = ISO_DATE_RE.test(query.from || '') ? query.from : '';
  const to = ISO_DATE_RE.test(query.to || '') ? query.to : '';
  return entries.filter((entry) => {
    if (season) {
      const month = Number(String(entry.performedAt || '').slice(5, 7));
      const months = SEASON_MONTHS[season];
      if (!months || !months.includes(month)) return false;
    }
    if (activity && entry.activity !== activity) return false;
    if (from && (entry.performedAt || '') < from) return false;
    if (to && (entry.performedAt || '') > to) return false;
    return true;
  });
}

function describeFilters(query) {
  const parts = [];
  if (SEASON_LABELS[query.season]) parts.push(`Mùa vụ: ${SEASON_LABELS[query.season]}`);
  if (ACTIVITY_LABELS[query.activity]) parts.push(`Hoạt động: ${ACTIVITY_LABELS[query.activity]}`);
  if (ISO_DATE_RE.test(query.from || '')) parts.push(`Từ ${query.from}`);
  if (ISO_DATE_RE.test(query.to || '')) parts.push(`Đến ${query.to}`);
  return parts.length ? parts.join(' · ') : 'Tất cả';
}

function asciiSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function sendXlsx(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

/**
 * GET /api/process?userId=<id>
 * - user: chỉ xem nhật ký của chính mình
 * - admin: xem của bất kỳ khách hàng nào
 * - partner: chỉ xem của khách được gán
 */
router.get('/', requireAuth, (req, res) => {
  const targetId = req.user.role === 'user'
    ? req.user.id
    : parseTargetUser(req.query.userId);

  if (!targetId) {
    return res.status(400).json({ error: 'Thiếu userId hợp lệ' });
  }
  const target = getUserById(targetId);
  if (!target || target.role !== 'user') {
    return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
  }
  if (!canViewProcess(req.user, targetId)) {
    return res.status(403).json({ error: 'Bạn không có quyền xem nhật ký canh tác này' });
  }
  res.json({ success: true, entries: getProcessEntries(targetId), user: target });
});

/**
 * GET /api/process/export?userId=&season=&activity=&from=&to=
 * Xuất Excel (.xlsx) nhật ký canh tác: sheet "Nhật ký" + sheet "Tổng hợp"
 * (diện tích, sản lượng, năng suất trung bình, phân bố chất lượng).
 * Quyền giống GET /api/process; bộ lọc giống bộ lọc trên giao diện.
 */
router.get('/export', requireAuth, async (req, res) => {
  const targetId = req.user.role === 'user' ? req.user.id : parseTargetUser(req.query.userId);
  if (!targetId) {
    return res.status(400).json({ error: 'Thiếu userId hợp lệ' });
  }
  const target = getUserById(targetId);
  if (!target || target.role !== 'user') {
    return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
  }
  if (!canViewProcess(req.user, targetId)) {
    return res.status(403).json({ error: 'Bạn không có quyền xem nhật ký canh tác này' });
  }
  // Khách hàng chỉ xuất CSV (client-side); Excel dành cho admin/partner
  if (req.user.role === 'user') {
    return res.status(403).json({ error: 'Khách hàng chỉ xuất CSV; Excel dành cho admin/partner' });
  }

  const entries = filterProcessEntries(getProcessEntries(targetId), req.query);
  try {
    const buffer = await journalWorkbookBuffer({
      entries,
      userName: target.display_name,
      filters: describeFilters(req.query),
    });
    const today = new Date().toISOString().slice(0, 10);
    sendXlsx(res, buffer, `nhat-ky-${asciiSlug(target.display_name) || 'khach'}-${today}.xlsx`);
  } catch (err) {
    console.error('Xuất Excel nhật ký lỗi:', err);
    res.status(500).json({ error: 'Không xuất được file Excel' });
  }
});

// POST /api/process: khách hàng tự ghi một mục nhật ký canh tác.
router.post('/', requireAuth, requireRole('user'), (req, res) => {
  const body = req.body || {};
  const activity = typeof body.activity === 'string' ? body.activity : '';
  const performedAt = typeof body.performed_at === 'string' ? body.performed_at.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const method = typeof body.method === 'string' ? body.method.trim() : '';
  const details = typeof body.details === 'string' ? body.details.trim() : '';

  if (!ACTIVITIES.has(activity)) {
    return res.status(400).json({ error: 'Hoạt động canh tác không hợp lệ' });
  }
  if (!isValidCalendarDate(performedAt)) {
    return res.status(400).json({ error: 'Ngày thực hiện phải có dạng YYYY-MM-DD' });
  }
  if (!title || title.length > TITLE_MAX) {
    return res.status(400).json({ error: `Tiêu đề phải dài 1–${TITLE_MAX} ký tự` });
  }
  if (method.length > METHOD_MAX) {
    return res.status(400).json({ error: `Phương pháp tối đa ${METHOD_MAX} ký tự` });
  }
  if (details.length > DETAILS_MAX) {
    return res.status(400).json({ error: `Chi tiết tối đa ${DETAILS_MAX} ký tự` });
  }

  // Diện tích / năng suất / sản lượng (dùng cho mục thu hoạch; để trống được)
  const metrics = {};
  for (const metric of METRICS) {
    const parsed = parseMetric(body[metric.key], metric.label, metric.max);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    metrics[metric.key] = parsed.value;
  }

  // Đính kèm: nhận `attachments` [{url, name}] (mới) hoặc `attachment` {url, name} (cũ)
  let attachments = [];
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments)) {
      return res.status(400).json({ error: 'Đính kèm không hợp lệ' });
    }
    attachments = body.attachments;
  } else if (body.attachment && typeof body.attachment === 'object') {
    attachments = [body.attachment];
  }
  if (attachments.length > ATTACHMENTS_MAX) {
    return res.status(400).json({ error: `Tối đa ${ATTACHMENTS_MAX} tệp đính kèm mỗi mục nhật ký` });
  }
  const cleanAttachments = [];
  for (const item of attachments) {
    if (!item || typeof item !== 'object') {
      return res.status(400).json({ error: 'Đính kèm không hợp lệ' });
    }
    const url = item.url;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (typeof url !== 'string' || !UPLOAD_URL_RE.test(url) || url.includes('..')) {
      return res.status(400).json({ error: 'Đính kèm không hợp lệ' });
    }
    if (!name || name.length > ATTACHMENT_NAME_MAX) {
      return res.status(400).json({ error: 'Tên đính kèm không hợp lệ' });
    }
    cleanAttachments.push({ url, name });
  }

  const entry = insertProcessEntry(req.user.id, {
    activity,
    performedAt,
    title,
    method,
    details,
    attachments: cleanAttachments,
    areaHa: metrics.area_ha,
    yieldPerHa: metrics.yield_per_ha,
    outputTons: metrics.output_tons,
  });
  const entryAttachments = parseEntryAttachments(entry.attachment_url, entry.attachment_name);
  const first = entryAttachments[0] || null;
  broadcastProcessUpdate(req, req.user.id, 'created', entry.id);
  res.status(201).json({
    success: true,
    entry: {
      id: entry.id,
      userId: entry.user_id,
      activity: entry.activity,
      performedAt: entry.performed_at,
      title: entry.title,
      method: entry.method,
      details: entry.details,
      attachments: entryAttachments,
      attachmentUrl: first ? first.url : null,
      attachmentName: first ? first.name : null,
      areaHa: entry.area_ha,
      yieldPerHa: entry.yield_per_ha,
      outputTons: entry.output_tons,
      qualityRating: entry.quality_rating,
      qualityNote: entry.quality_note,
      qualityRatedAt: entry.quality_rated_at,
      createdAt: entry.created_at,
    },
  });
});

/**
 * POST /api/process/:id/quality — chỉ admin chấm chất lượng mục nhật ký.
 * body: { rating: 1..5, note?: string ≤ 500 }
 * User/partner thấy kết quả khi tải lại nhật ký (kèm realtime process-updated).
 */
router.post('/:id/quality', requireAuth, requireRole('admin'), (req, res) => {
  const entryId = parseTargetUser(req.params.id);
  if (!entryId) {
    return res.status(400).json({ error: 'Id nhật ký không hợp lệ' });
  }
  const entry = getProcessEntry(entryId);
  if (!entry) {
    return res.status(404).json({ error: 'Không tìm thấy mục nhật ký' });
  }
  const body = req.body || {};
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Đánh giá chất lượng phải là số nguyên từ 1 đến 5' });
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > QUALITY_NOTE_MAX) {
    return res.status(400).json({ error: `Nhận xét chất lượng tối đa ${QUALITY_NOTE_MAX} ký tự` });
  }

  rateProcessEntry(entryId, rating, note);
  broadcastProcessUpdate(req, entry.user_id, 'rated', entryId);
  const updated = getProcessEntry(entryId);
  res.json({
    success: true,
    entry: {
      id: updated.id,
      qualityRating: updated.quality_rating,
      qualityNote: updated.quality_note,
      qualityRatedAt: updated.quality_rated_at,
    },
  });
});

// DELETE /api/process/:id: chủ nhật ký hoặc admin được xóa.
router.delete('/:id', requireAuth, (req, res) => {
  const entryId = parseTargetUser(req.params.id);
  if (!entryId) {
    return res.status(400).json({ error: 'Id nhật ký không hợp lệ' });
  }
  const entry = getProcessEntry(entryId);
  if (!entry) {
    return res.status(404).json({ error: 'Không tìm thấy mục nhật ký' });
  }
  const isOwner = req.user.role === 'user' && entry.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Bạn không có quyền xóa mục nhật ký này' });
  }

  deleteProcessEntry(entryId);
  broadcastProcessUpdate(req, entry.user_id, 'deleted', entryId);
  res.json({ success: true, deletedId: entryId });
});

module.exports = router;
