const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const {
  getConversation, getMessagesPage, getMessagesAround, searchMessages, canAccessConversation,
} = require('../db');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * GET /api/conversations/:id/messages?before=<id>&around=<id>&limit=<n>
 * - Mặc định trả 50 tin MỚI NHẤT (sắp xếp cũ → mới); has_more cho biết còn tin cũ hơn.
 * - before=<id>: lấy trang cũ hơn (dùng cho nút "Tải tin cũ hơn").
 * - around=<id>: lấy trang quanh một tin cụ thể (dùng khi nhảy tới kết quả tìm kiếm).
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
    const aroundId = parseInt(req.query.around, 10);
    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    if (Number.isInteger(aroundId)) {
      const page = getMessagesAround(convId, aroundId, limit);
      return res.json({ success: true, messages: page.messages, conversation, has_more: page.has_more });
    }
    const page = getMessagesPage(convId, Number.isInteger(beforeId) ? beforeId : null, limit);
    res.json({ success: true, messages: page.messages, conversation, has_more: page.has_more });
  } else {
    res.status(403).json({ error: 'Bạn không có quyền xem conversation này' });
  }
});

/**
 * GET /api/conversations/:id/search?q=<từ khóa>
 * Tìm trong lịch sử tin nhắn của conversation (nội dung + tên file đính kèm).
 * Tối đa 30 kết quả mới nhất; q phải dài 2–200 ký tự; wildcard LIKE được escape.
 */
router.get('/:convId/search', requireAuth, (req, res) => {
  const convId = parseInt(req.params.convId, 10);
  const conversation = getConversation(convId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation không tồn tại' });
  }
  if (!canAccessConversation(req.user, conversation)) {
    return res.status(403).json({ error: 'Bạn không có quyền xem conversation này' });
  }
  const q = String(req.query.q || '').trim();
  if (q.length < 2 || q.length > 200) {
    return res.status(400).json({ error: 'Từ khóa tìm kiếm phải từ 2 đến 200 ký tự' });
  }
  const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  res.json({ success: true, results: searchMessages(convId, escaped, 30) });
});

module.exports = router;