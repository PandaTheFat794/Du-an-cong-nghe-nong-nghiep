const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const {
  db,
  getOrCreateConversation,
  getProcessEntries,
  getProcessEntry,
  insertProcessEntry,
  deleteProcessEntry,
  getUserById,
} = require('../db');

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

  let attachmentUrl = null;
  let attachmentName = null;
  if (body.attachment && typeof body.attachment === 'object') {
    const url = body.attachment.url;
    const name = typeof body.attachment.name === 'string' ? body.attachment.name.trim() : '';
    if (typeof url !== 'string' || !UPLOAD_URL_RE.test(url) || url.includes('..')) {
      return res.status(400).json({ error: 'Đính kèm không hợp lệ' });
    }
    if (!name || name.length > ATTACHMENT_NAME_MAX) {
      return res.status(400).json({ error: 'Tên đính kèm không hợp lệ' });
    }
    attachmentUrl = url;
    attachmentName = name;
  }

  const entry = insertProcessEntry(req.user.id, {
    activity,
    performedAt,
    title,
    method,
    details,
    attachmentUrl,
    attachmentName,
  });
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
      attachmentUrl: entry.attachment_url,
      attachmentName: entry.attachment_name,
      createdAt: entry.created_at,
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
