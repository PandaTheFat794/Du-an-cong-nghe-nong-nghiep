// E2E test: User - Admin - Partner - Bot AI (REST + Socket.io + Upload + Session persist)
// Chạy: npm run e2e   (server con chạy ở PORT 3100 với data/e2e.db tạm, không đụng DB thật)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
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
// Cache CSRF token theo (server, cookie) để không gọi /api/csrf mỗi request
const csrfCache = new Map();

async function getCsrfToken(cookie, base) {
  const key = `${base}|${cookie}`;
  if (csrfCache.has(key)) return csrfCache.get(key);
  const resp = await fetch(base + '/api/csrf', { headers: { cookie } });
  const data = await resp.json().catch(() => ({}));
  const token = data && data.success ? data.csrfToken : null;
  if (token) csrfCache.set(key, token);
  return token;
}

async function httpJson(pathname, { method = 'GET', body, cookie, formData, skipCsrf, extraHeaders } = {}, base = BASE) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  const upperMethod = method.toUpperCase();
  if (cookie && upperMethod !== 'GET' && !skipCsrf) {
    const token = await getCsrfToken(cookie, base);
    if (token) headers['x-csrf-token'] = token;
  }
  if (extraHeaders) Object.assign(headers, extraHeaders);
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const resp = await fetch(base + pathname, { method, headers, body: payload });
  const setCookie = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  const sid = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
  let data = null;
  const text = await resp.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data, cookie: sid || null };
}

function loginAndGetSession(username, password, base = BASE) {
  return httpJson('/api/login', {
    method: 'POST',
    body: { username, password },
  }, base).then(({ status, data, cookie }) => {
    if (!data || !data.success) throw new Error(`login ${username} thất bại (${status}): ${JSON.stringify(data)}`);
    return { sessionId: data.sessionId, cookie, user: data.user };
  });
}

function connectSocket(sessionId, base = BASE) {
  return io(base, { path: '/ws', query: { sessionId }, transports: ['websocket'] });
}

