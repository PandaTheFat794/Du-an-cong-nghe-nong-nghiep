const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const { db } = require('../db');

/**
 * GET /api/partner/conversations
 * Danh sách khách hàng được admin gán cho partner hiện tại (kèm số tin nhắn).
 */
router.get('/conversations', requireAuth, requireRole('partner'), (req, res) => {
  const conversations = db.prepare(
    `SELECT c.id AS conversation_id, u.id AS user_id, u.display_name AS user_name,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c
     JOIN users u ON c.user_id = u.id
     WHERE c.partner_id = ?
     ORDER BY c.id DESC`
  ).all(req.user.id);

  res.json({ success: true, conversations });
});

module.exports = router;
