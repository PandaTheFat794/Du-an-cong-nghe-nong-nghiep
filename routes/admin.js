const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const { db, ensurePartnerThreads, setBotEnabled } = require('../db');

/**
 * GET /api/admin/users
 * Danh sách khách hàng (role='user') kèm tin cuối + số tin chưa đọc của khách
 * và số tin partner chưa đọc trong thread partner_admin, cho sidebar Admin.
 * Một truy vấn duy nhất (trước đây 3 query / mỗi user).
 */
router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.role, u.created_at,
            c.id AS conversation_id,
            c.partner_id AS partner_id,
            c.bot_enabled AS bot_enabled,
            p.display_name AS partner_name,
            lm.content AS last_content,
            lm.attachment_name AS last_attachment_name,
            lm.created_at AS last_message_time,
            COALESCE((
              SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = c.id AND m.id > c.admin_last_read_id AND m.sender_id = c.user_id
            ), 0) AS unread_count,
            (SELECT pc.id FROM conversations pc
              WHERE pc.kind = 'partner_admin' AND pc.user_id = u.id AND pc.partner_id = c.partner_id
            ) AS partner_conversation_id,
            COALESCE((
              SELECT COUNT(*) FROM messages m
              JOIN conversations pc ON pc.id = m.conversation_id
              WHERE pc.kind = 'partner_admin' AND pc.user_id = u.id AND pc.partner_id = c.partner_id
                AND m.id > pc.admin_last_read_id AND m.sender_id = pc.partner_id
            ), 0) AS partner_unread,
            COALESCE((
              SELECT COUNT(*) FROM process_entries pe WHERE pe.user_id = u.id
            ), 0) AS process_count
     FROM users u
     LEFT JOIN conversations c ON c.user_id = u.id AND c.kind = 'user_admin'
     LEFT JOIN users p ON p.id = c.partner_id
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
    partner_id: u.partner_id,
    partner_name: u.partner_name,
    bot_enabled: u.bot_enabled === 1,
    partner_conversation_id: u.partner_conversation_id,
    partner_unread: u.partner_unread,
    last_message: u.last_message_time
      ? (u.last_content || `[đính kèm: ${u.last_attachment_name || 'tệp'}]`)
      : 'Chưa có tin nhắn',
    last_message_time: u.last_message_time,
    unread_count: u.unread_count,
    process_count: u.process_count,
  }));

  res.json({ success: true, users });
});

/**
 * GET /api/admin/stats?days=7|30|90
 * Tổng hợp cho dashboard admin theo khoảng thời gian (mặc định 7 ngày):
 * KPI tổng, tin nhắn theo ngày, nhật ký theo hoạt động, top khách hàng.
 * customers/partners là số toàn hệ thống; messages/processEntries/topCustomers
 * và 2 biểu đồ chỉ tính trong khoảng đã chọn.
 */
router.get('/stats', requireAuth, requireRole('admin'), (req, res) => {
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  if (![7, 30, 90].includes(days)) {
    return res.status(400).json({ error: 'days phải là 7, 30 hoặc 90' });
  }

  // Mốc đầu ngày local, tính lùi days-1 ngày (hôm nay + days-1 ngày trước = đủ days ngày)
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const pad = (n) => String(n).padStart(2, '0');
  const startDate = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;

  const totals = {
    customers: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'user'").get().c,
    partners: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'partner'").get().c,
    messages: db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE date(created_at, 'localtime') >= ?"
    ).get(startDate).c,
    processEntries: db.prepare(
      'SELECT COUNT(*) AS c FROM process_entries WHERE performed_at >= ?'
    ).get(startDate).c,
  };

  const byDayMap = new Map(
    db.prepare(
      "SELECT date(created_at, 'localtime') AS day, COUNT(*) AS cnt FROM messages GROUP BY day"
    ).all().map((r) => [r.day, r.cnt])
  );
  const messagesByDay = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    messagesByDay.push({ date: key, count: byDayMap.get(key) || 0 });
  }

  const processByActivity = db.prepare(
    `SELECT activity, COUNT(*) AS count FROM process_entries
     WHERE performed_at >= ? GROUP BY activity ORDER BY count DESC`
  ).all(startDate);

  const topCustomers = db.prepare(
    `SELECT u.id, u.display_name, COUNT(m.id) AS message_count
     FROM users u JOIN messages m ON m.sender_id = u.id
     WHERE u.role = 'user' AND date(m.created_at, 'localtime') >= ?
     GROUP BY u.id ORDER BY message_count DESC, u.id ASC LIMIT 5`
  ).all(startDate);

  res.json({ success: true, days, totals, messagesByDay, processByActivity, topCustomers });
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

  const conversation = db
    .prepare("SELECT * FROM conversations WHERE id = ? AND kind = 'user_admin'")
    .get(convId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation không tồn tại' });
  }

  const partner = db.prepare('SELECT * FROM users WHERE id = ?').get(partner_id);
  if (!partner || partner.role !== 'partner') {
    return res.status(404).json({ error: 'Partner không tồn tại hoặc sai role' });
  }

  db.prepare('UPDATE conversations SET partner_id = ? WHERE id = ?').run(partner_id, convId);
  // Tạo sẵn 2 thread riêng tư: partner↔khách và partner↔admin
  const { userThread, adminThread } = ensurePartnerThreads(conversation.user_id, partner.id);
  res.json({
    success: true,
    conversationId: convId,
    partnerId: Number(partner_id),
    partnerConversationId: adminThread.id,
    partnerUserConversationId: userThread.id,
  });
});

/**
 * POST /api/admin/conversations/:convId/disconnect
 * Hủy liên kết partner khỏi khách hàng. Giữ nguyên 2 thread partner_user/partner_admin
 * để bảo toàn lịch sử; partner mất quyền truy cập ngay vì canAccessConversation
 * kiểm tra lại user_admin.partner_id mỗi lần access.
 */
router.post('/conversations/:convId/disconnect', requireAuth, requireRole('admin'), (req, res) => {
  const convId = parseInt(req.params.convId, 10);
  const conversation = db
    .prepare("SELECT * FROM conversations WHERE id = ? AND kind = 'user_admin'")
    .get(convId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation không tồn tại' });
  }
  db.prepare('UPDATE conversations SET partner_id = NULL WHERE id = ?').run(convId);
  res.json({ success: true, conversationId: convId });
});

/**
 * POST /api/admin/conversations/:convId/bot
 * Admin bật/tắt bot chuyên gia cho thread user_admin của khách (body: { enabled }).
 */
router.post('/conversations/:convId/bot', requireAuth, requireRole('admin'), (req, res) => {
  const convId = parseInt(req.params.convId, 10);
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Thiếu enabled (true/false)' });
  }
  const conversation = db
    .prepare("SELECT * FROM conversations WHERE id = ? AND kind = 'user_admin'")
    .get(convId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation không tồn tại' });
  }
  setBotEnabled(convId, enabled);
  res.json({ success: true, conversationId: convId, botEnabled: enabled });
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
