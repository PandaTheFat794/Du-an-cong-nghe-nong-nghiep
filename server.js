const express = require('express');
const http = require('http');
const path = require('path');
const { db } = require('./db');
const authMiddleware = require('./auth');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');

const app = express();
const server = http.createServer(app);

// === Cấu hình express-session (lưu session vào RAM/server memory) ===
const session = require('express-session');
app.use(
  session({
    secret: 'flickering-humming-prism-secret-key-mk',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 1 day
  })
);

// Lưu trữ session để dùng cho socket.io verification (manual Map)
const sessionMap = new Map(); // key: sessionID, value: { id, username, role }

// === Socket.io setup ===
const io = require('socket.io')(server, {
  path: '/ws',
  // transports: ['polling'], // ổn định hơn trên mạng lan/NAT
});

// Khi có kết nối socket.io, thử verify session qua query string sessionId
io.use((socket, next) => {
  // Lấy sessionId từ query string (?sessionId=...)
  const sessionId = socket.handshake.query.sessionId;
  if (sessionId && sessionMap.has(sessionId)) {
    // Gắn thông tin user vào socket object để dùng sau này
    socket.user = sessionMap.get(sessionId);
    return next();
  }
  // Nếu không có sessionId hoặc không hợp lệ, vẫn cho kết nối nhưng không có user
  // (client phải login trước khi join room)
  next();
});

// ==== Gắn routes REST API ====
app.use('/api', authRoutes);
app.use('/api', chatRoutes);
app.use('/api', adminRoutes);

// ==== Serves static files từ folder public ====
app.use(express.static(path.join(__dirname, 'public')));

// Route fallback: nếu không có file static -> trả về index.html (cho SPA/client-side routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==== Xử lý các sự kiện Socket.io ====

// 1. Client gửi 'join' kèm convId + sessionId để tham gia room chat
io.on('connection', (socket) => {
  console.log(`⚡ User connected: ${socket.id}, session user:`, socket.user ? socket.user.username : 'none');

  socket.on('join', ({ convId, sessionId }) => {
    // Verify session lại一 lần (bảo vệ)
    const user = sessionMap.get(sessionId);
    if (!user) {
      return socket.emit('error', { message: 'Chưa có Session hợp lệ, vui lòng đăng nhập.' });
    }

    // Kiểm tra user có quyền tham gia conversation này không
    const conversation = db.getConversation(parseInt(convId, 10));
    if (!conversation) {
      return socket.emit('error', { message: 'Conversation không tồn tại.' });
    }

    const isAdmin = user.role === 'admin';
    const isOwner = conversation.user_id === user.id;
    const isPartner = conversation.partner_id && conversation.partner_id === user.id;

    if (isAdmin || isOwner || isPartner) {
      socket.join(`conv_${convId}`);
      socket.emit('joined', { convId, success: true, role: user.role });
      // Gửi lại badge unread count cho admin nếu có
      if (isAdmin && conversation.admin_read_at) {
        const unread = db.countUnread(parseInt(convId, 10), conversation.admin_read_at);
        socket.emit('unread-badge', { convId, count: unread });
      }
      console.log(`👤 User ${user.username} joinedconv_${convId} (admin=${isAdmin},owner=${isOwner},partner=${isPartner})`);
    } else {
      socket.emit('error', { message: 'Bạn không có quyền tham gia conversation này.' });
    }
  });

  // 2. Client gửi 'message' (Dùng khi user/admin gửi tin nhắn mới)
  socket.on('message', async ({ convId, sessionId, content }) => {
    const user = sessionMap.get(sessionId);
    if (!user) return socket.emit('error', { message: 'Chưa xác thực session.' });

    const convNum = parseInt(convId, 10);
    const conversation = db.getConversation(convNum);
    if (!conversation) return socket.emit('error', { message: 'Conversation không tồn tại.' });

    // Quyền gửi tin: owner (user) hoặc admin mới được gửi
    const isOwner = conversation.user_id === user.id;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return socket.emit('error', { message: 'Bạn không có quyền gửi tin nhắn vào conversation này.' });
    }

    // Lưu tin nhắn vào DB (sender_id là user đang login)
    db.insertMessage(convNum, user.id, content);

    // Broadcast tin nhắn về room conv_<convId>
    io.to(`conv_${convNum}`).emit('message', {
      id: Date.now(), // tạm thời ID
      convId: convNum,
      senderId: user.id,
      senderName: user.display_name,
      senderRole: user.role,
      content,
      created_at: new Date().toISOString(),
    });

    // Cập nhật badge unread cho admin (nếu admin không đangอยู่ room nhưng có session)
    if (conversation && user.role === 'admin') {
      // Cập nhật admin_read_at không, đơn giản là tăng badge
      io.to(`conv_${convNum}`).emit('unread-badge', {
        convId: convNum,
        count: (db.countUnread(convNum, conversation.admin_read_at) || 0) + 1,
      });
    }

    console.log(`💬 Message from ${user.username} in conv_${convNum}: ${content}`);
  });

  // 3. Client gửi 'read' (admin đã đọc xong tin nhắn, xoá badge)
  socket.on('read', ({ convId, sessionId }) => {
    const user = sessionMap.get(sessionId);
    if (!user || user.role !== 'admin') return;

    const convNum = parseInt(convId, 10);
    db.markAsRead(convNum, user.id); // cập nhật admin_read_at ở DB

    // Tín hiệu cho client cập nhật giao diện badge
    io.to(`conv_${convNum}`).emit('badge-cleared', { convId: convNum });
    console.log(`👁️ Admin ${user.username} marked conversation ${convNum} as read`);
  });

  // 4. Ngắt kết nối
  socket.on('disconnect', () => {
    // Xóa user khỏi sessionMap nếu muốn (tùy chọn, có thể giữ vòng đời session)
    // Ở đây chúng ta giữ sessionMap chung cho toàn server cho đơn giản.
    console.log(`⚡ User disconnected: ${socket.id}`);
  });
});

// ==== Khởi động Server ====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});