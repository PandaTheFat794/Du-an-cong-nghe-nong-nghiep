const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getUserByUsername } = require('./db');

/**
 * Lấy (hoặc tạo) CSRF token gắn với session hiện tại.
 * Token sống theo session; session regenerate khi login → token mới.
 */
function getOrCreateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

/**
 * Middleware chặn request đổi dữ liệu không kèm CSRF token hợp lệ.
 * Client gửi token qua header X-CSRF-Token (lấy từ GET /api/csrf).
 */
function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token') || (req.body && req.body._csrf);
  if (!req.session || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'CSRF token không hợp lệ hoặc thiếu' });
  }
  next();
}

/**
 * Lấy thông tin user hiện tại từ session (gán bởi express-session)
 * Middleware: gắn `req.user` nếu đã login, ngược lại trả 401.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    const user = getUserByUsername(req.session.user.username);
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
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Thiếu username hoặc password' });
  }
  const user = getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu sai' });
  }
  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu sai' });
  }

  const sessionUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
  };

  // Cấp session id mới khi đăng nhập (chống session fixation). Phải lưu xong
  // vào store trước khi trả sessionId, vì client dùng nó để mở socket ngay.
  req.session.regenerate((err) => {
    if (err) {
      console.error('session regenerate error:', err);
      return res.status(500).json({ error: 'Lỗi tạo phiên đăng nhập' });
    }
    req.session.user = sessionUser;
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('session save error:', saveErr);
        return res.status(500).json({ error: 'Lỗi lưu phiên đăng nhập' });
      }
      res.json({ success: true, sessionId: req.session.id, user: sessionUser });
    });
  });
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
 * GET /api/me: trả về thông tin user hiện tại (đọc trực tiếp từ session)
 */
function me(req, res) {
  if (req.session && req.session.user) {
    return res.json({ success: true, user: req.session.user });
  }
  res.status(401).json({ error: 'Chưa đăng nhập' });
}

module.exports = {
  requireAuth, requireRole, login, logout, me, getOrCreateCsrfToken, requireCsrf,
};