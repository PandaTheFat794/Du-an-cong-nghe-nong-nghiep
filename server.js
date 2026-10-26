require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const { Server } = require('socket.io');

const { store, getSessionUser } = require('./session-store');
const { getConversation, insertMessage, countUnread, markAsRead } = require('./db');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
const partnerRoutes = require('./routes/partner');
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
//   client → server: 'join' {convId}, 'message' {convId, content, attachment?}, 'read' {convId}
//   server → client: 'joined', 'message', 'unread-badge', 'badge-cleared', 'user-message' (room admins), 'error'
io.on('connection', (socket) => {
  const user = socket.user;
  if (user && user.role === 'admin') socket.join('admins');

  socket.on('join', ({ convId }) => {
    if (!user) return socket.emit('error', { message: 'Chưa có Session hợp lệ, vui lòng đăng nhập.' });

    const conversation = getConversation(Number(convId));
    if (!conversation) return socket.emit('error', { message: 'Conversation không tồn tại.' });

    const isAdmin = user.role === 'admin';
    const isOwner = conversation.user_id === user.id;
    const isAssignedPartner = conversation.partner_id === user.id;

    if (isAdmin || isOwner || isAssignedPartner) {
      socket.join(`conv_${conversation.id}`);
      socket.emit('joined', { convId: conversation.id, success: true, role: user.role });
      if (isAdmin) {
        socket.emit('unread-badge', { convId: conversation.id, count: countUnread(conversation.id) });
      }
    } else {
      socket.emit('error', { message: 'Bạn không có quyền tham gia conversation này.' });
    }
  });

  socket.on('message', ({ convId, content, attachment, clientId }) => {
    if (!user) return socket.emit('error', { message: 'Chưa xác thực session.' });

    const conversation = getConversation(Number(convId));
    if (!conversation) return socket.emit('error', { message: 'Conversation không tồn tại.' });

    // Chỉ chủ cuộc trò chuyện (user) hoặc admin được gửi; partner chỉ đọc
    const isOwner = conversation.user_id === user.id;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isAdmin) {
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

    // Khách gửi tin → báo sidebar admin (badge unread + preview)
    if (!isAdmin) {
      const unread = countUnread(conversation.id);
      io.to('admins').emit('user-message', {
        convId: conversation.id,
        preview: row.content || `[đính kèm: ${row.attachment_name || 'tệp'}]`,
        createdAt: row.created_at,
      });
      io.to('admins').emit('unread-badge', { convId: conversation.id, count: unread });
    }
  });

  // Admin mở cuộc trò chuyện → đánh dấu đã đọc, xoá badge
  socket.on('read', ({ convId }) => {
    if (!user || user.role !== 'admin') return;
    markAsRead(Number(convId));
    io.to('admins').emit('badge-cleared', { convId: Number(convId) });
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
