const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { getConversation, getMessagesPage } = require('../db');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * GET /api/conversations/:id/messages?before=<id>&limit=<n>
 * - Mặc định trả 50 tin MỚI NHẤT (sắp xếp cũ → mới); has_more cho biết còn tin cũ hơn.
 * - before=<id>: lấy trang cũ hơn (dùng cho nút "Tải tin cũ hơn").
 * - Owner của conversation (user) -> xem được toàn bộ (kể cả partner đã gán)
 * - Partner được gán cho conversation -> xem được lịch sử (chỉ đọc)
 * - Admin -> xem được mọi conversation
 */
router.get('/:convId/messages', requireAuth, (req, res) => {
  const convId = parseInt(req.params.convId, 10);
  const userId = req.user.id;

  // Lấy thông tin conversation để kiểm tra quyền
  const conversation = getConversation(convId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation không tồn tại' });
  }

  // Quyền kiểm tra:
  // 1. Nếu là admin => cho phép
  // 2. Nếu là owner (user_id khớp) => cho phép
  // 3. Nếu là partner được gán (partner_id khớp) => cho phép (chỉ đọc nhưng ko gửi)
  const isAdmin = req.user.role === 'admin';
  const isOwner = conversation.user_id === userId;
  const isPartner = conversation.partner_id && conversation.partner_id === userId;

  if (isAdmin || isOwner || isPartner) {
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