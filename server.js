require('dotenv').config({ quiet: true });
const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const { Server } = require('socket.io');

const { store, getSessionUser } = require('./session-store');
const { getConversation, insertMessage, countUnread, countPartnerUnread, markAsRead, canAccessConversation } = require('./db');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
const partnerRoutes = require('./routes/partner');
const processRoutes = require('./routes/process');
const uploadRoutes = require('./routes/upload');

const app = express();
const server = http.createServer(app);

// === express-session, lưu vào SQLite (sống sót qua restart) ===
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'tu-van-nong-nghiep-dev-secret',
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }, // 1 ngày
  })
);

// === Socket.io (handshake mang ?sessionId= để định danh) ===
const io = new Server(server, { path: '/ws' });
// Route REST cần phát sự kiện realtime (nhật ký canh tác) lấy io qua req.app
app.set('io', io);

io.use((socket, next) => {
  const user = getSessionUser(socket.handshake.query.sessionId);
  if (user) socket.user = user;
  next();
});

// === REST API ===
app.use('/api', authRoutes);
app.use('/api/conversations', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/partner', partnerRoutes);
app.use('/api/process', processRoutes);
app.use('/api', uploadRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'API not found' }));

// === Trang theo role (yêu cầu đăng nhập đúng role, ngược lại về login) ===
function pageGuard(role) {
  return (req, res, next) => {
    if (req.session && req.session.user && req.session.user.role === role) return next();
    res.redirect('/');
  };
}
app.get('/chat', pageGuard('user'), (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin', pageGuard('admin'), (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/partner', pageGuard('partner'), (req, res) => res.sendFile(path.join(__dirname, 'public', 'partner.html')));

// === Static files ===
app.use(express.static(path.join(__dirname, 'public')));

// ==== Socket.io events ====

// Chống spam: tối đa 8 tin nhắn / 10 giây / user
const RATE_WINDOW_MS = 10 * 1000;
const RATE_MAX_MESSAGES = 8;
const msgTimestamps = new Map(); // userId -> [timestamps]

function isFlooding(userId) {
  const now = Date.now();
  const recent = (msgTimestamps.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  msgTimestamps.set(userId, recent);
  return recent.length > RATE_MAX_MESSAGES;
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, times] of msgTimestamps) {
    const fresh = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length) msgTimestamps.set(userId, fresh);
    else msgTimestamps.delete(userId);
  }
}, RATE_WINDOW_MS).unref();