// OFFICE_HOURS='0-24': bot luôn trong giờ làm việc → test bot không phụ thuộc giờ thật
function startServer({ port = PORT, dbPath = DB_PATH, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        SESSION_SECRET: 'e2e-secret',
        LLM_PROVIDER: 'off',
        LLM_FALLBACK_PROVIDER: 'off',
        LLM_FALLBACK2_PROVIDER: 'off',
        OFFICE_HOURS: '0-24',
        UPLOAD_CLEANUP_INTERVAL_HOURS: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.pipe(process.stderr);
    child.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error(`server exit ${code}`)); });
    const t0 = Date.now();
    (async function probe() {
      while (Date.now() - t0 < 15000) {
        try {
          await fetch(`http://localhost:${port}/api/me`);
          return resolve(child);
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      child.kill();
      reject(new Error(`server không khởi động được trong 15s (port ${port})`));
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

  // 🔍 validation đăng ký
  r = await httpJson('/api/register', { method: 'POST', body: { username: 'ab', password: 'pass123', display_name: 'Short' } });
  check('🔍 register username <3 ký tự → 400', r.status === 400, `status ${r.status}`);
  r = await httpJson('/api/register', { method: 'POST', body: { username: 'bad name!', password: 'pass123', display_name: 'Bad' } });
  check('🔍 register username chứa ký tự lạ → 400', r.status === 400, `status ${r.status}`);
  r = await httpJson('/api/register', { method: 'POST', body: { username: uname + '_x', password: '12345', display_name: 'Short pw' } });
  check('🔍 register password <6 ký tự → 400', r.status === 400, `status ${r.status}`);

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
  check('sidebar admin trả bot_enabled (mặc định bật)', !!listed && listed.bot_enabled === true, JSON.stringify(listed && listed.bot_enabled));

  // Tắt bot cho khách e2e ngay từ đầu để các test socket sau không bị reply bot xen vào
  r = await httpJson(`/api/admin/conversations/${convId}/bot`, { method: 'POST', body: { enabled: false }, cookie: admin.cookie });
  check('admin tắt bot cho khách → 200 + botEnabled=false',
    r.status === 200 && r.data.success && r.data.botEnabled === false, JSON.stringify(r.data));

  r = await httpJson(`/api/conversations/${convId}/messages`, { cookie: partner.cookie });
  check('partner chưa được gán → xem history bị 403', r.status === 403, `status ${r.status}`);

  // ===== 2b. Nhật ký canh tác: CRUD + phân quyền =====
  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      activity: 'sowing',
      performed_at: '2026-01-05',
      title: 'Gieo lúa vụ đông',
      method: 'Sạ hàng',
      details: 'Giống ST25, mật độ 100kg/ha',
    },
  });
  check('user tạo mục nhật ký canh tác → 201', r.status === 201 && r.data.entry.activity === 'sowing', JSON.stringify(r.data));
  const firstEntryId = r.data && r.data.entry && r.data.entry.id;

  r = await httpJson('/api/process', { cookie: user.cookie });
  check('user xem nhật ký của mình', r.status === 200 && r.data.entries.some((e) => e.id === firstEntryId), `status ${r.status}`);

  r = await httpJson(`/api/process?userId=${user.user.id}`, { cookie: admin.cookie });
  check('admin xem nhật ký của khách', r.status === 200 && r.data.entries.length >= 1, `status ${r.status}`);

  r = await httpJson(`/api/process?userId=${user.user.id}`, { cookie: partner.cookie });
  check('partner chưa được gán → xem nhật ký bị 403', r.status === 403, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: admin.cookie,
    body: { activity: 'watering', performed_at: '2026-01-06', title: 'Admin tạo hộ' },
  });
  check('admin không được tạo nhật ký thay khách → 403', r.status === 403, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: { activity: 'hack', performed_at: '2026-01-06', title: 'Hoạt động lạ' },
  });
  check('🔍 nhật ký activity lạ → 400', r.status === 400, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: { activity: 'watering', performed_at: '2026-02-31', title: 'Ngày không tồn tại' },
  });
  check('🔍 nhật ký ngày không hợp lệ (31/02) → 400', r.status === 400, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: { activity: 'watering', performed_at: '2026-01-06', title: '   ' },
  });
  check('🔍 nhật ký tiêu đề rỗng → 400', r.status === 400, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      activity: 'watering',
      performed_at: '2026-01-06',
      title: 'Đính kèm lạ',
      attachment: { url: '/uploads/../../etc/passwd', name: 'x.png' },
    },
  });
  check('🔍 nhật ký đính kèm path traversal → 400', r.status === 400, `status ${r.status}`);

  // ===== 2c. Security headers + thống kê admin =====
  const hResp = await fetch(BASE + '/api/me');
  check('🔍 security headers: nosniff + SAMEORIGIN + referrer-policy',
    hResp.headers.get('x-content-type-options') === 'nosniff'
      && hResp.headers.get('x-frame-options') === 'SAMEORIGIN'
      && hResp.headers.get('referrer-policy') === 'same-origin',
    JSON.stringify({
      nosniff: hResp.headers.get('x-content-type-options'),
      frame: hResp.headers.get('x-frame-options'),
      referrer: hResp.headers.get('referrer-policy'),
    }));

  r = await httpJson('/api/admin/stats');
  check('GET /api/admin/stats khi chưa login → 401', r.status === 401, `status ${r.status}`);
  r = await httpJson('/api/admin/stats', { cookie: user.cookie });
  check('user gọi /api/admin/stats → 403', r.status === 403, `status ${r.status}`);

  // Thêm 1 mục nhật ký "hôm nay" để kiểm tra stats scope theo khoảng 7 ngày
  const todayStr = (() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();
  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: { activity: 'harvest', performed_at: todayStr, title: 'Thu hoạch hôm nay (stats)' },
  });
  check('tạo mục nhật ký hôm nay cho stats → 201', r.status === 201, `status ${r.status}`);

  // 🔍 CSRF: token theo session + chặn request đổi dữ liệu thiếu/sai token
  r = await httpJson('/api/csrf');
  check('GET /api/csrf khi chưa login → 401', r.status === 401, `status ${r.status}`);
  r = await httpJson('/api/csrf', { cookie: user.cookie });
  check('GET /api/csrf → 200 + token 64 ký tự hex',
    r.status === 200 && /^[a-f0-9]{64}$/.test(r.data.csrfToken || ''),
    `status ${r.status}`);
  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    skipCsrf: true,
    body: { activity: 'watering', performed_at: todayStr, title: 'Thiếu CSRF' },
  });
  check('🔍 POST thiếu X-CSRF-Token → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    extraHeaders: { 'x-csrf-token': 'deadbeef' },
    body: { activity: 'watering', performed_at: todayStr, title: 'Sai CSRF' },
  });
  check('🔍 POST sai X-CSRF-Token → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson('/api/logout', { method: 'POST', cookie: user.cookie, skipCsrf: true });
  check('🔍 logout thiếu token → 403 (không bị ép đăng xuất)', r.status === 403, `status ${r.status}`);

  r = await httpJson('/api/admin/stats', { cookie: admin.cookie });
  check('admin lấy thống kê → 200 + KPI + chuỗi 7 ngày + phân bố hoạt động',
    r.status === 200 && r.data.success && r.data.days === 7
      && typeof r.data.totals.customers === 'number' && r.data.totals.customers >= 1
      && typeof r.data.totals.partners === 'number' && r.data.totals.partners >= 1
      && typeof r.data.totals.messages === 'number'
      && typeof r.data.totals.processEntries === 'number' && r.data.totals.processEntries >= 1
      && Array.isArray(r.data.messagesByDay) && r.data.messagesByDay.length === 7
      && r.data.messagesByDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && typeof d.count === 'number')
      && Array.isArray(r.data.processByActivity)
        && r.data.processByActivity.some((a) => a.activity === 'harvest' && a.count >= 1)
      && Array.isArray(r.data.topCustomers),
    JSON.stringify(r.data && r.data.totals));

  r = await httpJson('/api/admin/stats?days=30', { cookie: admin.cookie });
  check('stats ?days=30 → 30 mốc ngày + days=30',
    r.status === 200 && r.data.days === 30 && r.data.messagesByDay.length === 30,
    `days=${r.data && r.data.days}, bars=${r.data && r.data.messagesByDay && r.data.messagesByDay.length}`);
  r = await httpJson('/api/admin/stats?days=90', { cookie: admin.cookie });
  check('stats ?days=90 → 90 mốc ngày + days=90',
    r.status === 200 && r.data.days === 90 && r.data.messagesByDay.length === 90,
    `days=${r.data && r.data.days}, bars=${r.data && r.data.messagesByDay && r.data.messagesByDay.length}`);
  r = await httpJson('/api/admin/stats?days=45', { cookie: admin.cookie });
  check('🔍 stats ?days=45 → 400', r.status === 400, `status ${r.status}`);
  r = await httpJson('/api/admin/stats?days=abc', { cookie: admin.cookie });
  check('🔍 stats ?days=abc → 400', r.status === 400, `status ${r.status}`);

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

    // 🔍 phân trang lịch sử: limit + before
    r = await httpJson(`/api/conversations/${convId}/messages?limit=2`, { cookie: user.cookie });
    const page1 = r.data.messages || [];
    check('🔍 phân trang: limit=2 trả 2 tin mới nhất + has_more',
      page1.length === 2 && r.data.has_more === true && page1[1].content === 'có clientId',
      JSON.stringify({ count: page1.length, hasMore: r.data.has_more, last: page1[1] && page1[1].content }));
    r = await httpJson(`/api/conversations/${convId}/messages?limit=2&before=${page1[0].id}`, { cookie: user.cookie });
    const page2 = r.data.messages || [];
    check('🔍 phân trang: before=<id> trả trang cũ hơn, hết tin → has_more=false',
      page2.length === 2 && page2.every((m) => m.id < page1[0].id) && r.data.has_more === false,
      JSON.stringify({ count: page2.length, hasMore: r.data.has_more }));
    r = await httpJson(`/api/conversations/${convId}/messages?limit=abc`, { cookie: user.cookie });
    check('🔍 phân trang: limit không hợp lệ → dùng mặc định (200)', r.status === 200 && r.data.messages.length === 4, `status ${r.status}, count ${r.data.messages && r.data.messages.length}`);

    // 🔍 tìm kiếm trong lịch sử chat
    r = await httpJson(`/api/conversations/${convId}/search?q=ch%C3%A0o`);
    check('search khi chưa login → 401', r.status === 401, `status ${r.status}`);
    r = await httpJson(`/api/conversations/${convId}/search?q=ch%C3%A0o`, { cookie: partner.cookie });
    check('🔍 partner tìm trong thread user_admin → 403', r.status === 403, `status ${r.status}`);
    r = await httpJson(`/api/conversations/${convId}/search?q=ch%C3%A0o`, { cookie: user.cookie });
    check('user tìm "chào" → 200 + thấy tin "Xin chào Admin" kèm người gửi',
      r.status === 200 && r.data.success && r.data.results.length >= 1
        && r.data.results.some((m) => m.content.includes('Xin chào Admin') && m.senderRole === 'user' && !!m.senderName),
      JSON.stringify((r.data.results || []).map((m) => m.content)));
    r = await httpJson(`/api/conversations/${convId}/search?q=x`, { cookie: user.cookie });
    check('🔍 search q 1 ký tự → 400', r.status === 400, `status ${r.status}`);
    r = await httpJson(`/api/conversations/${convId}/search`, { cookie: user.cookie });
    check('🔍 search thiếu q → 400', r.status === 400, `status ${r.status}`);
    r = await httpJson(`/api/conversations/${convId}/search?q=%25%25`, { cookie: user.cookie });
    check('🔍 search wildcard "%%" được escape → 0 kết quả (không trả toàn bộ)',
      r.status === 200 && r.data.results.length === 0,
      `results=${r.data.results && r.data.results.length}`);

    // 🔍 around: nhảy tới tin cũ nhất → trang chứa tin đó + tin kế tiếp
    const oldestMsg = page2[0] || page2[page2.length - 1];
    r = await httpJson(`/api/conversations/${convId}/messages?around=${oldestMsg.id}&limit=2`, { cookie: user.cookie });
    const aroundMsgs = r.data.messages || [];
    check('🔍 around=<id> → trang chứa đúng tin đích, sắp cũ → mới',
      r.status === 200 && aroundMsgs.some((m) => m.id === oldestMsg.id)
        && aroundMsgs.every((m, i) => i === 0 || m.id > aroundMsgs[i - 1].id),
      JSON.stringify(aroundMsgs.map((m) => m.id)));
    r = await httpJson(`/api/conversations/${convId}/messages?around=999999&limit=2`, { cookie: user.cookie });
    check('🔍 around id không tồn tại → 200, không lỗi', r.status === 200 && Array.isArray(r.data.messages),
      `status ${r.status}`);

    // 🔍 attachment url giả mạo bên ngoài /uploads/ → strip (chống tracking pixel / leak IP của admin)
    const fakeAttP = waitEvent(userSock, 'message', (m) => m.content === 'Theo dõi xem admin có mở không');
    userSock.emit('message', {
      convId,
      content: 'Theo dõi xem admin có mở không',
      attachment: { url: 'https://evil.example.com/track.png', name: 'track.png' },
    });
    const fakeAtt = await fakeAttP;
    check('🔍 attachment url ngoài /uploads/ → bị strip, không lưu (chống tracking)',
      fakeAtt.attachmentUrl === null && fakeAtt.attachmentName === null,
      JSON.stringify({ url: fakeAtt.attachmentUrl, name: fakeAtt.attachmentName }));

    const travP = waitEvent(userSock, 'message', (m) => m.content === 'Path traversal');
    userSock.emit('message', {
      convId,
      content: 'Path traversal',
      attachment: { url: '/uploads/../../etc/passwd', name: 'passwd.png' },
    });
    const trav = await travP;
    check('🔍 attachment path traversal → bị strip', trav.attachmentUrl === null && trav.attachmentName === null,
      JSON.stringify({ url: trav.attachmentUrl, name: trav.attachmentName }));

    const longP = waitEvent(userSock, 'message', (m) => m.content && m.content.length > 1000);
    userSock.emit('message', { convId, content: 'L'.repeat(5000) });
    const longMsg = await longP;
    check('🔍 tin quá dài → cắt còn 4000 ký tự', longMsg.content.length === 4000, `length=${longMsg.content.length}`);
  } finally {
    userSock.close();
    adminSock.close();
  }

  // ===== 4. Upload =====
  let uploadedUrl = null;
  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'anh.png');
    return fd;
  })(), cookie: user.cookie });
  check('upload ảnh .png → 201 + url', r.status === 201 && /^\/uploads\//.test(r.data.url), JSON.stringify(r.data));
  if (r.status === 201) uploadedUrl = r.data.url;

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

  // Tin nhắn thoại (.webm do MediaRecorder tạo): chấp nhận + broadcast không cần nội dung chữ
  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])], { type: 'audio/webm' }), 'ghi-am.webm');
    return fd;
  })(), cookie: user.cookie });
  check('upload ghi âm .webm → 201 + url', r.status === 201 && /^\/uploads\/.*\.webm$/.test(r.data.url || ''), JSON.stringify(r.data));
  if (r.status === 201) {
    const aSock = connectSocket(user.sessionId);
    aSock.emit('join', { convId });
    await waitEvent(aSock, 'joined', (d) => d.convId === convId);
    const gotAudio = waitEvent(aSock, 'message', (m) => m.attachmentName === 'ghi-am.webm');
    aSock.emit('message', { convId, content: '', attachment: { url: r.data.url, name: 'ghi-am.webm' } });
    const audioMsg = await gotAudio;
    check('tin nhắn thoại broadcast kèm attachment (không cần chữ)', audioMsg.attachmentUrl === r.data.url, JSON.stringify(audioMsg));
    aSock.close();
  }
  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('khong phai webm')], { type: 'audio/webm' }), 'fake.webm');
    return fd;
  })(), cookie: user.cookie });
  check('🔍 upload .webm giả mạo magic bytes → 400', r.status === 400, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      activity: 'watering',
      performed_at: '2026-01-07',
      title: 'Tưới đợt 1',
      method: 'Tưới nhỏ giọt 20 phút',
      details: 'Độ ẩm đất 65%',
      attachment: { url: uploadedUrl, name: 'anh.png' },
    },
  });
  check('nhật ký kèm ảnh đã upload → 201 + attachmentUrl',
    r.status === 201 && r.data.entry.attachmentUrl === uploadedUrl,
    JSON.stringify(r.data));
  const photoEntryId = r.data && r.data.entry && r.data.entry.id;

  // ===== Nhiều ảnh mỗi mục nhật ký =====
  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'anh2.png');
    return fd;
  })(), cookie: user.cookie });
  const url2 = r.data && r.data.url;
  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'anh3.png');
    return fd;
  })(), cookie: user.cookie });
  const url3 = r.data && r.data.url;

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      activity: 'fertilizing',
      performed_at: '2026-01-08',
      title: 'Bón phân kèm 2 ảnh',
      attachments: [{ url: url2, name: 'anh2.png' }, { url: url3, name: 'anh3.png' }],
    },
  });
  check('nhật ký nhiều ảnh → 201 + attachments 2 mục + attachmentUrl = ảnh đầu',
    r.status === 201 && Array.isArray(r.data.entry.attachments) && r.data.entry.attachments.length === 2
      && r.data.entry.attachmentUrl === url2,
    JSON.stringify(r.data));
  const multiEntryId = r.data && r.data.entry && r.data.entry.id;

  r = await httpJson('/api/process', { cookie: user.cookie });
  const multiEntry = r.data.entries.find((e) => e.id === multiEntryId);
  check('GET nhật ký trả attachments đủ 2 ảnh (thứ tự giữ nguyên)',
    !!multiEntry && multiEntry.attachments.length === 2
      && multiEntry.attachments[0].url === url2 && multiEntry.attachments[1].url === url3,
    JSON.stringify(multiEntry && multiEntry.attachments));

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      activity: 'watering',
      performed_at: '2026-01-09',
      title: 'Quá nhiều ảnh',
      attachments: [1, 2, 3, 4, 5, 6].map((i) => ({ url: url2, name: `anh${i}.png` })),
    },
  });
  check('🔍 nhật ký quá 5 tệp đính kèm → 400', r.status === 400, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: { activity: 'watering', performed_at: '2026-01-09', title: 'Sai kiểu', attachments: 'khong-phai-array' },
  });
  check('🔍 attachments không phải mảng → 400', r.status === 400, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      activity: 'watering',
      performed_at: '2026-01-09',
      title: 'Tên đính kèm rỗng',
      attachments: [{ url: url2, name: '   ' }],
    },
  });
  check('🔍 đính kèm trong mảng thiếu tên → 400', r.status === 400, `status ${r.status}`);

  r = await httpJson('/api/upload', { method: 'POST', formData: (() => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('not ok')], { type: 'application/octet-stream' }), 'hack.exe');
    return fd;
  })(), cookie: user.cookie });
  check('upload .exe → 400 bị chặn', r.status === 400, `status ${r.status}`);

  // ===== 5. Partner: nhật ký + 2 luồng chat riêng tư =====
  const partners = await httpJson('/api/admin/partners', { cookie: admin.cookie });
  const partnerRow = partners.data.partners.find((p) => p.username === 'partner1');
  r = await httpJson(`/api/admin/conversations/${convId}/connect`, { method: 'POST', body: { partner_id: partnerRow.id }, cookie: admin.cookie });
  check('admin gán partner qua REST → 200', r.status === 200 && r.data.success, JSON.stringify(r.data));
  const partnerUserConvId = r.data.partnerUserConversationId;
  const partnerAdminConvId = r.data.partnerConversationId;
  check('gán partner → tạo 2 thread riêng (partner↔khách, partner↔admin)',
    partnerUserConvId > 0 && partnerAdminConvId > 0
      && partnerUserConvId !== partnerAdminConvId && partnerUserConvId !== convId,
    JSON.stringify({ partnerUserConvId, partnerAdminConvId }));

  r = await httpJson('/api/partner/conversations', { cookie: partner.cookie });
  const myConv = r.data.conversations.find((c) => c.user_id === user.user.id);
  check('partner thấy khách được gán (kèm nhật ký + 2 conversation riêng)',
    r.status === 200 && !!myConv && myConv.process_count >= 2
      && myConv.user_conversation_id === partnerUserConvId
      && myConv.admin_conversation_id === partnerAdminConvId,
    JSON.stringify(myConv));

  // Phân quyền REST tách biệt từng thread
  r = await httpJson(`/api/conversations/${convId}/messages`, { cookie: partner.cookie });
  check('partner KHÔNG xem được thread khách↔admin', r.status === 403, `status ${r.status}`);
  r = await httpJson(`/api/conversations/${partnerUserConvId}/messages`, { cookie: partner.cookie });
  check('partner xem được thread partner↔khách', r.status === 200, `status ${r.status}`);
  r = await httpJson(`/api/conversations/${partnerAdminConvId}/messages`, { cookie: partner.cookie });
  check('partner xem được thread partner↔admin', r.status === 200, `status ${r.status}`);
  r = await httpJson(`/api/conversations/${partnerUserConvId}/messages`, { cookie: user.cookie });
  check('khách xem được thread partner↔khách của mình', r.status === 200, `status ${r.status}`);
  r = await httpJson(`/api/conversations/${partnerAdminConvId}/messages`, { cookie: user.cookie });
  check('khách KHÔNG xem được thread partner↔admin', r.status === 403, `status ${r.status}`);
  r = await httpJson(`/api/conversations/${partnerAdminConvId}/messages`, { cookie: admin.cookie });
  check('admin xem được thread partner↔admin', r.status === 200, `status ${r.status}`);
  r = await httpJson(`/api/conversations/${partnerUserConvId}/messages`, { cookie: admin.cookie });
  check('admin KHÔNG xem được thread partner↔khách', r.status === 403, `status ${r.status}`);

  r = await httpJson(`/api/process?userId=${user.user.id}`, { cookie: partner.cookie });
  check('partner được gán → xem nhật ký canh tác của khách',
    r.status === 200 && r.data.entries.length >= 2, `status ${r.status}`);

  r = await httpJson('/api/process', {
    method: 'POST',
    cookie: partner.cookie,
    body: { activity: 'watering', performed_at: '2026-01-08', title: 'Partner ghi hộ' },
  });
  check('partner không được tạo nhật ký thay khách → 403', r.status === 403, `status ${r.status}`);

  r = await httpJson(`/api/process/${firstEntryId}`, { method: 'DELETE', cookie: partner.cookie });
  check('partner không được xóa nhật ký → 403', r.status === 403, `status ${r.status}`);

  const partnerSock = connectSocket(partner.sessionId);
  const userSock3 = connectSocket(user.sessionId);
  const adminSock3 = connectSocket(admin.sessionId);
  try {
    // 🔍 Không ai join được thread không thuộc về mình
    partnerSock.emit('join', { convId });
    const partnerJoinErr = await waitEvent(partnerSock, 'error');
    check('🔍 partner join thread khách↔admin → bị từ chối', /không có quyền/i.test(partnerJoinErr.message), partnerJoinErr.message);
    userSock3.emit('join', { convId: partnerAdminConvId });
    const userJoinErr = await waitEvent(userSock3, 'error');
    check('🔍 khách join thread partner↔admin → bị từ chối', /không có quyền/i.test(userJoinErr.message), userJoinErr.message);
    adminSock3.emit('join', { convId: partnerUserConvId });
    const adminJoinErr = await waitEvent(adminSock3, 'error');
    check('🔍 admin join thread partner↔khách → bị từ chối', /không có quyền/i.test(adminJoinErr.message), adminJoinErr.message);

    // Join đúng thread của từng người
    partnerSock.emit('join', { convId: partnerUserConvId });
    await waitEvent(partnerSock, 'joined', (d) => d.convId === partnerUserConvId);
    partnerSock.emit('join', { convId: partnerAdminConvId });
    await waitEvent(partnerSock, 'joined', (d) => d.convId === partnerAdminConvId);
    userSock3.emit('join', { convId: partnerUserConvId });
    await waitEvent(userSock3, 'joined', (d) => d.convId === partnerUserConvId);
    userSock3.emit('join', { convId });
    await waitEvent(userSock3, 'joined', (d) => d.convId === convId);
    adminSock3.emit('join', { convId: partnerAdminConvId });
    await waitEvent(adminSock3, 'joined', (d) => d.convId === partnerAdminConvId);
    adminSock3.emit('join', { convId });
    await waitEvent(adminSock3, 'joined', (d) => d.convId === convId);
    check('partner + khách + admin join đúng thread của mình', true);

    const beforePartnerMsg = await httpJson('/api/admin/users', { cookie: admin.cookie });
    const rowBefore = beforePartnerMsg.data.users.find((u) => u.conversation_id === convId);

    // Partner → khách (riêng tư)
    let adminLeak = 0;
    const adminLeakHandler = (m) => { if (m.convId === partnerUserConvId) adminLeak += 1; };
    adminSock3.on('message', adminLeakHandler);
    const partnerEchoP = waitEvent(partnerSock, 'message', (m) => m.clientId === 'partner-1');
    const userGotPartnerP = waitEvent(userSock3, 'message', (m) => m.convId === partnerUserConvId && m.senderRole === 'partner');
    partnerSock.emit('message', { convId: partnerUserConvId, content: 'Tư vấn riêng cho khách', clientId: 'partner-1' });
    const [pEcho, pToUser] = await Promise.all([partnerEchoP, userGotPartnerP]);
    await new Promise((res) => setTimeout(res, 300));
    adminSock3.off('message', adminLeakHandler);
    check('partner gửi thread riêng → echo partner + khách nhận realtime',
      pEcho.senderRole === 'partner' && pToUser.senderId === partner.user.id && pToUser.content === 'Tư vấn riêng cho khách',
      JSON.stringify({ role: pEcho.senderRole, content: pToUser.content }));
    check('🔍 admin không nhận tin partner↔khách (không leak)', adminLeak === 0, `leak=${adminLeak}`);

    // Partner → admin (riêng tư) + badge riêng cho admin
    let userLeak = 0;
    const userLeakHandler = (m) => { if (m.convId === partnerAdminConvId) userLeak += 1; };
    userSock3.on('message', userLeakHandler);
    const adminPartnerMsgP = waitEvent(adminSock3, 'message', (m) => m.convId === partnerAdminConvId && m.senderRole === 'partner');
    const partnerBadgeP = waitEvent(adminSock3, 'partner-badge', (d) => d.convId === partnerAdminConvId && d.count > 0);
    partnerSock.emit('message', { convId: partnerAdminConvId, content: 'Báo cáo riêng cho admin' });
    const [pToAdmin, partnerBadge] = await Promise.all([adminPartnerMsgP, partnerBadgeP]);
    await new Promise((res) => setTimeout(res, 300));
    userSock3.off('message', userLeakHandler);
    check('partner gửi thread partner↔admin → admin nhận realtime',
      pToAdmin.content === 'Báo cáo riêng cho admin' && pToAdmin.senderRole === 'partner', JSON.stringify(pToAdmin));
    check('🔍 khách không nhận tin partner↔admin (không leak)', userLeak === 0, `leak=${userLeak}`);
    check('admin nhận partner-badge khi partner nhắn riêng',
      partnerBadge.count === 1 && partnerBadge.userId === user.user.id, JSON.stringify(partnerBadge));

    r = await httpJson('/api/admin/users', { cookie: admin.cookie });
    const rowAfterPartner = r.data.users.find((u) => u.conversation_id === convId);
    check('partner_unread trong sidebar = 1', rowAfterPartner.partner_unread === 1, `partner_unread=${rowAfterPartner.partner_unread}`);
    check('🔍 tin partner↔khách không làm tăng unread của khách↔admin',
      rowAfterPartner.unread_count === rowBefore.unread_count,
      `before=${rowBefore.unread_count}, after=${rowAfterPartner.unread_count}`);

    const clearedP = waitEvent(adminSock3, 'partner-badge-cleared', (d) => d.convId === partnerAdminConvId);
    adminSock3.emit('read', { convId: partnerAdminConvId });
    await clearedP;
    r = await httpJson('/api/admin/users', { cookie: admin.cookie });
    check('admin đọc thread partner → partner_unread về 0',
      r.data.users.find((u) => u.conversation_id === convId).partner_unread === 0, 'partner_unread=0');

    // Admin → khách trong thread user_admin; partner không thấy
    let partnerLeakAdminUser = 0;
    const partnerLeakHandler = (m) => { if (m.convId === convId) partnerLeakAdminUser += 1; };
    partnerSock.on('message', partnerLeakHandler);
    const userGotAdminP = waitEvent(userSock3, 'message', (m) => m.convId === convId && m.senderRole === 'admin' && m.content === 'Admin nhắn riêng khách');
    adminSock3.emit('message', { convId, content: 'Admin nhắn riêng khách' });
    await userGotAdminP;
    await new Promise((res) => setTimeout(res, 300));
    partnerSock.off('message', partnerLeakHandler);
    check('admin gửi thread khách↔admin → khách nhận realtime', true);
    check('🔍 partner không nhận tin khách↔admin (không leak)', partnerLeakAdminUser === 0, `leak=${partnerLeakAdminUser}`);

    // 🔍 Gửi chéo thread bị chặn
    let crossErrP = waitEvent(partnerSock, 'error');
    partnerSock.emit('message', { convId, content: 'partner gửi chéo' });
    const partnerCrossErr = await crossErrP;
    check('🔍 partner gửi vào thread khách↔admin → bị chặn', /quyền gửi tin/i.test(partnerCrossErr.message), partnerCrossErr.message);

    crossErrP = waitEvent(adminSock3, 'error');
    adminSock3.emit('message', { convId: partnerUserConvId, content: 'admin gửi chéo' });
    const adminCrossErr = await crossErrP;
    check('🔍 admin gửi vào thread partner↔khách → bị chặn', /quyền gửi tin/i.test(adminCrossErr.message), adminCrossErr.message);

    crossErrP = waitEvent(userSock3, 'error');
    userSock3.emit('message', { convId: partnerAdminConvId, content: 'khách gửi chéo' });
    const userCrossErr = await crossErrP;
    check('🔍 khách gửi vào thread partner↔admin → bị chặn', /quyền gửi tin/i.test(userCrossErr.message), userCrossErr.message);

    // Nhật ký mới → partner (thread riêng) + admin (room admins) nhận process-updated
    const partnerProcP = waitEvent(partnerSock, 'process-updated', (d) => d.action === 'created' && d.userId === user.user.id);
    const adminProcP = waitEvent(adminSock3, 'process-updated', (d) => d.action === 'created' && d.userId === user.user.id);
    r = await httpJson('/api/process', {
      method: 'POST',
      cookie: user.cookie,
      body: {
        activity: 'fertilizing',
        performed_at: '2026-01-09',
        title: 'Bón lót đợt 2',
        method: 'Bón vãi',
        details: 'NPK 20-20-15, 150kg/ha',
      },
    });
    const updatedEntryId = r.data && r.data.entry && r.data.entry.id;
    const [procEvtPartner, procEvtAdmin] = await Promise.all([partnerProcP, adminProcP]);
    check('⚡ khách cập nhật nhật ký → partner + admin nhận process-updated realtime',
      procEvtPartner.convId === convId && procEvtAdmin.userName === 'Khách E2E',
      JSON.stringify(procEvtPartner));

    r = await httpJson(`/api/process/${photoEntryId}`, { method: 'DELETE', cookie: admin.cookie });
    check('admin xóa mục nhật ký → 200', r.status === 200 && r.data.success, JSON.stringify(r.data));

    r = await httpJson('/api/process', { method: 'GET', cookie: user.cookie });
    check('sau khi admin xóa → nhật ký không còn mục đó',
      !r.data.entries.some((e) => e.id === photoEntryId), JSON.stringify(r.data.entries.map((e) => e.id)));

    r = await httpJson(`/api/process/${updatedEntryId}`, { method: 'DELETE', cookie: user.cookie });
    check('user tự xóa nhật ký của mình → 200', r.status === 200 && r.data.success, JSON.stringify(r.data));
  } finally {
    partnerSock.close();
    userSock3.close();
    adminSock3.close();
  }

  // ===== 5c. Hủy liên kết partner (mất quyền ngay + gán lại tái sử dụng thread) =====
  r = await httpJson(`/api/admin/conversations/${convId}/disconnect`, { method: 'POST' });
  check('disconnect khi chưa login → 401', r.status === 401, `status ${r.status}`);
  r = await httpJson(`/api/admin/conversations/${convId}/disconnect`, { method: 'POST', cookie: user.cookie });
  check('khách gọi disconnect → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson(`/api/admin/conversations/${convId}/disconnect`, { method: 'POST', cookie: partner.cookie });
  check('partner gọi disconnect → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson(`/api/admin/conversations/${partnerUserConvId}/disconnect`, { method: 'POST', cookie: admin.cookie });
  check('🔍 disconnect thread partner↔khách → 404', r.status === 404, `status ${r.status}`);

  r = await httpJson(`/api/admin/conversations/${convId}/disconnect`, { method: 'POST', cookie: admin.cookie });
  check('admin hủy liên kết partner → 200', r.status === 200 && r.data.success, JSON.stringify(r.data));

  r = await httpJson('/api/admin/users', { cookie: admin.cookie });
  const rowDisconnected = r.data.users.find((u) => u.conversation_id === convId);
  check('sau hủy → sidebar không còn partner_id/partner_conversation_id + badge partner về 0',
    rowDisconnected.partner_id === null && rowDisconnected.partner_conversation_id === null
      && rowDisconnected.partner_name === null && rowDisconnected.partner_unread === 0,
    JSON.stringify(rowDisconnected));

  r = await httpJson('/api/partner/conversations', { cookie: partner.cookie });
  check('partner không còn thấy khách trong danh sách sau hủy',
    r.status === 200 && !r.data.conversations.some((c) => c.user_id === user.user.id),
    JSON.stringify(r.data.conversations.map((c) => c.user_id)));

  r = await httpJson(`/api/conversations/${partnerUserConvId}/messages`, { cookie: partner.cookie });
  check('partner mất quyền xem thread partner↔khách ngay sau hủy → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson(`/api/conversations/${partnerAdminConvId}/messages`, { cookie: partner.cookie });
  check('partner mất quyền xem thread partner↔admin ngay sau hủy → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson(`/api/process?userId=${user.user.id}`, { cookie: partner.cookie });
  check('partner mất quyền xem nhật ký sau hủy → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson('/api/me', { cookie: user.cookie });
  check('khách thấy /api/me không còn partner', r.status === 200 && r.data.partner === null,
    JSON.stringify(r.data.partner));

  r = await httpJson(`/api/admin/conversations/${convId}/connect`, { method: 'POST', body: { partner_id: partnerRow.id }, cookie: admin.cookie });
  check('gán lại partner → 200 + tái sử dụng 2 thread cũ',
    r.status === 200 && r.data.partnerUserConversationId === partnerUserConvId
      && r.data.partnerConversationId === partnerAdminConvId,
    JSON.stringify(r.data));
  r = await httpJson(`/api/conversations/${partnerUserConvId}/messages`, { cookie: partner.cookie });
  check('gán lại → partner xem lại lịch sử thread cũ (tin giữ nguyên)',
    r.status === 200 && r.data.messages.length > 0, `messages=${r.data.messages && r.data.messages.length}`);

  // ===== 5d. Đã xem (read receipt): read-by + watermark 2 bên =====
  // Sleep reset cửa sổ rate-limit 8 tin/10s (các section trước gửi nhiều tin user)
  await new Promise((res) => setTimeout(res, 11000));
  const seenUserSock = connectSocket(user.sessionId);
  const seenAdminSock = connectSocket(admin.sessionId);
  const seenPartnerSock = connectSocket(partner.sessionId);
  const seenErrors = [];
  for (const s of [seenUserSock, seenAdminSock, seenPartnerSock]) {
    s.on('error', (e) => seenErrors.push(e && e.message ? e.message : JSON.stringify(e)));
  }
  try {
    seenUserSock.emit('join', { convId });
    await waitEvent(seenUserSock, 'joined', (d) => d.convId === convId);
    seenAdminSock.emit('join', { convId });
    await waitEvent(seenAdminSock, 'joined', (d) => d.convId === convId);

    // User gửi tin → admin chưa đọc → watermark admin giữ nguyên
    const userSeenMsgP = waitEvent(seenUserSock, 'message', (m) => m.clientId === 'seen-1');
    seenUserSock.emit('message', { convId, content: 'Tin đã xem 1', clientId: 'seen-1' });
    const userSeenMsg = await userSeenMsgP;
    r = await httpJson(`/api/conversations/${convId}/messages`, { cookie: admin.cookie });
    check('🔍 user gửi tin mới → admin chưa đọc (watermark admin < tin mới)',
      r.status === 200 && r.data.conversation.admin_last_read_id < userSeenMsg.id,
      `admin_last_read_id=${r.data.conversation.admin_last_read_id}, msgId=${userSeenMsg.id}`);

    // Admin đọc → user nhận read-by (userSide=false) + watermark admin cập nhật
    const readByUserP = waitEvent(seenUserSock, 'read-by', (d) => d.convId === convId && !d.userSide);
    seenAdminSock.emit('read', { convId });
    const readByUser = await readByUserP;
    check('user nhận read-by khi admin đọc (seenUpTo ≥ tin user gửi)',
      readByUser.seenUpTo >= userSeenMsg.id, JSON.stringify({ seenUpTo: readByUser.seenUpTo, msgId: userSeenMsg.id }));

    // Admin gửi tin → user chưa đọc → user_last_read_id chưa tới tin đó
    const adminSeenMsgP = waitEvent(seenAdminSock, 'message', (m) => m.clientId === 'seen-2');
    seenAdminSock.emit('message', { convId, content: 'Tin đã xem 2', clientId: 'seen-2' });
    const adminSeenMsg = await adminSeenMsgP;
    r = await httpJson(`/api/conversations/${convId}/messages`, { cookie: user.cookie });
    check('🔍 admin gửi tin mới → user chưa đọc (user_last_read_id < tin mới)',
      r.status === 200 && r.data.conversation.user_last_read_id < adminSeenMsg.id,
      `user_last_read_id=${r.data.conversation.user_last_read_id}, msgId=${adminSeenMsg.id}`);

    // User đọc → admin nhận read-by (userSide=true) + watermark user lưu
    const readByAdminP = waitEvent(seenAdminSock, 'read-by', (d) => d.convId === convId && d.userSide);
    seenUserSock.emit('read', { convId });
    const readByAdmin = await readByAdminP;
    check('admin nhận read-by khi user đọc (seenUpTo ≥ tin admin gửi)',
      readByAdmin.seenUpTo >= adminSeenMsg.id, JSON.stringify({ seenUpTo: readByAdmin.seenUpTo, msgId: adminSeenMsg.id }));
    r = await httpJson(`/api/conversations/${convId}/messages`, { cookie: user.cookie });
    check('user_last_read_id lưu mốc user đã đọc (REST trả trong conversation)',
      r.status === 200 && r.data.conversation.user_last_read_id >= adminSeenMsg.id,
      `user_last_read_id=${r.data.conversation.user_last_read_id}, msgId=${adminSeenMsg.id}`);

    // 🔍 user emit read trên thread lạ (partner_admin) → bị bỏ qua, không có read-by
    let leakedReadBy = false;
    const leakHandler = () => { leakedReadBy = true; };
    seenAdminSock.on('read-by', leakHandler);
    seenUserSock.emit('read', { convId: partnerAdminConvId });
    await new Promise((res) => setTimeout(res, 300));
    seenAdminSock.off('read-by', leakHandler);
    check('🔍 user emit read trên thread không có quyền → không bắn read-by', !leakedReadBy);

    // Partner đọc thread partner↔admin → admin nhận read-by (userSide=true)
    seenAdminSock.emit('join', { convId: partnerAdminConvId });
    await waitEvent(seenAdminSock, 'joined', (d) => d.convId === partnerAdminConvId);
    seenPartnerSock.emit('join', { convId: partnerAdminConvId });
    await waitEvent(seenPartnerSock, 'joined', (d) => d.convId === partnerAdminConvId);
    const readByAdminPartnerP = waitEvent(seenAdminSock, 'read-by', (d) => d.convId === partnerAdminConvId && d.userSide);
    seenPartnerSock.emit('read', { convId: partnerAdminConvId });
    const readByAdminPartner = await readByAdminPartnerP;
    r = await httpJson(`/api/conversations/${partnerAdminConvId}/messages`, { cookie: admin.cookie });
    check('partner đọc thread partner↔admin → user_last_read_id cập nhật',
      r.status === 200 && readByAdminPartner.seenUpTo > 0
        && r.data.conversation.user_last_read_id >= readByAdminPartner.seenUpTo,
      JSON.stringify(readByAdminPartner));

    // Khách đọc thread partner↔khách → partner nhận read-by (userSide=true)
    seenUserSock.emit('join', { convId: partnerUserConvId });
    await waitEvent(seenUserSock, 'joined', (d) => d.convId === partnerUserConvId);
    seenPartnerSock.emit('join', { convId: partnerUserConvId });
    await waitEvent(seenPartnerSock, 'joined', (d) => d.convId === partnerUserConvId);
    const readByPartnerP = waitEvent(seenPartnerSock, 'read-by', (d) => d.convId === partnerUserConvId && d.userSide);
    seenUserSock.emit('read', { convId: partnerUserConvId });
    const readByPartner = await readByPartnerP;
    check('user đọc thread partner↔khách → partner nhận read-by', readByPartner.seenUpTo > 0, JSON.stringify(readByPartner));
    check('🔍 không có lỗi socket trong 5d', seenErrors.length === 0, seenErrors.join(' | '));
  } finally {
    seenUserSock.close();
    seenAdminSock.close();
    seenPartnerSock.close();
  }

  // ===== 5e. Job dọn rác uploads (chỉ xóa file cũ không được tham chiếu) =====
  {
    process.env.DB_PATH = DB_PATH;
    const db = require('../db');
    const { cleanupUploads } = require('../uploads-cleanup');
    const tmpDir = fs.mkdtempSync(path.join(__dirname, '..', 'data', 'cleanup-'));
    try {
      db.insertMessage(convId, user.user.id, 'file tham chiếu', '/uploads/keep-this-file.png', 'keep-this-file.png');
      const kept = path.join(tmpDir, 'keep-this-file.png');
      const orphan = path.join(tmpDir, 'orphan-old.png');
      const fresh = path.join(tmpDir, 'fresh-new.png');
      const nested = path.join(tmpDir, 'nested-dir');
      fs.writeFileSync(kept, 'x');
      fs.writeFileSync(orphan, 'x');
      fs.writeFileSync(fresh, 'x');
      fs.mkdirSync(nested);
      const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      fs.utimesSync(kept, old, old);
      fs.utimesSync(orphan, old, old);

      const result = cleanupUploads(db, tmpDir, { minAgeMs: 24 * 3600 * 1000 });
      check('🔍 dọn rác: xóa đúng 1 file cũ không được tham chiếu', result.removed === 1, JSON.stringify(result));
      check('🔍 dọn rác: giữ file đang được tin nhắn tham chiếu', fs.existsSync(kept), 'keep-this-file.png bị xóa');
      check('🔍 dọn rác: giữ file mới chưa quá hạn (grace period)', fs.existsSync(fresh), 'fresh-new.png bị xóa');
      check('🔍 dọn rác: bỏ qua thư mục con', fs.existsSync(nested), 'nested-dir bị xóa');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ===== 5f. Cache câu trả lời LLM (câu hỏi lặp lại không gọi API lại) =====
  {
    let llmHits = 0;
    const mock = http.createServer((req, res) => {
      llmHits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Phun Tricyclazole "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"khi thấy vết bệnh."}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));

    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_MODEL = 'mock-model';
    process.env.LLM_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
    process.env.LLM_FALLBACK_PROVIDER = 'off';
    const bot = require('../bot');
    const replyCache = require('../reply-cache');
    replyCache.clear();

    try {
      const question = { senderRole: 'user', content: 'lúa bị đạo ôn thì phun thuốc gì?' };
      let chunks1 = '';
      const r1 = await bot.generateReply([question], (d) => { chunks1 += d; });
      let chunks2 = '';
      const r2 = await bot.generateReply([question], (d) => { chunks2 += d; });
      check('🔍 cache LLM: câu hỏi lặp lại dùng lại câu trả lời (API chỉ gọi 1 lần)',
        llmHits === 1 && r1.via === 'llm' && r2.via === 'llm'
          && chunks1 === chunks2 && r1.text.includes('Tricyclazole'),
        JSON.stringify({ llmHits, via1: r1.via, via2: r2.via, same: chunks1 === chunks2 }));

      let chunks3 = '';
      const r3 = await bot.generateReply([{ senderRole: 'user', content: 'bị bạc lá thì làm sao?' }], (d) => { chunks3 += d; });
      check('🔍 cache LLM: câu hỏi khác vẫn gọi API bình thường',
        llmHits === 2 && r3.via === 'llm' && chunks3.length > 0,
        JSON.stringify({ llmHits, via: r3.via }));

      replyCache.set('k1', { text: 'a' }, 1000);
      check('🔍 reply-cache: get trả đúng entry trong TTL', replyCache.get('k1', 2000)?.text === 'a', 'miss');
      check('🔍 reply-cache: hết TTL → miss', replyCache.get('k1', 1000 + 24 * 3600 * 1000) === null, 'vẫn còn entry');
      for (let i = 0; i < 205; i += 1) replyCache.set(`bulk-${i}`, { text: String(i) }, 0);
      check('🔍 reply-cache: LRU giới hạn 200 entry (đẩy entry cũ nhất)',
        replyCache.get('bulk-0', 100) === null && replyCache.get('bulk-204', 100)?.text === '204',
        'sai kích thước cache');
    } finally {
      replyCache.clear();
      mock.close();
    }
  }

  // ===== 5f2. Fallback bậc 2 (LLM_FALLBACK2_*): chính + fallback lỗi → vẫn trả lời =====
  {
    const bad = http.createServer((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"mock down"}}');
    });
    await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve));
    let goodHits = 0;
    const good = http.createServer((req, res) => {
      goodHits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Fallback 2 trả lời "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"thành công."}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => good.listen(0, '127.0.0.1', resolve));
    const badBase = `http://127.0.0.1:${bad.address().port}`;
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_MODEL = 'mock-model';
    process.env.LLM_BASE_URL = badBase;
    process.env.LLM_FALLBACK_PROVIDER = 'openai';
    process.env.LLM_FALLBACK_API_KEY = 'test-key';
    process.env.LLM_FALLBACK_MODEL = 'mock-model';
    process.env.LLM_FALLBACK_BASE_URL = badBase;
    process.env.LLM_FALLBACK2_PROVIDER = 'openai';
    process.env.LLM_FALLBACK2_API_KEY = 'test-key';
    process.env.LLM_FALLBACK2_MODEL = 'mock-model';
    process.env.LLM_FALLBACK2_BASE_URL = `http://127.0.0.1:${good.address().port}`;
    delete require.cache[require.resolve('../bot')];
    const bot2 = require('../bot');
    const cache2 = require('../reply-cache');
    cache2.clear();
    try {
      let resets = 0;
      let chunks = '';
      const reply = await bot2.generateReply(
        [{ senderRole: 'user', content: 'kiểm tra fallback bậc hai' }],
        (d) => { chunks += d; },
        () => { resets += 1; },
      );
      check('🔍 fallback bậc 2: chính + fallback lỗi → API dự phòng 2 vẫn trả lời',
        reply.via === 'llm' && reply.used === 'fallback2' && goodHits === 1
          && chunks.includes('Fallback 2'),
        JSON.stringify({ via: reply.via, used: reply.used, goodHits }));
      check('🔍 fallback bậc 2: reset stream trước mỗi lần chuyển API', resets === 2, `resets=${resets}`);
    } finally {
      cache2.clear();
      good.close();
      bad.close();
    }
  }

  // ===== 5b. Bot AI: toggle + trả lời tự động + phân quyền =====
  r = await httpJson(`/api/admin/conversations/${convId}/bot`, { method: 'POST', body: { enabled: true } });
  check('toggle bot khi chưa login → 401', r.status === 401, `status ${r.status}`);
  r = await httpJson(`/api/admin/conversations/${convId}/bot`, { method: 'POST', body: { enabled: true }, cookie: user.cookie });
  check('user toggle bot → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson(`/api/admin/conversations/${convId}/bot`, { method: 'POST', body: { enabled: true }, cookie: partner.cookie });
  check('partner toggle bot → 403', r.status === 403, `status ${r.status}`);
  r = await httpJson(`/api/admin/conversations/${convId}/bot`, { method: 'POST', body: { enabled: 'co' }, cookie: admin.cookie });
  check('🔍 toggle bot enabled không phải boolean → 400', r.status === 400, `status ${r.status}`);
  r = await httpJson(`/api/admin/conversations/${partnerUserConvId}/bot`, { method: 'POST', body: { enabled: false }, cookie: admin.cookie });
  check('🔍 toggle bot trên thread partner → 404', r.status === 404, `status ${r.status}`);

  // Bot đang tắt (tắt từ section 2) → khách nhắn không có hồi âm
  // Chờ reset cửa sổ rate-limit socket 8 tin/10s của user
  await new Promise((res) => setTimeout(res, 11000));

  const botUserSock = connectSocket(user.sessionId);
  const botAdminSock = connectSocket(admin.sessionId);
  try {
    botUserSock.emit('join', { convId });
    await waitEvent(botUserSock, 'joined', (d) => d.convId === convId);
    botAdminSock.emit('join', { convId });
    await waitEvent(botAdminSock, 'joined', (d) => d.convId === convId);

    let botReplies = 0;
    const botCounter = (m) => { if (m.senderRole === 'bot' && m.convId === convId) botReplies += 1; };
    botUserSock.on('message', botCounter);

    const botOffEchoP = waitEvent(botUserSock, 'message', (m) => m.content === 'bot tắt rồi, trả lời đi');
    botUserSock.emit('message', { convId, content: 'bot tắt rồi, trả lời đi' });
    await botOffEchoP;
    await new Promise((res) => setTimeout(res, 2500));
    check('bot đã tắt → khách nhắn không có hồi âm', botReplies === 0, `replies=${botReplies}`);

    // Bật lại → chuỗi: typing Trợ lý AI → bot-stream chunk → message bot cuối
    r = await httpJson(`/api/admin/conversations/${convId}/bot`, { method: 'POST', body: { enabled: true }, cookie: admin.cookie });
    check('admin bật bot lại → 200 + botEnabled=true', r.status === 200 && r.data.success && r.data.botEnabled === true, JSON.stringify(r.data));

    const botTypingP = waitEvent(botUserSock, 'typing', (d) => d.isTyping === true && d.name === 'Trợ lý AI', 8000);
    const botStreamP = waitEvent(botUserSock, 'bot-stream', (d) => d.convId === convId && typeof d.delta === 'string' && d.delta.length > 0, 8000);
    const botMsgP = waitEvent(botUserSock, 'message', (m) => m.senderRole === 'bot' && m.convId === convId && /^bot-/.test(m.clientId || ''), 10000);
    botUserSock.emit('message', { convId, content: 'lúa bị đạo ôn thì phun thuốc gì?' });
    const [botTyping, botStream, botMsg] = await Promise.all([botTypingP, botStreamP, botMsgP]);
    check('bot trả lời: typing (Trợ lý AI) → bot-stream chunk → message senderRole=bot',
      botTyping.name === 'Trợ lý AI' && botStream.delta.length > 0 && botMsg.senderRole === 'bot',
      JSON.stringify({ typing: botTyping.name, delta: botStream.delta.slice(0, 30), role: botMsg.senderRole }));
    check('bot trả lời đúng chủ đề đạo ôn', /tricyclazole|đạo ôn/i.test(botMsg.content), botMsg.content.slice(0, 120));
    check('🔍 bot-stream clientId khớp message cuối', botStream.clientId === botMsg.clientId,
      JSON.stringify({ stream: botStream.clientId, msg: botMsg.clientId }));

    // Bot không tính vào unread: admin đọc hết, khách nhắn tiếp → chỉ đếm 1 tin khách
    botAdminSock.emit('read', { convId });
    await waitEvent(botAdminSock, 'badge-cleared', (d) => d.convId === convId);
    const botReply2P = waitEvent(botUserSock, 'message', (m) => m.senderRole === 'bot', 10000);
    botUserSock.emit('message', { convId, content: 'bị bạc lá thì xử lý sao?' });
    await botReply2P;
    await new Promise((res) => setTimeout(res, 400));
    r = await httpJson('/api/admin/users', { cookie: admin.cookie });
    check('🔍 tin bot không tính vào unread của admin (chỉ tin khách)',
      r.data.users.find((u) => u.conversation_id === convId).unread_count === 1,
      `unread=${r.data.users.find((u) => u.conversation_id === convId).unread_count}`);

    // Bot chỉ trả lời khách trong thread user_admin
    const repliesBefore = botReplies;
    botAdminSock.emit('message', { convId, content: 'Admin đang trực, bot im lặng nhé' });
    await new Promise((res) => setTimeout(res, 2500));
    check('admin nhắn trong thread khách↔admin → bot không trả lời', botReplies === repliesBefore, `replies=${botReplies - repliesBefore}`);

    botUserSock.emit('join', { convId: partnerUserConvId });
    await waitEvent(botUserSock, 'joined', (d) => d.convId === partnerUserConvId);
    botUserSock.emit('message', { convId: partnerUserConvId, content: 'bot có trả lời ở đây không?' });
    await new Promise((res) => setTimeout(res, 2500));
    check('🔍 khách nhắn thread partner → bot không trả lời', botReplies === repliesBefore, `replies=${botReplies - repliesBefore}`);
  } finally {
    botUserSock.close();
    botAdminSock.close();
  }

  // ===== 5g. Bot ngoài giờ hành chính (OFFICE_HOURS) + báo admin khi bot không chắc chắn =====
  {
    // Unit: parse OFFICE_HOURS + isOfficeHoursNow (re-require bot.js với env khác nhau)
    delete require.cache[require.resolve('../bot')];
    process.env.OFFICE_HOURS = '25-26';
    const offBot = require('../bot');
    check('🔍 OFFICE_HOURS=25-26 → isOfficeHoursNow luôn false (ngoài giờ)',
      !offBot.isOfficeHoursNow(new Date('2026-10-27T12:00:00'))
      && !offBot.isOfficeHoursNow(new Date('2026-10-27T08:00:00')));
    check('🔍 OFFHOURS_REPLY nhắc khách liên hệ trong giờ làm việc',
      /ngoài giờ|giờ làm việc/i.test(offBot.OFFHOURS_REPLY), offBot.OFFHOURS_REPLY.slice(0, 60));
    delete require.cache[require.resolve('../bot')];
    process.env.OFFICE_HOURS = '0-24';
    const inBot = require('../bot');
    check('🔍 OFFICE_HOURS=0-24 → isOfficeHoursNow luôn true (trong giờ)',
      inBot.isOfficeHoursNow(new Date('2026-10-27T12:00:00'))
      && inBot.isOfficeHoursNow(new Date('2026-10-27T23:59:00'))
      && inBot.isOfficeHoursNow(new Date('2026-10-27T00:00:00')));

    // Server phụ OFFICE_HOURS='25-26' (luôn ngoài giờ): bot trả lời cố định, không tư vấn chủ đề
    const OFF_PORT = 3101;
    const OFF_DB = path.join(__dirname, '..', 'data', 'e2e-offhours.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const f = OFF_DB + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    const offServer = await startServer({ port: OFF_PORT, dbPath: OFF_DB, env: { OFFICE_HOURS: '25-26' } });
    const offBase = `http://localhost:${OFF_PORT}`;
    try {
      const offName = 'off_' + Date.now().toString(36);
      await httpJson('/api/register', { method: 'POST', body: { username: offName, password: 'pass123', display_name: 'Off Hours' } }, offBase);
      const off = await loginAndGetSession(offName, 'pass123', offBase);
      const offMe = await httpJson('/api/me', { cookie: off.cookie }, offBase);
      const offConvId = offMe.data.conversation_id;
      const offSock = connectSocket(off.sessionId, offBase);
      try {
        offSock.emit('join', { convId: offConvId });
        await waitEvent(offSock, 'joined', (d) => d.convId === offConvId);
        const offStreamP = waitEvent(offSock, 'bot-stream', (d) => d.convId === offConvId && typeof d.delta === 'string' && d.delta.length > 0, 8000);
        const offMsgP = waitEvent(offSock, 'message', (m) => m.senderRole === 'bot' && m.convId === offConvId, 10000);
        offSock.emit('message', { convId: offConvId, content: 'lúa bị đạo ôn thì phun thuốc gì?' });
        const [offStream, offMsg] = await Promise.all([offStreamP, offMsgP]);
        check('🔍 ngoài giờ: bot trả lời cố định OFFHOURS_REPLY',
          offMsg.content === offBot.OFFHOURS_REPLY && offStream.delta === offBot.OFFHOURS_REPLY,
          offMsg.content.slice(0, 90));
        check('🔍 ngoài giờ: không tư vấn chủ đề (không gọi LLM/KB)',
          !/tricyclazole|đạo ôn/i.test(offMsg.content), offMsg.content.slice(0, 90));
      } finally {
        offSock.close();
      }
    } finally {
      offServer.kill();
      await new Promise((res) => setTimeout(res, 400));
      for (const suffix of ['', '-wal', '-shm']) {
        const f = OFF_DB + suffix;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }

    // Bot không chắc chắn trên server chính (LLM off → rule-based; câu lạ → KB fallback → bot-unsure)
    await new Promise((res) => setTimeout(res, 11000)); // reset cửa sổ rate-limit 8 tin/10s
    r = await httpJson(`/api/admin/conversations/${convId}/bot`, { method: 'POST', body: { enabled: true }, cookie: admin.cookie });
    const unsureUserSock = connectSocket(user.sessionId);
    const unsureAdminSock = connectSocket(admin.sessionId);
    try {
      unsureUserSock.emit('join', { convId });
      await waitEvent(unsureUserSock, 'joined', (d) => d.convId === convId);
      const unsureP = waitEvent(unsureAdminSock, 'bot-unsure', (d) => d.convId === convId && d.userId === user.user.id, 10000);
      const botFallbackP = waitEvent(unsureUserSock, 'message', (m) => m.senderRole === 'bot' && m.convId === convId, 10000);
      unsureUserSock.emit('message', { convId, content: 'xyz abc qwerty không liên quan gì cả' });
      const [unsureEv, botFallbackMsg] = await Promise.all([unsureP, botFallbackP]);
      check('🔍 bot không chắc chắn → admin nhận bot-unsure (convId/userId/userName/preview)',
        unsureEv.userId === user.user.id && !!unsureEv.userName && typeof unsureEv.preview === 'string',
        JSON.stringify(unsureEv));
      check('🔍 bot vẫn trả lời khách bằng KB fallback',
        botFallbackMsg.content === require('../knowledge-base').fallback,
        botFallbackMsg.content.slice(0, 90));
    } finally {
      unsureUserSock.close();
      unsureAdminSock.close();
    }
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

  // ===== 8. Rate-limit login (bộ đếm trong bộ nhớ đã reset sau restart ở bước 7) =====
  let lastStatus = 0;
  for (let i = 0; i < 21; i += 1) {
    r = await httpJson('/api/login', { method: 'POST', body: { username: 'admin', password: 'sai-mat-khau' } });
    lastStatus = r.status;
  }
  check('🔍 rate-limit login: quá 20 lần / 5 phút → 429', lastStatus === 429, `status lần cuối ${lastStatus}`);

  server.kill();
  console.log(`\n📊 Kết quả: ${passed} pass / ${failed} fail (tổng ${passed + failed})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('💥 E2E crash:', e);
  process.exit(2);
});
