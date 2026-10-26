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

// Bảng conversations: mỗi khách có 1 thread với admin (kind='user_admin').
// Khi admin gán partner, tạo thêm 2 thread riêng: partner_user (partner↔khách)
// và partner_admin (partner↔admin). Mỗi thread chỉ đúng 2 bên đọc/gửi được.
const CONVERSATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'user_admin',
    user_id INTEGER NOT NULL,
    partner_id INTEGER,
    admin_last_read_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (partner_id) REFERENCES users(id) ON DELETE SET NULL
  );
`;

const existingConvTable = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
  .get();

if (!existingConvTable) {
  db.exec(CONVERSATIONS_SCHEMA);
} else {
  const convColumns = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);

  // Migration DB cũ: admin_read_at (mốc thời gian, lệch ở biên giây) → admin_last_read_id
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

  // DB cũ có UNIQUE(user_id) → rebuild để một khách có nhiều thread riêng tư.
  if (!convColumns.includes('kind')) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE conversations_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL DEFAULT 'user_admin',
          user_id INTEGER NOT NULL,
          partner_id INTEGER,
          admin_last_read_id INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (partner_id) REFERENCES users(id) ON DELETE SET NULL
        );
      `);
      db.exec(`
        INSERT INTO conversations_migrated (id, kind, user_id, partner_id, admin_last_read_id, created_at)
        SELECT id, 'user_admin', user_id, partner_id, admin_last_read_id, created_at FROM conversations
      `);
      db.exec('DROP TABLE conversations');
      db.exec('ALTER TABLE conversations_migrated RENAME TO conversations');
    })();
    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      console.error('⚠️ foreign_key_check sau migration conversations:', fkErrors);
    }
  }
}

// Mỗi khách chỉ 1 thread với admin; mỗi cặp (khách, partner) chỉ 1 thread mỗi loại.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_user_admin
    ON conversations(user_id) WHERE kind = 'user_admin';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_partner
    ON conversations(user_id, partner_id, kind) WHERE kind IN ('partner_user', 'partner_admin');
`);

// Backfill thread riêng tư cho các khách đã được gán partner trước migration.
db.transaction(() => {
  const pairs = db
    .prepare(
      "SELECT user_id, partner_id FROM conversations WHERE kind = 'user_admin' AND partner_id IS NOT NULL"
    )
    .all();
  const insertThread = db.prepare(
    'INSERT OR IGNORE INTO conversations (kind, user_id, partner_id) VALUES (?, ?, ?)'
  );
  for (const pair of pairs) {
    insertThread.run('partner_user', pair.user_id, pair.partner_id);
    insertThread.run('partner_admin', pair.user_id, pair.partner_id);
  }
})();

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
  const insertConv = db.prepare("INSERT INTO conversations (kind, user_id) VALUES ('user_admin', ?)");
  insertConv.run(adminUser.lastInsertRowid);
  insertConv.run(partnerUser.lastInsertRowid);
  insertConv.run(user1.lastInsertRowid);

  console.log('✅ DB seeded: admin/admin123, partner1/admin123, user1/user123');
}

const statements = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserConversation: db.prepare(
    "SELECT * FROM conversations WHERE kind = 'user_admin' AND user_id = ?"
  ),
  insertUserConversation: db.prepare(
    "INSERT INTO conversations (kind, user_id) VALUES ('user_admin', ?)"
  ),
  getPartnerThread: db.prepare(
    'SELECT * FROM conversations WHERE kind = ? AND user_id = ? AND partner_id = ?'
  ),
  insertPartnerThread: db.prepare(
    'INSERT INTO conversations (kind, user_id, partner_id) VALUES (?, ?, ?)'
  ),
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
  // Admin chưa đọc tin partner trong thread partner_admin (chỉ tính tin của partner)
  countPartnerUnread: db.prepare(
    `SELECT COUNT(*) AS cnt FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = ? AND m.id > c.admin_last_read_id
       AND c.kind = 'partner_admin' AND m.sender_id = c.partner_id`
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

function getOrCreatePartnerThread(userId, partnerId, kind) {
  if (kind !== 'partner_user' && kind !== 'partner_admin') {
    throw new Error(`Invalid partner thread kind: ${kind}`);
  }
  return db.transaction(() => {
    const conv = statements.getPartnerThread.get(kind, userId, partnerId);
    if (conv) return conv;
    statements.insertPartnerThread.run(kind, userId, partnerId);
    return statements.getPartnerThread.get(kind, userId, partnerId);
  })();
}

/** Tạo (nếu chưa có) cả 2 thread riêng tư của cặp khách–partner. */
function ensurePartnerThreads(userId, partnerId) {
  return {
    userThread: getOrCreatePartnerThread(userId, partnerId, 'partner_user'),
    adminThread: getOrCreatePartnerThread(userId, partnerId, 'partner_admin'),
  };
}

/**
 * Quyền truy cập một conversation theo loại thread:
 * - user_admin: chỉ khách sở hữu + admin
 * - partner_user: chỉ khách + partner đang được gán
 * - partner_admin: chỉ partner đang được gán + admin
 */
function canAccessConversation(user, conversation) {
  if (!user || !conversation) return false;
  if (user.role === 'admin') return conversation.kind !== 'partner_user';
  if (user.role === 'user') {
    return conversation.user_id === user.id && conversation.kind !== 'partner_admin';
  }
  if (user.role === 'partner') {
    if (conversation.kind === 'user_admin') return false;
    if (conversation.partner_id !== user.id) return false;
    const primary = statements.getUserConversation.get(conversation.user_id);
    return !!primary && primary.partner_id === user.id;
  }
  return false;
}

module.exports = {
  db,

  getUserByUsername: (username) => statements.getUserByUsername.get(username),

  // Tìm hoặc tạo conversation 1-1 của user với admin (luôn trả về row object)
  getOrCreateConversation: (userId) =>
    db.transaction(() => {
      const conv = statements.getUserConversation.get(userId);
      if (conv) return conv;
      const info = statements.insertUserConversation.run(userId);
      return statements.getUserConversation.get(info.lastInsertRowid);
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

  // Đếm tin partner gửi mà admin chưa đọc trong thread partner_admin
  countPartnerUnread: (convId) => statements.countPartnerUnread.get(convId).cnt,

  // Gán partner cho conversation
  connectPartner: (convId, partnerId) => statements.connectPartner.run(partnerId, convId),

  // Tạo/tìm thread riêng tư partner↔khách hoặc partner↔admin
  getOrCreatePartnerThread,
  ensurePartnerThreads,
  canAccessConversation,

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
