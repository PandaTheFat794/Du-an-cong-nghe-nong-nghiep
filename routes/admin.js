const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const { db } = require('../db');

/**
 * GET /api/admin/users
 * Danh sách khách hàng (role='user') kèm tin cuối + số tin chưa đọc, cho sidebar Admin.
 */
router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare(
    `SELECT id, username, display_name, role, created_at FROM users WHERE role = 'user' ORDER BY created_at DESC`
  ).all();

  const lastMsgStmt = db.prepare(
    `SELECT m.content, m.attachment_name, m.created_at, u.display_name AS sender_name, u.role AS sender_role
     FROM messages m JOIN users u ON m.sender_id = u.id
     WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`
  );
  const convStmt = db.prepare('SELECT * FROM conversations WHERE user_id = ?');
  const unreadStmt = db.prepare(
    `SELECT COUNT(*) AS cnt FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = ? AND m.id > c.admin_last_read_id AND m.sender_id = c.user_id`
  );

  const result = users.map((u) => {
    const conv = convStmt.get(u.id);
    const convId = conv ? conv.id : null;
    const lastMsg = convId ? lastMsgStmt.get(convId) : null;
    const unreadCnt = convId ? unreadStmt.get(convId).cnt : 0;

    let preview = 'Chưa có tin nhắn';
    if (lastMsg) {
      preview = lastMsg.content || `[đính kèm: ${lastMsg.attachment_name || 'tệp'}]`;
    }

    return {
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      role: u.role,
      conversation_id: convId,
      last_message: preview,
      last_message_time: lastMsg ? lastMsg.created_at : null,
      unread_count: unreadCnt,
    };
  });

  res.json({ success: true, users: result });
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
