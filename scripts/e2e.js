// E2E test: User - Admin - Partner (REST + Socket.io + Upload + Session persist)
// Chạy: npm run e2e   (server con chạy ở PORT 3100 với data/e2e.db tạm, không đụng DB thật)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const DB_PATH = path.join(__dirname, '..', 'data', 'e2e.db');

const results = [];
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` → ${detail}` : ''}`);
  }
  results.push({ name, ok, detail });
}

function waitEvent(socket, event, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout chờ event '${event}'`));
    }, timeout);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

// ---- HTTP helper có cookie jar đơn giản (chỉ giữ connect.sid) ----
async function httpJson(pathname, { method = 'GET', body, cookie, formData } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const resp = await fetch(BASE + pathname, { method, headers, body: payload });
  const setCookie = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  const sid = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
  let data = null;
  const text = await resp.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data, cookie: sid || null };
}

function loginAndGetSession(username, password) {
  return httpJson('/api/login', {
    method: 'POST',
    body: { username, password },
  }).then(({ status, data, cookie }) => {
    if (!data || !data.success) throw new Error(`login ${username} thất bại (${status}): ${JSON.stringify(data)}`);
    return { sessionId: data.sessionId, cookie, user: data.user };
  });
}

function connectSocket(sessionId) {
  return io(BASE, { path: '/ws', query: { sessionId }, transports: ['websocket'] });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SESSION_SECRET: 'e2e-secret' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.pipe(process.stderr);
    child.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error(`server exit ${code}`)); });
    const t0 = Date.now();
    (async function probe() {
      while (Date.now() - t0 < 15000) {
        try {
          await fetch(`${BASE}/api/me`);
          return resolve(child);
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      child.kill();
      reject(new Error('server không khởi động được trong 15s'));
    })();
  });
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function main() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  let server = await startServer();
  console.log('🧪 E2E: luồng User - Admin - Partner\n');

  // ===== 1. Auth & register =====
  const uname = 'e2e_' + Date.now().toString(36);
  let r = await httpJson('/api/register', { method: 'POST', body: { username: uname, password: 'pass123', display_name: 'Khách E2E' } });
  check('register user mới → 201', r.status === 201 && r.data.success, JSON.stringify(r.data));

  r = await httpJson('/api/register', { method: 'POST', body: { username: uname, password: 'pass123', display_name: 'Dup' } });
  check('register trùng tên → 409', r.status === 409, `status ${r.status}`);

  r = await httpJson('/api/login', { method: 'POST', body: { username: uname, password: 'wrong' } });
  check('login sai mật khẩu → 401', r.status === 401, `status ${r.status}`);

  r = await httpJson('/api/me');
  check('GET /api/me khi chưa đăng nhập → 401', r.status === 401, `status ${r.status}`);

  const user = await loginAndGetSession(uname, 'pass123');
  const admin = await loginAndGetSession('admin', 'admin123');
  const partner = await loginAndGetSession('partner1', 'admin123');

  r = await httpJson('/api/me', { cookie: user.cookie });
  check('GET /api/me (user) → 200 + conversation_id', r.status === 200 && r.data.conversation_id > 0, JSON.stringify(r.data));
  const convId = r.data.conversation_id;

  // ===== 2. Quyền REST =====
  r = await httpJson('/api/admin/users');
  check('GET /api/admin/users khi chưa login → 401', r.status === 401, `status ${r.status}`);

  r = await httpJson('/api/admin/users', { cookie: user.cookie });
  check('user gọi API admin → 403', r.status === 403, `status ${r.status}`);

  r = await httpJson('/api/admin/users', { cookie: admin.cookie });
  const listed = r.data && r.data.users && r.data.users.find((u) => u.username === uname);
  check('admin thấy khách mới trong sidebar list', r.status === 200 && !!listed, JSON.stringify(r.data && r.data.users && r.data.users.length));

  r = await httpJson(`/api/conversations/${convId}/messages`, { cookie: partner.cookie });
  check('partner chưa được gán → xem history bị 403', r.status === 403, `status ${r.status}`);

  // ===== 3. Socket realtime + phân quyền =====
  const userSock = connectSocket(user.sessionId);
  const adminSock = connectSocket(admin.sessionId);

  try {
    userSock.emit('join', { convId });
    await waitEvent(userSock, 'joined', (d) => d.convId === convId);
    check('user join conversation qua socket', true);

    const badUser = await loginAndGetSession('user1', 'user123');
    const badSock = connectSocket(badUser.sessionId);
    badSock.emit('join', { convId });
    const err = await waitEvent(badSock, 'error');
    check('user khác join → bị từ chối', /không có quyền/i.test(err.message), err.message);
    badSock.close();

    const unreadP = waitEvent(adminSock, 'unread-badge', (d) => d.convId === convId);
    userSock.emit('message', { convId, content: 'Xin chào Admin' });
    await unreadP;
    check('admin (room admins) nhận unread-badge khi user gửi tin', true);

    adminSock.emit('join', { convId });
    await waitEvent(adminSock, 'joined', (d) => d.convId === convId);
    adminSock.emit('read', { convId });
    await waitEvent(adminSock, 'badge-cleared', (d) => d.convId === convId);
    check('admin đánh dấu đã đọc → badge-cleared', true);

    const userGotP = waitEvent(userSock, 'message', (m) => m.senderRole === 'admin');
    adminSock.emit('message', { convId, content: 'Admin trả lời đây' });
    const reply = await userGotP;
    check('user nhận tin admin realtime', reply.content === 'Admin trả lời đây', reply.content);

    // typing indicator relay
    const typingOnP = waitEvent(userSock, 'typing', (d) => d.isTyping === true);
    adminSock.emit('typing', { convId, isTyping: true });
    const tOn = await typingOnP;
    check('relay typing: user nhận isTyping=true kèm tên người gõ',
      tOn.convId === convId && typeof tOn.userId === 'number' && !!tOn.name, JSON.stringify(tOn));

    const typingOffP = waitEvent(userSock, 'typing', (d) => d.isTyping === false);
    adminSock.emit('typing', { convId, isTyping: false });
    await typingOffP;
    check('relay typing: isTyping=false truyền sang client đối diện', true);

    // 🔍 probe: typing không hợp lệ → server bỏ qua, không broadcast
    let typingHits = 0;
    const typingCounter = () => { typingHits += 1; };
    userSock.on('typing', typingCounter);

    adminSock.emit('typing', { convId: 0, isTyping: true });
    adminSock.emit('typing', { isTyping: true });
    await new Promise((r) => setTimeout(r, 400));
    check('🔍 typing convId thiếu/0 → bị bỏ qua', typingHits === 0, `hits=${typingHits}`);

    adminSock.emit('typing', { convId, isTyping: true });
    adminSock.emit('typing', { convId, isTyping: true });
    adminSock.emit('typing', { convId, isTyping: true });
    await new Promise((r) => setTimeout(r, 400));
    check('🔍 spam cùng trạng thái typing → chỉ relay 1 lần', typingHits === 1, `hits=${typingHits}`);

    const outsiderSock = connectSocket(admin.sessionId); // socket này chưa join conversation
    outsiderSock.emit('typing', { convId, isTyping: false });
    await new Promise((r) => setTimeout(r, 400));
    check('🔍 socket chưa join phòng → không phát được typing vào phòng', typingHits === 1, `hits=${typingHits}`);
    outsiderSock.close();
    userSock.off('typing', typingCounter);

    // ===== Unread badge: chỉ đếm tin khách, mốc so sánh theo id tin nhắn =====
    r = await httpJson('/api/admin/users', { cookie: admin.cookie });
    const rowAfterReply = r.data.users.find((u) => u.conversation_id === convId);
    check('admin tự trả lời → unread của chính admin = 0', rowAfterReply.unread_count === 0, `unread=${rowAfterReply.unread_count}`);

    const badgeAfterReadP = waitEvent(adminSock, 'unread-badge', (d) => d.convId === convId);
    userSock.emit('message', { convId, content: 'Tin ngay sau khi admin đọc' });
    const badgeAfterRead = await badgeAfterReadP;
    check('user gửi ngay sau khi admin đọc → unread-badge = 1', badgeAfterRead.count === 1, `count=${badgeAfterRead.count}`);

    // 🔍 clientId được echo lại để client thay bubble "đang gửi"
    const echoP = waitEvent(userSock, 'message', (m) => !!m.clientId);
    userSock.emit('message', { convId, content: 'có clientId', clientId: 'test-client-1' });
    const echoed = await echoP;
    check('🔍 message echo clientId về đúng client', echoed.clientId === 'test-client-1', `clientId=${echoed.clientId}`);

    const noRightP = waitEvent(userSock, 'error');
    userSock.emit('message', { convId: 999999, content: 'hack' });
    await noRightP;
    check('gửi vào conversation lạ → error', true);

    // REST history cho user
    r = await httpJson(`/api/conversations/${convId}/messages`, { cookie: user.cookie });
    const contents = (r.data.messages || []).map((m) => m.content);
    check('REST history chứa cả 2 tin đã gửi', contents.includes('Xin chào Admin') && contents.includes('Admin trả lời đây'), JSON.stringify(contents));
  } finally {
    userSock.close();
    adminSock.close();
  }

  // ===== 4. Upload =====
  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'anh.png');
    return fd;
  })(), cookie: user.cookie });
  check('upload ảnh .png → 201 + url', r.status === 201 && /^\/uploads\//.test(r.data.url), JSON.stringify(r.data));

  if (r.status === 201) {
    const fileResp = await fetch(BASE + r.data.url);
    check('GET file đã upload → 200', fileResp.status === 200, `status ${fileResp.status}`);

    const uSock2 = connectSocket(user.sessionId);
    uSock2.emit('join', { convId });
    await waitEvent(uSock2, 'joined', (d) => d.convId === convId);
    const gotP = waitEvent(uSock2, 'message', (m) => !!m.attachmentUrl);
    uSock2.emit('message', { convId, content: 'xem giúp em', attachment: { url: r.data.url, name: 'anh.png' } });
    const msg = await gotP;
    check('tin nhắn kèm attachment broadcast đúng', msg.attachmentName === 'anh.png', JSON.stringify(msg));
    uSock2.close();
  }

  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('not ok')], { type: 'application/octet-stream' }), 'hack.exe');
    return fd;
  })(), cookie: user.cookie });
  check('upload .exe → 400 bị chặn', r.status === 400, `status ${r.status}`);

  // ===== 5. Partner read-only =====
  const partners = await httpJson('/api/admin/partners', { cookie: admin.cookie });
  const partnerRow = partners.data.partners.find((p) => p.username === 'partner1');
  r = await httpJson(`/api/admin/conversations/${convId}/connect`, { method: 'POST', body: { partner_id: partnerRow.id }, cookie: admin.cookie });
  check('admin gán partner qua REST → 200', r.status === 200 && r.data.success, JSON.stringify(r.data));

  r = await httpJson('/api/partner/conversations', { cookie: partner.cookie });
  const myConv = r.data.conversations.find((c) => c.conversation_id === convId);
  check('partner thấy khách được gán trong list', r.status === 200 && !!myConv, JSON.stringify(r.data));

  r = await httpJson(`/api/conversations/${convId}/messages`, { cookie: partner.cookie });
  check('partner xem được lịch sử (read)', r.status === 200 && r.data.messages.length >= 2, `messages ${r.data.messages && r.data.messages.length}`);

  const partnerSock = connectSocket(partner.sessionId);
  try {
    partnerSock.emit('join', { convId });
    await waitEvent(partnerSock, 'joined', (d) => d.convId === convId);
    check('partner join room để xem realtime', true);
    const errP = waitEvent(partnerSock, 'error');
    partnerSock.emit('message', { convId, content: 'partner gửi lén' });
    const perr = await errP;
    check('partner gửi tin → bị chặn (chỉ đọc)', /quyền/i.test(perr.message), perr.message);
  } finally {
    partnerSock.close();
  }

  // ===== 6. Rate-limit, upload giả mạo, đổi mật khẩu, xóa tài khoản =====
  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('MZThisIsNotAPng')], { type: 'image/png' }), 'fake.png');
    return fd;
  })(), cookie: user.cookie });
  check('upload nội dung giả mạo .png → 400', r.status === 400 && /không khớp/i.test(r.data.error || ''), JSON.stringify(r.data));

  // Flood: user riêng để không ảnh hưởng các test khác
  const spamName = 'spam_' + Date.now().toString(36);
  r = await httpJson('/api/register', { method: 'POST', body: { username: spamName, password: 'pass123', display_name: 'Spammer' } });
  const spamId = r.data.userId;
  const spam = await loginAndGetSession(spamName, 'pass123');
  const spamMe = await httpJson('/api/me', { cookie: spam.cookie });
  const spamConvId = spamMe.data.conversation_id;

  r = await httpJson('/api/me/password', { method: 'POST', body: { current_password: 'admin123', new_password: 'x' }, cookie: admin.cookie });
  check('đổi mk ngắn <6 ký tự → 400', r.status === 400, `status ${r.status}`);

  const spamSock = connectSocket(spam.sessionId);
  try {
    spamSock.emit('join', { convId: spamConvId });
    await waitEvent(spamSock, 'joined', (d) => d.convId === spamConvId);
    const floodErrP = waitEvent(spamSock, 'error', (e) => /quá nhanh/i.test(e.message), 8000);
    for (let i = 1; i <= 10; i++) spamSock.emit('message', { convId: spamConvId, content: 'spam ' + i });
    await floodErrP;
    check('rate-limit: >8 tin/10s bị chặn', true);
  } finally {
    spamSock.close();
  }

  r = await httpJson('/api/me/password', { method: 'POST', body: { current_password: 'sai', new_password: 'newpass123' }, cookie: spam.cookie });
  check('đổi mk với mật khẩu hiện tại sai → 401', r.status === 401, `status ${r.status}`);
  r = await httpJson('/api/me/password', { method: 'POST', body: { current_password: 'pass123', new_password: 'newpass123' }, cookie: spam.cookie });
  check('đổi mk đúng → 200', r.status === 200, JSON.stringify(r.data));
  r = await httpJson('/api/login', { method: 'POST', body: { username: spamName, password: 'pass123' } });
  check('login bằng mật khẩu cũ → 401', r.status === 401, `status ${r.status}`);
  r = await httpJson('/api/login', { method: 'POST', body: { username: spamName, password: 'newpass123' } });
  check('login bằng mật khẩu mới → 200', r.status === 200, `status ${r.status}`);

  r = await httpJson('/api/me', { method: 'DELETE', cookie: admin.cookie });
  check('admin tự xóa qua /api/me → 403 (chỉ role user)', r.status === 403, `status ${r.status}`);

  r = await httpJson(`/api/admin/users/${spamId}`, { method: 'DELETE', cookie: admin.cookie });
  check('admin xóa khách → 200', r.status === 200 && r.data.success, JSON.stringify(r.data));
  r = await httpJson('/api/login', { method: 'POST', body: { username: spamName, password: 'newpass123' } });
  check('user bị xóa không login được → 401', r.status === 401, `status ${r.status}`);
  r = await httpJson(`/api/conversations/${spamConvId}/messages`, { cookie: admin.cookie });
  check('cascade: conversation của user bị xóa cũng mất → 404', r.status === 404, `status ${r.status}`);

  const tmpName = 'tmp_' + Date.now().toString(36);
  await httpJson('/api/register', { method: 'POST', body: { username: tmpName, password: 'pass123', display_name: 'Tmp' } });
  const tmp = await loginAndGetSession(tmpName, 'pass123');
  r = await httpJson('/api/me', { method: 'DELETE', cookie: tmp.cookie });
  check('user tự xóa tài khoản → 200', r.status === 200 && r.data.success, JSON.stringify(r.data));
  r = await httpJson('/api/login', { method: 'POST', body: { username: tmpName, password: 'pass123' } });
  check('sau tự xóa, login fail → 401', r.status === 401, `status ${r.status}`);

  // ===== 7. Session persist qua restart =====
  server.kill();
  await new Promise((res) => setTimeout(res, 500));
  server = await startServer();
  r = await httpJson('/api/me', { cookie: admin.cookie });
  check('sau restart: cookie session cũ vẫn còn hiệu lực', r.status === 200 && r.data.user.role === 'admin', `status ${r.status}`);

  const reSock = connectSocket(user.sessionId);
  try {
    reSock.on('connect', () => reSock.emit('join', { convId }));
    await waitEvent(reSock, 'joined', (d) => d.convId === convId);
    check('sau restart: socket handshake bằng sessionId cũ vẫn join được', true);
  } finally {
    reSock.close();
  }

  server.kill();
  console.log(`\n📊 Kết quả: ${passed} pass / ${failed} fail (tổng ${passed + failed})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('💥 E2E crash:', e);
  process.exit(2);
});
