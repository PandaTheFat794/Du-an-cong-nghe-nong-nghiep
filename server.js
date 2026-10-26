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
        socket.emit('unread-badge', { convId: conversation.id, count: countUnread(conversation.id, conversation.admin_read_at) });
      }
    } else {
      socket.emit('error', { message: 'Bạn không có quyền tham gia conversation này.' });
    }
  });

  socket.on('message', ({ convId, content, attachment }) => {
    if (!user) return socket.emit('error', { message: 'Chưa xác thực session.' });

    const conversation = getConversation(Number(convId));
    if (!conversation) return socket.emit('error', { message: 'Conversation không tồn tại.' });

    // Chỉ chủ cuộc trò chuyện (user) hoặc admin được gửi; partner chỉ đọc
    const isOwner = conversation.user_id === user.id;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return socket.emit('error', { message: 'Bạn không có quyền gửi tin nhắn vào conversation này.' });
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

    io.to(`conv_${conversation.id}`).emit('message', payload);

    // Khách gửi tin → báo sidebar admin (badge unread + preview)
    if (!isAdmin) {
      const unread = countUnread(conversation.id, conversation.admin_read_at);
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
});

// ==== Khởi động Server ====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});
