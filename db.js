const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DB ghi ra file (mặc định ./data/app.db). E2E test trỏ DB_PATH sang file tạm riêng.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, {
  verbose: process.env.DB_DEBUG ? console.log : undefined,
});

// WAL: đọc không chặn ghi khi nhiều client chat realtime; busy_timeout chờ thay vì lỗi SQLITE_BUSY
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
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

// Bảng conversations: id, user_id (unique), partner_id (NULL = chưa kết nối),
// admin_last_read_id (id tin cuối admin đã đọc), created_at
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    partner_id INTEGER,
    admin_last_read_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (partner_id) REFERENCES users(id) ON DELETE SET NULL
  );
`);

// Migration DB cũ: admin_read_at (mốc thời gian, lệch ở biên giây) → admin_last_read_id
const convColumns = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
if (!convColumns.includes('admin_last_read_id')) {
  db.exec('ALTER TABLE conversations ADD COLUMN admin_last_read_id INTEGER NOT NULL DEFAULT 0');
  // Giữ nguyên trạng thái đã đọc hiện tại thay vì biến toàn bộ lịch sử thành "chưa đọc"
  db.exec(`
    UPDATE conversations SET admin_last_read_id = COALESCE((
      SELECT MAX(m.id) FROM messages m
      WHERE m.conversation_id = conversations.id AND m.created_at <= conversations.admin_read_at
    ), 0)
  `);
}
if (convColumns.includes('admin_read_at')) {
  db.exec('ALTER TABLE conversations DROP COLUMN admin_read_at');
}

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

// Index phủ truy vấn lịch sử + phân trang (WHERE conversation_id = ? AND id </> ?)
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, id);');

// Bảng process_entries: nhật ký canh tác do khách hàng tự ghi (ngày thực hiện,
// hoạt động, phương pháp, chi tiết, ảnh/tài liệu đính kèm).
db.exec(`
  CREATE TABLE IF NOT EXISTS process_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    activity TEXT NOT NULL,
    performed_at TEXT NOT NULL,
    title TEXT NOT NULL,
    method TEXT,
    details TEXT,
    attachment_url TEXT,
    attachment_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_process_entries_user ON process_entries(user_id, performed_at DESC, id DESC);'
);

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
  getMessagesLatest: db.prepare(
    `SELECT m.id, m.sender_id AS senderId, m.content, m.attachment_url AS attachmentUrl,
            m.attachment_name AS attachmentName, m.created_at AS createdAt,
            u.display_name AS senderName, u.role AS senderRole
     FROM messages m JOIN users u ON m.sender_id = u.id
     WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?`
  ),
  getMessagesBefore: db.prepare(
    `SELECT m.id, m.sender_id AS senderId, m.content, m.attachment_url AS attachmentUrl,
            m.attachment_name AS attachmentName, m.created_at AS createdAt,
            u.display_name AS senderName, u.role AS senderRole
     FROM messages m JOIN users u ON m.sender_id = u.id
     WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`
  ),
  getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (conversation_id, sender_id, content, attachment_url, attachment_name) VALUES (?, ?, ?, ?, ?)'
  ),
  // Đánh dấu đã đọc = ghi nhận id tin cuối cùng của conversation
  markAsRead: db.prepare(
    `UPDATE conversations SET admin_last_read_id = COALESCE(
       (SELECT MAX(id) FROM messages WHERE conversation_id = conversations.id), 0)
     WHERE id = ?`
  ),
  // Chưa đọc = tin của CHÍNH khách hàng sau mốc đã đọc (không tính tin admin tự gửi)
  countUnread: db.prepare(
    `SELECT COUNT(*) AS cnt FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = ? AND m.id > c.admin_last_read_id AND m.sender_id = c.user_id`
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
  getProcessEntries: db.prepare(
    `SELECT id, user_id AS userId, activity, performed_at AS performedAt, title, method, details,
            attachment_url AS attachmentUrl, attachment_name AS attachmentName, created_at AS createdAt
     FROM process_entries WHERE user_id = ?
     ORDER BY performed_at DESC, id DESC LIMIT 200`
  ),
  getProcessEntry: db.prepare('SELECT * FROM process_entries WHERE id = ?'),
  insertProcessEntry: db.prepare(
    `INSERT INTO process_entries
       (user_id, activity, performed_at, title, method, details, attachment_url, attachment_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  deleteProcessEntry: db.prepare('DELETE FROM process_entries WHERE id = ?'),
  getUserById: db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?'),
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

  // Một trang lịch sử (mới nhất trước khi đảo): lấy limit+1 để biết còn tin cũ hơn không.
  // beforeId = null → trang mới nhất; ngược lại → các tin có id < beforeId.
  getMessagesPage: (convId, beforeId, limit) => {
    const rows = beforeId
      ? statements.getMessagesBefore.all(convId, beforeId, limit + 1)
      : statements.getMessagesLatest.all(convId, limit + 1);
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), has_more: hasMore };
  },

  // chèn tin (kèm file đính kèm optional), trả về row đã lưu
  insertMessage: (convId, senderId, content, attachmentUrl = null, attachmentName = null) => {
    const info = statements.insertMessage.run(convId, senderId, content, attachmentUrl, attachmentName);
    return statements.getMessageById.get(info.lastInsertRowid);
  },

  // Đánh dấu admin đã đọc tới tin mới nhất (client gọi khi admin mở chat)
  markAsRead: (convId) => statements.markAsRead.run(convId),

  // Đếm tin chưa đọc của admin (chỉ tin do khách hàng gửi sau mốc đã đọc)
  countUnread: (convId) => statements.countUnread.get(convId).cnt,

  // Gán partner cho conversation
  connectPartner: (convId, partnerId) => statements.connectPartner.run(partnerId, convId),

  // Conversation kèm tên user + partner (nếu có)
  getConversation: (convId) => statements.getConversation.get(convId),

  // ===== Nhật ký canh tác =====
  getProcessEntries: (userId) => statements.getProcessEntries.all(userId),

  getProcessEntry: (id) => statements.getProcessEntry.get(id),

  insertProcessEntry: (userId, entry) => {
    const info = statements.insertProcessEntry.run(
      userId,
      entry.activity,
      entry.performedAt,
      entry.title,
      entry.method || null,
      entry.details || null,
      entry.attachmentUrl || null,
      entry.attachmentName || null
    );
    return statements.getProcessEntry.get(info.lastInsertRowid);
  },

  deleteProcessEntry: (id) => statements.deleteProcessEntry.run(id),

  getUserById: (id) => statements.getUserById.get(id),
};
