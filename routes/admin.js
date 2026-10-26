const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const { db } = require('../db');

/**
 * GET /api/admin/users
 * Danh sách khách hàng (role='user') kèm tin cuối + số tin chưa đọc, cho sidebar Admin.
 * Một truy vấn duy nhất (trước đây 3 query / mỗi user).
 */
router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.role, u.created_at,
            c.id AS conversation_id,
            lm.content AS last_content,
            lm.attachment_name AS last_attachment_name,
            lm.created_at AS last_message_time,
            COALESCE((
              SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.id > c.admin_last_read_id AND m.sender_id = c.user_id
            ), 0) AS unread_count
     FROM users u
     LEFT JOIN conversations c ON c.user_id = u.id
     LEFT JOIN messages lm ON lm.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.conversation_id = c.id)
     WHERE u.role = 'user'
     ORDER BY u.created_at DESC`
  ).all();

  const users = rows.map((u) => ({
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    conversation_id: u.conversation_id,
    last_message: u.last_message_time
      ? (u.last_content || `[đính kèm: ${u.last_attachment_name || 'tệp'}]`)
      : 'Chưa có tin nhắn',
    last_message_time: u.last_message_time,
    unread_count: u.unread_count,
  }));

  res.json({ success: true, users });
});

/**
 * GET /api/admin/partners
 * Danh sách tài khoản partner để admin chọn gán cho khách.
 */
router.get('/partners', requireAuth, requireRole('admin'), (req, res) => {
  const partners = db.prepare(
    `SELECT id, username, display_name FROM users WHERE role = 'partner' ORDER BY display_name ASC`
  ).all();
  res.json({ success: true, partners });
});

/**
 * POST /api/admin/conversations/:convId/connect
 * Gán partner cho conversation (body: { partner_id }).
 */
router.post('/conversations/:convId/connect', requireAuth, requireRole('admin'), (req, res) => {
  const convId = parseInt(req.params.convId, 10);
  const { partner_id } = req.body || {};
  if (!partner_id || isNaN(partner_id)) {
    return res.status(400).json({ error: 'Thiếu partner_id hợp lệ' });
  }

  const conversation = db.prepare('SELECT id FROM conversations WHERE id = ?').get(convId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation không tồn tại' });
  }

  const partner = db.prepare('SELECT * FROM users WHERE id = ?').get(partner_id);
  if (!partner || partner.role !== 'partner') {
    return res.status(404).json({ error: 'Partner không tồn tại hoặc sai role' });
  }

  db.prepare('UPDATE conversations SET partner_id = ? WHERE id = ?').run(partner_id, convId);
  res.json({ success: true, conversationId: convId, partnerId: Number(partner_id) });
});

/**
 * DELETE /api/admin/users/:userId
 * Admin xóa tài khoản khách hàng (cascade xóa conversation + tin nhắn).
 */
router.delete('/users/:userId', requireAuth, requireRole('admin'), (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const target = Number.isInteger(userId) ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
  if (!target || target.role !== 'user') {
    return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ success: true, deletedUserId: userId });
});

module.exports = router;
