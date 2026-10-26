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

module.exports = router;
