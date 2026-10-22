const Database = require('better-sqlite3');

// Mở/Create file data/app.db (không cần tạo folder riêng, better-sqlite3 tự tạo file)
const db = new Database('./data/app.db', { verbose: console.log });

// Bảng users: id, username (unique), password_hash, display_name, role, created_at
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Bảng conversations: id, user_id (unique), partner_id (NULL = chưa kết nối), admin_read_at, created_at
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    partner_id INTEGER,
    admin_read_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (partner_id) REFERENCES users(id) ON DELETE SET NULL
  );
`);

// Bảng messages: id, conversation_id, sender_id, content, created_at
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Seed tài khoản mặc định nếu DB rỗng (chạy 1 lần đầu)
const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  const bcrypt = require('bcryptjs');
  const adminPasswordHash = bcrypt.hashSync('admin123', 10);
  const userPasswordHash = bcrypt.hashSync('user123', 10);

  const adminUser = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
  ).run('admin', adminPasswordHash, 'Quản trị viên', 'admin');

  const partnerUser = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
  ).run('partner1', adminPasswordHash, 'Partner Test', 'partner');

  const user1 = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
  ).run('user1', userPasswordHash, 'Khách hàng Test', 'user');

  // Mỗi user tự động có 1 conversation duy nhất với admin
  db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(adminUser.lastInsertRowid);
  db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(partnerUser.lastInsertRowid);
  db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(user1.lastInsertRowid);

  console.log('✅ DB seeded: admin / admin123, partner1 / partner123, user1 / user123');
} else {
  console.log('ℹ️ DB đã có dữ liệu, bỏ qua seed.');
}

// Export helpers dùng cho routes
module.exports = {
  db,
  // Lấy user để so sánh password (từ middleware)
  getUserByUsername: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username),
  // Tìm hoặc tạo conversation cho user_id (kiều 1-1 với admin)
  getOrCreateConversation: (userId) => {
    // Dùng transaction an toàn
    return db.transaction(() => {
      // Kiểm tra conversation đã có cho user này chưa
      let conv = db.prepare('SELECT * FROM conversations WHERE user_id = ?').get(userId);
      if (!conv) {
        // Nếu chưa có → tạo mới (chỉ khi DB rỗng, trường hợp test)
        conv = db.prepare('INSERT INTO conversations (user_id) VALUES (?)').run(userId).lastInsertRowid;
      }
      return conv;
    })();
  },
  // Lấy tất cả messages của 1 conversation
  getMessages: (convId) =>
    db
      .prepare(
        `SELECT m.content, m.created_at, u.display_name, u.role FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.conversation_id = ? ORDER BY m.created_at ASC`,
      )
      .all(convId),
  // Gửi message mới
  insertMessage: (convId, senderId, content) =>
    db.prepare('INSERT INTO messages (conversation_id, sender_id, content) VALUES (?, ?, ?)').run(convId, senderId, content),
  // Cập nhật admin_read_at (client gọi khiadmin mở chat)
  markAsRead: (convId, adminId) =>
    db
      .prepare(`UPDATE conversations SET admin_read_at = datetime('now') WHERE id = ?`)
      .run(convId),
  // Đếm tin nhắn chưa đọc (tin mới sau lần admin đã đọc trước)
  countUnread: (convId, adminReadAt) =>
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ? AND created_at > ?`,
      )
      .get(convId, adminReadAt).cnt,
  // Gán partner cho conversation
  connectPartner: (convId, partnerId) =>
    db.prepare('UPDATE conversations SET partner_id = ? WHERE id = ?').run(partnerId, convId),
  // Lấy thông tin conversation kèm user + partner (nếu có)
  getConversation: (convId) =>
    db.prepare(
      `SELECT c.*, u.display_name AS user_name, u.role AS user_role, p.display_name AS partner_name, p.role AS partner_role FROM conversations c LEFT JOIN users u ON c.user_id = u.id LEFT JOIN users p ON c.partner_id = p.id WHERE c.id = ?`,
    ).get(convId),
};