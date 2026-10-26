const session = require('express-session');
const { db } = require('./db');

const Store = session.Store;

// Bảng sessions: 1 bản ghi / 1 người đăng nhập, sống sót qua restart server
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    expire_at INTEGER NOT NULL
  );
`);

const EXPIRY_CLEANUP_INTERVAL = 30 * 60 * 1000;
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expire_at < ?').run(Date.now());
}, EXPIRY_CLEANUP_INTERVAL).unref();

class SQLiteSessionStore extends Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT payload, expire_at FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expire_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.payload));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expiresAt = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      db.prepare('INSERT OR REPLACE INTO sessions (sid, payload, expire_at) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), expiresAt);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

const store = new SQLiteSessionStore();

// Tra cứu user từ sessionId (dùng cho socket handshake, không qua HTTP session)
function getSessionUser(sid) {
  if (!sid || typeof sid !== 'string') return null;
  const row = db.prepare('SELECT payload, expire_at FROM sessions WHERE sid = ?').get(sid);
  if (!row || row.expire_at < Date.now()) return null;
  try {
    const payload = JSON.parse(row.payload);
    return payload && payload.user ? payload.user : null;
  } catch {
    return null;
  }
}

module.exports = { store, getSessionUser };
