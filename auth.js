const bcrypt = require('bcryptjs');
const { db } = require('./db');

/**
 * Lấy thông tin user hiện tại từ session (gán bởi express-session)
 * Middleware: gắn `req.user` nếu đã login, ngược lại trả 401.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    const user = db.getUserByUsername(req.session.user.username);
    if (user) {
      req.user = user; // { id, username, password_hash, display_name, role, ... }
      return next();
    }
  }
  res.status(401).json({ error: 'Chưa đăng nhập' });
}

/**
 * Middleware kiểm tra role (ví dụ: requireRole('admin'), requireRole('partner')...)
 * @param {'admin'|'user'|'partner'} role - role cần kiểm tra
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
    if (req.user.role === role) return next();
    res.status(403).json({ error: `Không có quyền ${role}` });
  };
}

/**
 * POST /api/login: kiểm tra username/password, đăng nhập (gắn session)
 */
function login(req, res) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Thiếu username hoặc password' });
  }
  const user = db.getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu sai' });
  }
  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu sai' });
  }
  // Gán session (Express session tự lưu cookie connect.sid)
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name } });
}

/**
 * POST /api/logout: huỷ session
 */
function logout(req, res) {
  if (req.session) {
    req.session.destroy(() => {
      res.clearCookie('connect.sid'); // xóa cookie client
      res.json({ success: true });
    });
  } else {
    res.json({ success: true });
  }
}

/**
 * GET /api/me: trả về thông tin user hiện tại
 */
function me(req, res) {
  if (req.user) {
    res.json({ success: true, user: { id: req.user.id, username: req.user.username, role: req.user.role, display_name: req.user.display_name } });
  } else {
    res.status(401).json({ error: 'Chưa đăng nhập' });
  }
}

module.exports = { requireAuth, requireRole, login, logout, me };