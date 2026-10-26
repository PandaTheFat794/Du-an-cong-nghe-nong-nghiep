const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { getConversation, getMessagesPage, canAccessConversation } = require('../db');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * GET /api/conversations/:id/messages?before=<id>&limit=<n>
 * - Mặc định trả 50 tin MỚI NHẤT (sắp xếp cũ → mới); has_more cho biết còn tin cũ hơn.
 * - before=<id>: lấy trang cũ hơn (dùng cho nút "Tải tin cũ hơn").
 * - Mỗi thread riêng tư: user_admin (khách+admin), partner_user (khách+partner),
 *   partner_admin (partner+admin). Người ngoài thread nhận 403.
 */
router.get('/:convId/messages', requireAuth, (req, res) => {
  const convId = parseInt(req.params.convId, 10);

  // Lấy thông tin conversation để kiểm tra quyền
  const conversation = getConversation(convId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation không tồn tại' });
  }

  if (canAccessConversation(req.user, conversation)) {
    const beforeId = parseInt(req.query.before, 10);
    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    const page = getMessagesPage(convId, Number.isInteger(beforeId) ? beforeId : null, limit);
    res.json({ success: true, messages: page.messages, conversation, has_more: page.has_more });
  } else {
    res.status(403).json({ error: 'Bạn không có quyền xem conversation này' });
  }
});

module.exports = router;