// Hợp đồng sự kiện:
//   client → server: 'join' {convId}, 'message' {convId, content, attachment?, clientId?},
//                     'read' {convId}, 'typing' {convId, isTyping}
//   server → client: 'joined', 'message', 'unread-badge', 'badge-cleared',
//                     'user-message' (room admins), 'partner-message'/'partner-badge'/
//                     'partner-badge-cleared' (room admins), 'typing',
//                     'process-updated' {userId, userName, convId, action, entryId}, 'error'
io.on('connection', (socket) => {
  const user = socket.user;
  if (user && user.role === 'admin') socket.join('admins');

  socket.on('join', ({ convId }) => {
    if (!user) return socket.emit('error', { message: 'Chưa có Session hợp lệ, vui lòng đăng nhập.' });

    const conversation = getConversation(Number(convId));
    if (!conversation) return socket.emit('error', { message: 'Conversation không tồn tại.' });

    if (canAccessConversation(user, conversation)) {
      socket.join(`conv_${conversation.id}`);
      socket.emit('joined', { convId: conversation.id, success: true, role: user.role });
      if (user.role === 'admin') {
        if (conversation.kind === 'partner_admin') {
          socket.emit('partner-badge', {
            convId: conversation.id,
            userId: conversation.user_id,
            count: countPartnerUnread(conversation.id),
          });
        } else {
          socket.emit('unread-badge', { convId: conversation.id, count: countUnread(conversation.id) });
        }
      }
    } else {
      socket.emit('error', { message: 'Bạn không có quyền tham gia conversation này.' });
    }
  });

  socket.on('message', ({ convId, content, attachment, clientId }) => {
    if (!user) return socket.emit('error', { message: 'Chưa xác thực session.' });

    const conversation = getConversation(Number(convId));
    if (!conversation) return socket.emit('error', { message: 'Conversation không tồn tại.' });

    // Mỗi thread chỉ đúng 2 bên: user_admin (khách+admin), partner_user (khách+partner),
    // partner_admin (partner+admin). Partner không đọc/gửi được thread của admin và khách.
    if (!canAccessConversation(user, conversation)) {
      return socket.emit('error', { message: 'Bạn không có quyền gửi tin nhắn vào conversation này.' });
    }
    if (isFlooding(user.id)) {
      return socket.emit('error', { message: 'Bạn gửi tin quá nhanh, vui lòng đợi vài giây.' });
    }

    const text = (content || '').toString().trim();
    const fileUrl = attachment && attachment.url ? attachment.url : null;
    const fileName = attachment && attachment.name ? attachment.name : null;
    if (!text && !fileUrl) {
      return socket.emit('error', { message: 'Tin nhắn trống.' });
    }

    const row = insertMessage(conversation.id, user.id, text, fileUrl, fileName);
    const payload = {
      id: row.id,
      convId: conversation.id,
      senderId: row.sender_id,
      senderName: user.display_name,
      senderRole: user.role,
      content: row.content,
      attachmentUrl: row.attachment_url,
      attachmentName: row.attachment_name,
      createdAt: row.created_at,
    };
    // Echo lại clientId để client thay bubble "đang gửi" bằng tin thật
    if (typeof clientId === 'string' && clientId.length <= 64) payload.clientId = clientId;

    io.to(`conv_${conversation.id}`).emit('message', payload);

    const preview = row.content || `[đính kèm: ${row.attachment_name || 'tệp'}]`;

    // Khách gửi trong thread với admin → badge đỏ + preview cho sidebar admin.
    // Tin partner trong thread partner_admin → badge amber riêng, không lẫn vào chat khách.
    // Thread partner_user là riêng tư, admin không nhận thông báo nội dung.
    if (conversation.kind === 'user_admin' && user.role === 'user') {
      io.to('admins').emit('user-message', {
        convId: conversation.id,
        userId: conversation.user_id,
        preview,
        createdAt: row.created_at,
      });
      io.to('admins').emit('unread-badge', {
        convId: conversation.id,
        count: countUnread(conversation.id),
      });
    } else if (conversation.kind === 'partner_admin' && user.role === 'partner') {
      io.to('admins').emit('partner-message', {
        convId: conversation.id,
        userId: conversation.user_id,
        userName: conversation.user_name,
        partnerName: user.display_name,
        preview,
        createdAt: row.created_at,
      });
      io.to('admins').emit('partner-badge', {
        convId: conversation.id,
        userId: conversation.user_id,
        count: countPartnerUnread(conversation.id),
      });
    }
  });

  // Admin mở một thread → đánh dấu đã đọc, xoá badge tương ứng
  socket.on('read', ({ convId }) => {
    if (!user || user.role !== 'admin') return;
    const conversation = getConversation(Number(convId));
    if (!conversation || !canAccessConversation(user, conversation)) return;
    markAsRead(conversation.id);
    if (conversation.kind === 'partner_admin') {
      io.to('admins').emit('partner-badge-cleared', {
        convId: conversation.id,
        userId: conversation.user_id,
      });
    } else {
      io.to('admins').emit('badge-cleared', { convId: conversation.id });
    }
  });

  // Typing indicator: relay tới những người khác trong phòng (socket.to tự loại sender).
  // Chỉ nhận khi socket đã join phòng và khi trạng thái đổi → client gõ liên tục không
  // biến thành bão broadcast (typing không đi qua rate-limit của 'message').
  let typingActive = false;
  socket.on('typing', ({ convId, isTyping }) => {
    const id = Number(convId);
    const on = !!isTyping;
    const room = `conv_${id}`;
    if (!user || !id || !socket.rooms.has(room) || on === typingActive) return;
    typingActive = on;
    socket.to(room).emit('typing', { convId: id, userId: user.id, name: user.display_name, isTyping: on });
  });
});

// ==== Khởi động Server ====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});
