const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const { bcryptjs } = require('bcryptjs'); // alias
const db = require('../db');

// POST /api/register: user mới tự ký (chỉ admin mới tạo user, hoặc user tự ký với password)
router.post('/register', async (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password || !display_name) {
    return res.status(400).json({ error: 'Thiếu username, password hoặc display_name' });
  }
  try {
    const existing = db.getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
    }
    const passwordHash = await bcryptjs.hash(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
    ).run(username, passwordHash, display_name || username, 'user');
    // Tự động có conversation với admin (do trigger hoặc làm ở đây)
    db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(result.lastInsertRowid);
    res.status(201).json({ success: true, userId: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi server khi đăng ký' });
  }
});

router.post('/login', (req, res) => {
  // chỉ forward sang auth.js login middleware
  // nhưng chúng ta đã có hàmlogin ở auth.js, nên import và gọi
  const auth = require('../auth');
  auth.login(req, res);
});

router.post('/logout', (req, res) => {
  const auth = require('../auth');
  auth.logout(req, res);
});

router.get('/me', (req, res) => {
  const auth = require('../auth');
  auth.me(req, res);
});

module.exports = router;