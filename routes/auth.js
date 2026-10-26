const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const auth = require('../auth');
const { db, getUserByUsername, getOrCreateConversation } = require('../db');

// POST /api/register: khách hàng tự đăng ký tài khoản (role='user')
router.post('/register', (req, res) => {
  const { username, password, display_name } = req.body || {};
  if (!username || !password || !display_name) {
    return res.status(400).json({ error: 'Thiếu username, password hoặc display_name' });
  }
  try {
    if (getUserByUsername(username)) {
      return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
    ).run(username, passwordHash, display_name, 'user');
    // Mỗi user tự động có 1 conversation 1-1 với admin
    db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(info.lastInsertRowid);
    res.status(201).json({ success: true, userId: Number(info.lastInsertRowid) });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'Lỗi server khi đăng ký' });
  }
});

router.post('/login', auth.login);
router.post('/logout', auth.logout);

// GET /api/me: user hiện tại; role 'user' được kèm conversation_id để vào trang chat
router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }
  const user = req.session.user;
  const payload = { success: true, user };
  if (user.role === 'user') {
    payload.conversation_id = getOrCreateConversation(user.id).id;
  }
  res.json(payload);
});

// POST /api/me/password: đổi mật khẩu (mọi role đã đăng nhập)
router.post('/me/password', auth.requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Thiếu mật khẩu hiện tại hoặc mật khẩu mới' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu mới cần tối thiểu 6 ký tự' });
  }
  const user = getUserByUsername(req.user.username);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  res.json({ success: true });
});

// DELETE /api/me: khách hàng tự xóa tài khoản (cascade xóa conversation + lịch sử chat)
router.delete('/me', auth.requireAuth, (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'Chỉ khách hàng tự xóa được tài khoản của mình' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

module.exports = router;
