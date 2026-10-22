const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const db = require('../db');

/**
 * GET /api/admin/users
 * Trả về danh sách user (khách hàng) kèm tin nhắn cuối + số tin chưa đọc (cho admin).
 * Chỉ hiển thị user có role = 'user' (không phải admin/partner).
 */
router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  // Lấy tất cả users có role = user
  const users = db.prepare(
    `SELECT id, username, display_name, role, created_at FROM users WHERE role = 'user' ORDER BY created_at DESC`,
  ).all();

  // Đồng bộ thêm thông tin conversation + last message + unread count
  const result = [];
  for (const u of users) {
    // Lấy conversation của user này (mỗi user có 1 conversation duy nhất)
    const convRow = db.prepare('SELECT * FROM conversations WHERE user_id = ?').get(u.id);
    const convId = convRow ? convRow.id : null;

    // Lấy tin nhắn cuối cùng của conversation
    const lastMsgRow = convId
      ? db.prepare(
          `SELECT m.content, m.created_at, u.display_name AS sender_name, u.role AS sender_role FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.conversation_id = ? ORDER BY m.created_at DESC LIMIT 1`,
        ).get(convId)
      : null;

    // Đếm tin nhắn chưa đọc (tin mới sau lần admin đã đọc trước)
    const unreadCnt = convId
      ? db.prepare(
          `SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ? AND created_at > (SELECT admin_read_at FROM conversations WHERE id = ?)`,
        ).get(convId, convId).cnt
      : 0;

    result.push({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      role: u.role,
      conversation_id: convId,
      last_message: lastMsgRow ? lastMsgRow.content : 'Chưa có tin nhắn',
      last_message_time: lastMsgRow ? lastMsgRow.created_at : null,
      unread_count: unreadCnt,
    });
  }
  res.json({ success: true, users: result });
});

/**
 * POST /api/admin/conversations/:id/connect
 * Gán partner cho conversation (body: { partner_id: number }).
 * Chỉ admin mới được quyền.
 */
router.post('/conversations/:convId/connect', requireAuth, requireRole('admin'), (req, res) => {
  const convId = parseInt(req.params.convId, 10);
  const { partner_id } = req.body;
  if (!partner_id || isNaN(partner_id)) {
    return res.status(400).json({ error: 'Thiếu partner_id hợp lệ' });
  }
  // Kiểm tra partner tồn tại và role = partner
  const partnerRow = db.prepare('SELECT * FROM users WHERE id = ?').get(partner_id);
  if (!partnerRow || partnerRow.role !== 'partner') {
    return res.status(404).json({ error: 'Partner không tồn tại hoặc sai role' });
  }
  // Cập nhật conversation gán partner
  db.prepare('UPDATE conversations SET partner_id = ? WHERE id = ?').run(partner_id, convId);
  res.json({ success: true, conversationId: convId, partnerId: partner_id });
});

module.exports = router;