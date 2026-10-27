require('dotenv').config({ quiet: true });
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const { Server } = require('socket.io');

const { store, getSessionUser } = require('./session-store');
const { getConversation, insertMessage, countUnread, countPartnerUnread, markAsRead, canAccessConversation, getBotUser, getMessagesPage } = require('./db');
const { generateReply, isOfficeHoursNow, OFFHOURS_REPLY } = require('./bot');
const { requireCsrf } = require('./auth');
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

// === Security headers cơ bản (không cần helmet cho app mẫu) ===
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// === CSRF: mọi request đổi dữ liệu qua /api phải kèm X-CSRF-Token khớp session.
// Miễn login/register (chưa có token trước khi đăng nhập); GET/HEAD không đổi dữ liệu.
// Request chưa đăng nhập để requireAuth trả 401 (không đổi thành 403).
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path === '/login' || req.path === '/register') return next();
  if (!req.session || !req.session.user) return next();
  requireCsrf(req, res, next);
});

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

// === Job dọn rác uploads (chạy nền; interval 0 giờ = tắt, dùng cho e2e/ui-check) ===
const db = require('./db');
const { startUploadsCleanup } = require('./uploads-cleanup');
startUploadsCleanup(db, path.join(__dirname, 'public', 'uploads'), {
  intervalHours: Number(process.env.UPLOAD_CLEANUP_INTERVAL_HOURS || 24),
  minAgeHours: Number(process.env.UPLOAD_CLEANUP_MIN_AGE_HOURS || 24),
  log: console.log,
});

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

// ===== Bot chuyên gia nông nghiệp =====
// Trả lời tự động trong thread user_admin khi khách nhắn (nếu bot_enabled).
// Stream từng cụm chữ qua 'bot-stream', kết thúc bằng 1 tin 'message' thật của
// user ảo ai-bot (senderRole='bot'). Mỗi conversation chỉ 1 câu trả lời tại 1 thời điểm.
const botBusy = new Set();
const BOT_THINK_MS = 400;

function triggerBotReply(conversation) {
  if (botBusy.has(conversation.id)) return;
  const bot = getBotUser();
  if (!bot) return;
  botBusy.add(conversation.id);
  const room = `conv_${conversation.id}`;
  const clientId = 'bot-' + Math.random().toString(36).slice(2, 10);

  (async () => {
    try {
      io.to(room).emit('typing', {
        convId: conversation.id,
        userId: bot.id,
        name: bot.display_name,
        isTyping: true,
      });
      // Khoảng "suy nghĩ" ngắn để typing indicator + bubble streaming hiển thị tự nhiên
      await new Promise((r) => setTimeout(r, BOT_THINK_MS));

      const history = getMessagesPage(conversation.id, null, 20).messages;
      let text;
      let via;
      let used = 'primary';
      let unsure = false;
      if (isOfficeHoursNow()) {
        const reply = await generateReply(
          history,
          (delta) => {
            io.to(room).emit('bot-stream', { convId: conversation.id, delta, clientId });
          },
          () => {
            // API chính lỗi giữa chừng → xóa phần stream dở để không lẫn chữ vào câu trả lời fallback
            io.to(room).emit('bot-stream', { convId: conversation.id, reset: true, clientId });
          },
        );
        text = reply.text;
        via = reply.via;
        used = reply.used || used;
        unsure = reply.unsure === true;
      } else {
        // Ngoài giờ hành chính (OFFICE_HOURS): không gọi LLM/KB, trả lời cố định nhắc
        // khách để lại lời nhắn — admin xử lý khi vào giờ.
        text = OFFHOURS_REPLY;
        via = 'offhours';
        io.to(room).emit('bot-stream', { convId: conversation.id, delta: text, clientId });
      }
      // Conversation có thể bị xóa trong lúc LLM đang trả lời (user tự xóa tài khoản)
      if (!getConversation(conversation.id)) return;
      const row = insertMessage(conversation.id, bot.id, text, null, null);
      const payload = {
        id: row.id,
        convId: conversation.id,
        senderId: bot.id,
        senderName: bot.display_name,
        senderRole: 'bot',
        content: row.content,
        attachmentUrl: null,
        attachmentName: null,
        createdAt: row.created_at,
        clientId,
      };
      io.to(room).emit('message', payload);
      if (via === 'llm') console.log(`🤖 Bot LLM trả lời conv ${conversation.id} (${row.content.length} ký tự${used !== 'primary' ? `, API ${used}` : ''})`);
      if (via === 'offhours') console.log(`🤖 Bot ngoài giờ trả lời conv ${conversation.id}`);
      if (unsure) {
        // Bot về rule-based fallback (không chắc chắn) → báo admin chuyển tiếp
        io.to('admins').emit('bot-unsure', {
          convId: conversation.id,
          userId: conversation.user_id,
          userName: conversation.user_name,
          preview: String(text).slice(0, 80),
        });
        console.log(`🤖 Bot không chắc chắn câu hỏi của "${conversation.user_name}" (conv ${conversation.id}) — đã báo admin`);
      }
    } catch (err) {
      console.warn('🤖 Bot lỗi:', err.message);
    } finally {
      io.to(room).emit('typing', {
        convId: conversation.id,
        userId: bot.id,
        name: bot.display_name,
        isTyping: false,
      });
      botBusy.delete(conversation.id);
    }
  })();
}

