const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const { db, ensurePartnerThreads } = require('../db');

/**
 * GET /api/partner/conversations
 * Danh sách khách được admin gán cho partner hiện tại, kèm 2 thread riêng tư:
 * partner↔khách (user_conversation_id) và partner↔admin (admin_conversation_id).
 */
router.get('/conversations', requireAuth, requireRole('partner'), (req, res) => {
  const rows = db.prepare(
    `SELECT u.id AS user_id, u.display_name AS user_name,
            (SELECT COUNT(*) FROM process_entries pe WHERE pe.user_id = u.id) AS process_count
     FROM conversations c
     JOIN users u ON c.user_id = u.id
     WHERE c.kind = 'user_admin' AND c.partner_id = ?
     ORDER BY c.id DESC`
  ).all(req.user.id);

  const countMessages = db.prepare(
    'SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id IN (?, ?)'
  );

  const conversations = rows.map((row) => {
    const { userThread, adminThread } = ensurePartnerThreads(row.user_id, req.user.id);
    return {
      user_id: row.user_id,
      user_name: row.user_name,
      process_count: row.process_count,
      message_count: countMessages.get(userThread.id, adminThread.id).cnt,
      user_conversation_id: userThread.id,
      admin_conversation_id: adminThread.id,
    };
  });

  res.json({ success: true, conversations });
});

module.exports = router;
