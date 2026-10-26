const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DB ghi ra file (mặc định ./data/app.db). E2E test trỏ DB_PATH sang file tạm riêng.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, {
  verbose: process.env.DB_DEBUG ? console.log : undefined,
});

// Bật ràng buộc khóa ngoại để DELETE user tự cascade sang conversations/messages
db.pragma('foreign_keys = ON');

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

// Bảng messages: tin nhắn chat, kèm file đính kèm (optional)
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    attachment_url TEXT,
    attachment_name TEXT,
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

  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
  );

  // Lưu ý: partner1 seed bằng admin123 để tiện test (partner1/admin123)
  const adminUser = insertUser.run('admin', adminPasswordHash, 'Quản trị viên', 'admin');
  const partnerUser = insertUser.run('partner1', adminPasswordHash, 'Partner Test', 'partner');
  const user1 = insertUser.run('user1', userPasswordHash, 'Khách hàng Test', 'user');

  // Mỗi user tự động có 1 conversation duy nhất với admin
  const insertConv = db.prepare('INSERT INTO conversations (user_id) VALUES (?)');
  insertConv.run(adminUser.lastInsertRowid);
  insertConv.run(partnerUser.lastInsertRowid);
  insertConv.run(user1.lastInsertRowid);

  console.log('✅ DB seeded: admin/admin123, partner1/admin123, user1/user123');
}

const statements = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getConversationByUserId: db.prepare('SELECT * FROM conversations WHERE user_id = ?'),
  insertConversation: db.prepare('INSERT INTO conversations (user_id) VALUES (?)'),
  getMessages: db.prepare(
    `SELECT m.id, m.sender_id AS senderId, m.content, m.attachment_url AS attachmentUrl,
            m.attachment_name AS attachmentName, m.created_at AS createdAt,
            u.display_name AS senderName, u.role AS senderRole
     FROM messages m JOIN users u ON m.sender_id = u.id
     WHERE m.conversation_id = ? ORDER BY m.id ASC`
  ),
  getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (conversation_id, sender_id, content, attachment_url, attachment_name) VALUES (?, ?, ?, ?, ?)'
  ),
  markAsRead: db.prepare(`UPDATE conversations SET admin_read_at = datetime('now') WHERE id = ?`),
  countUnread: db.prepare(
    'SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ? AND created_at > ?'
  ),
  connectPartner: db.prepare('UPDATE conversations SET partner_id = ? WHERE id = ?'),
  getConversation: db.prepare(
    `SELECT c.*, u.display_name AS user_name, u.role AS user_role,
            p.display_name AS partner_name, p.role AS partner_role
     FROM conversations c
     LEFT JOIN users u ON c.user_id = u.id
     LEFT JOIN users p ON c.partner_id = p.id
     WHERE c.id = ?`
  ),
};

module.exports = {
  db,

  getUserByUsername: (username) => statements.getUserByUsername.get(username),

  // Tìm hoặc tạo conversation 1-1 của user với admin (luôn trả về row object)
  getOrCreateConversation: (userId) =>
    db.transaction(() => {
      const conv = statements.getConversationByUserId.get(userId);
      if (conv) return conv;
      const info = statements.insertConversation.run(userId);
      return statements.getConversationByUserId.get(info.lastInsertRowid);
    })(),

  getMessages: (convId) => statements.getMessages.all(convId),

  // chèn tin (kèm file đính kèm optional), trả về row đã lưu
  insertMessage: (convId, senderId, content, attachmentUrl = null, attachmentName = null) => {
    const info = statements.insertMessage.run(convId, senderId, content, attachmentUrl, attachmentName);
    return statements.getMessageById.get(info.lastInsertRowid);
  },

  // Cập nhật admin_read_at (client gọi khi admin mở chat)
  markAsRead: (convId) => statements.markAsRead.run(convId),

  // Đếm tin nhắn chưa đọc (tin mới sau lần admin đọc gần nhất)
  countUnread: (convId, adminReadAt) => statements.countUnread.get(convId, adminReadAt).cnt,

  // Gán partner cho conversation
  connectPartner: (convId, partnerId) => statements.connectPartner.run(partnerId, convId),

  // Conversation kèm tên user + partner (nếu có)
  getConversation: (convId) => statements.getConversation.get(convId),
};