// Hợp đồng sự kiện:
//   client → server: 'join' {convId}, 'message' {convId, content, attachment?, clientId?},
//                     'read' {convId}, 'typing' {convId, isTyping}
//   server → client: 'joined', 'message', 'unread-badge', 'badge-cleared',
//                     'user-message' (room admins), 'partner-message'/'partner-badge'/
//                     'partner-badge-cleared' (room admins), 'typing',
//                     'bot-stream' {convId, delta, clientId} (bot đang trả lời),
//                     'bot-unsure' {convId, userId, userName, preview} (room admins:
//                     bot về rule-based fallback — không chắc chắn, nhờ admin chuyển tiếp),
//                     'read-by' {convId, userId, userSide, seenUpTo} (bên kia đã đọc →
//                     client hiện "Đã xem" cho tin của mình có id ≤ seenUpTo),
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

    const MAX_MESSAGE_LENGTH = 4000;
    let text = (content || '').toString().trim();
    if (text.length > MAX_MESSAGE_LENGTH) text = text.slice(0, MAX_MESSAGE_LENGTH);

    let fileUrl = attachment && attachment.url ? String(attachment.url).replace(/\\/g, '/') : null;
    let fileName = attachment && attachment.name ? String(attachment.name).slice(0, 160) : null;
    // Chỉ chấp nhận file thật sự nằm trong public/uploads/ — client tự gửi url có thể giả mạo
    if (fileUrl) {
      const uploadsRoot = path.join(__dirname, 'public', 'uploads');
      const abs = path.join(__dirname, 'public', fileUrl);
      if (!fileUrl.startsWith('/uploads/') || fileUrl.includes('..')
        || !abs.startsWith(uploadsRoot + path.sep) || !fs.existsSync(abs)) {
        fileUrl = null;
        fileName = null;
      }
    }
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

    // Bot chuyên gia: khách nhắn trong thread user_admin → bot trả lời tự động
    // (nếu admin bật bot cho khách này). Không trả lời trong thread partner.
    if (conversation.kind === 'user_admin' && user.role === 'user' && conversation.bot_enabled === 1) {
      triggerBotReply(conversation);
    }
  });

  // Mở một thread → đánh dấu đã đọc bên tương ứng + bắn 'read-by' để bên kia
  // thấy nhãn "Đã xem". Admin đọc thêm thì xoá badge tương ứng.
  socket.on('read', ({ convId }) => {
    if (!user) return;
    const conversation = getConversation(Number(convId));
    if (!conversation || !canAccessConversation(user, conversation)) return;
    const userSide = user.role === 'user'
      || (user.role === 'partner' && conversation.kind === 'partner_admin');
    const seenUpTo = markAsRead(conversation.id, userSide);
    io.to(`conv_${conversation.id}`).emit('read-by', {
      convId: conversation.id,
      userId: user.id,
      userSide,
      seenUpTo,
    });
    if (user.role === 'admin') {
      if (conversation.kind === 'partner_admin') {
        io.to('admins').emit('partner-badge-cleared', {
          convId: conversation.id,
          userId: conversation.user_id,
        });
      } else {
        io.to('admins').emit('badge-cleared', { convId: conversation.id });
      }
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
