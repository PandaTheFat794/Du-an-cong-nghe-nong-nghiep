// UI check end-to-end: Edge/Chrome headless, đi qua cả 3 role (user/admin/partner),
// upload ảnh, realtime, typing, phân quyền trang, panel tài khoản, rate-limit.
//
// Mặc định tự spawn server ở port 3199 với DB riêng (data/ui-check.db) đã xoá sạch
// → chạy lại nhiều lần vẫn cho kết quả như nhau.
// Dùng server có sẵn (DB phải mới): UI_BASE=http://localhost:3000 node scripts/ui-check.js
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 3199;
const BASE = process.env.UI_BASE || `http://localhost:${PORT}`;
const DB_PATH = path.join(ROOT, 'data', 'ui-check.db');
const SHOT_DIR = process.env.UI_SHOT_DIR || path.join(ROOT, '.verify');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const SHOT = (n) => path.join(SHOT_DIR, n);
const FIXTURE_PNG = path.join(__dirname, 'fixtures', 'attach.png');

const EXEC_CANDIDATES = [
  process.env.UI_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const EXEC = EXEC_CANDIDATES.find((p) => fs.existsSync(p));
if (!EXEC) {
  console.error('❌ Không tìm thấy trình duyệt. Set UI_BROWSER=<đường dẫn chrome/msedge>.');
  process.exit(2);
}

const checks = [];
function ok(name, detail) { checks.push({ name, pass: true, detail }); console.log(`  ✅ ${name}${detail ? ` (${detail})` : ''}`); }
function bad(name, detail) { checks.push({ name, pass: false, detail }); console.log(`  ❌ ${name} → ${detail}`); }
function assert(cond, name, detail) { cond ? ok(name, detail) : bad(name, detail); }

function startServer() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, SESSION_SECRET: 'ui-check-secret', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.pipe(process.stderr);
  return child;
}

async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(BASE + '/api/me');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`server không trả lời trong ${timeoutMs}ms (${BASE})`);
}

async function login(ctx, user, pass, expectPath) {
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.fill('#loginUsername', user);
  await page.fill('#loginPassword', pass);
  const nav = page.waitForURL('**' + expectPath, { timeout: 8000 });
  await page.click('#loginForm button[type=submit]');
  await nav;
  return page;
}

(async () => {
  const server = process.env.UI_BASE ? null : startServer();
  let browser = null;
  try {
    await waitForServer();
    browser = await chromium.launch({ executablePath: EXEC, headless: true });

    // ===== Trang đăng nhập =====
    const ctxL = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const L = await ctxL.newPage();
    await L.goto(BASE + '/');
    await L.waitForTimeout(900);
    await L.screenshot({ path: SHOT('00-login.png') });
    assert(await L.locator('#loginForm').isVisible() && !(await L.locator('#registerForm').isVisible()),
      '🔍 mặc định chỉ hiện form đăng nhập (register ẩn qua [hidden])');
    await L.click('#tabRegister');
    await L.waitForTimeout(400);
    await L.screenshot({ path: SHOT('00b-dang-ky.png') });

    // ===== User vào /chat =====
    const ctxU = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const U = await login(ctxU, 'user1', 'user123', '/chat');
    ok('user1 login → redirect /chat', U.url());
    assert(!(await U.locator('#partnerChip').isVisible()), '🔍 chưa gán partner → chip ẩn', 'partnerChip visible=false');
    await U.screenshot({ path: SHOT('01-user-chat.png') });

    await U.fill('#msgInput', 'Chào admin, rau nhà em bị vàng lá');
    await U.click('#sendBtn');
    await U.waitForSelector('.message.user', { timeout: 5000 });
    const uBubble = await U.locator('.message.user').innerText();
    assert(uBubble.includes('vàng lá'), 'user gửi tin → bubble hiện trong chat', uBubble.slice(0, 40));

    const before = await U.locator('.message').count();
    await U.click('#sendBtn');
    await U.waitForTimeout(500);
    assert((await U.locator('.message').count()) === before, '🔍 gửi tin rỗng → không tạo bubble', `count vẫn ${before}`);

    // ===== Admin vào /admin =====
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const A = await login(ctxA, 'admin', 'admin123', '/admin');
    ok('admin login → redirect /admin', A.url());
    await A.waitForSelector('.user-item');
    const badge = await A.locator('.user-unread').first().innerText();
    assert(badge === '1', 'sidebar admin hiện badge unread = 1', `badge="${badge}"`);
    await A.screenshot({ path: SHOT('02-admin-sidebar.png') });

    await A.click('.user-item');
    await A.waitForSelector('.message.admin', { timeout: 5000 });
    const histMsg = await A.locator('.message.admin').first().innerText();
    assert(histMsg.includes('vàng lá'), 'admin mở conv → history có tin của user', histMsg.slice(0, 40));

    await A.waitForFunction(() => {
      const b = document.querySelector('.user-unread');
      return !!b && b.hidden;
    }, null, { timeout: 5000 }).catch(() => {});
    const badgeHidden = await A.locator('.user-unread').first().isVisible().catch(() => false);
    assert(!badgeHidden, 'admin mở chat → badge unread bị ẩn (socket read)', `visible=${badgeHidden}`);

    // ===== Typing indicator: admin soạn → user thấy bubble 3 chấm =====
    await A.locator('#msgInput').pressSequentially('Đang soạn', { delay: 60 });
    try {
      await U.waitForSelector('.typing-row', { timeout: 4000 });
      ok('⌨️ user thấy bubble "đang gõ" khi admin soạn tin');
      await U.screenshot({ path: SHOT('07-typing.png') });
    } catch { bad('typing indicator', '.typing-row không xuất hiện trên chat user'); }

    await A.fill('#msgInput', 'Em chụp lá gửi anh nhé');
    await A.click('#sendBtn');
    await A.waitForSelector('#messagesArea .message.user', { timeout: 5000 });
    ok('admin gửi tin → bubble bên phải hiện');

    // ===== Realtime: user nhận tin admin KHÔNG cần reload =====
    try {
      await U.waitForFunction(
        () => [...document.querySelectorAll('#messagesArea .message.admin')].some((el) => el.textContent.includes('chụp lá')),
        null, { timeout: 6000 }
      );
      ok('⚡ realtime: user nhận tin admin qua WebSocket (không reload)');
    } catch { bad('realtime user nhận tin admin', 'timeout 6s, bubble không xuất hiện'); }

    await U.waitForFunction(() => !document.querySelector('.typing-row'), null, { timeout: 4000 })
      .then(() => ok('typing bubble biến mất khi tin gửi tới'), () => bad('typing bubble không bị gỡ', 'vẫn còn .typing-row'));

    // ===== Upload ảnh từ admin =====
    await A.setInputFiles('#attachInput', FIXTURE_PNG);
    await A.waitForFunction(() => document.getElementById('attachChip').textContent.includes('attach.png'), null, { timeout: 8000 });
    await A.fill('#msgInput', 'Ảnh minh here');
    await A.click('#sendBtn');
    await U.waitForSelector('.message.admin img', { timeout: 8000 }).then(
      () => ok('upload + gửi ảnh: user thấy <img> trong chat realtime'),
      () => bad('user thấy ảnh từ admin', 'không có img')
    );
    await U.screenshot({ path: SHOT('03-user-nhan-anh.png') });

    // ===== Admin gán Partner qua UI =====
    await A.selectOption('#partnerSelect', { label: 'Partner Test' });
    await A.click('#connectPartnerBtn');
    const toastLoc = A.locator('.toast', { hasText: /kết nối/i });
    await toastLoc.waitFor({ state: 'visible', timeout: 5000 });
    const status = await toastLoc.innerText();
    assert(/kết nối/i.test(status), 'admin bấm Kết nối Partner → toast xác nhận', status);
    await A.screenshot({ path: SHOT('04-admin-da-gan-partner.png') });

    // ===== Partner vào /partner (read-only) =====
    const ctxP = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const P = await login(ctxP, 'partner1', 'admin123', '/partner');
    ok('partner1 login → redirect /partner', P.url());
    await P.waitForSelector('.partner-item');
    const itemTxt = await P.locator('.partner-item').first().innerText();
    assert(itemTxt.includes('Khách hàng Test'), 'partner thấy khách được gán', itemTxt);

    await P.click('.partner-item');
    await P.waitForSelector('.partner-message', { timeout: 5000 });
    const pCount = await P.locator('.partner-message').count();
    assert(pCount >= 3, 'partner xem được toàn bộ lịch sử (read-only)', `${pCount} tin`);
    assert((await P.locator('#msgInput').count()) === 0, 'partner KHÔNG có ô nhập tin (chỉ đọc)', 'msgInput count=0');
    await P.screenshot({ path: SHOT('05-partner-readonly.png') });

    // 🔍 probe: partner cố vào /admin → pageGuard đá về login
    await P.goto(BASE + '/admin');
    assert(new URL(P.url()).pathname === '/', '🔍 partner gọi thẳng /admin → redirect /', P.url());

    // ===== User thấy chip partner sau refresh (gán xong) =====
    await U.reload();
    await U.waitForSelector('#partnerChip:visible', { timeout: 6000 });
    ok('user reload → header hiện chip "Đồng hành: Partner Test"', await U.locator('#partnerChip').innerText());
    await U.screenshot({ path: SHOT('06-user-chip-partner.png') });

    // 🔍 probe: register trùng tên qua tab Đăng ký
    const ctxX = await browser.newContext();
    const X = await ctxX.newPage();
    await X.goto(BASE + '/');
    await X.click('#tabRegister');
    await X.fill('#regDisplayName', 'Dup Test');
    await X.fill('#regUsername', 'user1');
    await X.fill('#regPassword', 'pass123');
    await X.click('#registerForm button[type=submit]');
    await X.waitForSelector('#authError:visible', { timeout: 6000 });
    ok('🔍 register trùng → báo lỗi "đã tồn tại"', await X.locator('#authError').innerText());

    // 🔍 probe: mật khẩu ngắn bị server validate
    await X.fill('#regUsername', 'shortpw_test');
    await X.fill('#regPassword', 'x');
    await X.click('#registerForm button[type=submit]');
    await X.waitForFunction(() => /mật khẩu phải dài/i.test(document.getElementById('authError').textContent), null, { timeout: 6000 });
    ok('🔍 register mật khẩu ngắn → báo lỗi tối thiểu 6 ký tự', await X.locator('#authError').innerText());
    await ctxX.close();

    // ===== Panel Tài khoản =====
    await U.click('button.chat-btn:has-text("Tài khoản")');
    await U.waitForSelector('.account-panel:visible', { timeout: 4000 });
    const panelTxt = await U.locator('.account-panel').innerText();
    assert(panelTxt.includes('Đổi mật khẩu') && panelTxt.includes('Xóa tài khoản'), 'user thấy panel Tài khoản (đổi mk + tự xóa)', panelTxt.split('\n')[0]);
    await U.fill('#pwCurrent', 'sai');
    await U.fill('#pwNew', 'abcdef');
    await U.click('.account-panel #pwForm button[type=submit]');
    await U.waitForFunction(() => /không đúng/i.test(document.getElementById('pwMsg').textContent), null, { timeout: 5000 });
    ok('🔍 đổi mk sai mật khẩu hiện tại → báo lỗi trong panel', await U.locator('#pwMsg').innerText());
    await U.keyboard.press('Escape');
    await U.click('body');

    const A2del = await A.locator('.user-delete').count();
    assert(A2del >= 1, 'sidebar admin có nút Xóa khách hàng', `${A2del} nút`);

    // 🔍 admin đã trả lời → reload sidebar, không được tự sinh badge cho tin của chính mình
    await A.reload();
    await A.waitForSelector('.user-item');
    const ownBadgeVisible = await A.locator('.user-unread').first().isVisible().catch(() => false);
    assert(!ownBadgeVisible, '🔍 admin tự trả lời không tạo badge unread của chính mình', `visible=${ownBadgeVisible}`);

    // 🔍 gửi dồn dập vượt rate-limit → tin bị chặn phải được trả lại ô nhập (không mất chữ)
    for (let i = 0; i < 9; i += 1) {
      await U.fill('#msgInput', `spam ${i}`);
      await U.click('#sendBtn');
      await U.waitForTimeout(120);
    }
    await U.waitForSelector('.toast-error:visible', { timeout: 6000 }).catch(() => {});
    await U.waitForTimeout(500);
    const restored = await U.inputValue('#msgInput');
    assert(restored.startsWith('spam'), '🔍 bị rate-limit → chữ trong tin bị chặn được trả lại ô nhập', `input="${restored}"`);
    const pendingLeft = await U.locator('.message.pending').count();
    assert(pendingLeft === 0, '🔍 không còn bubble "đang gửi" treo sau khi có lỗi', `pending=${pendingLeft}`);

    // ===== Logout =====
    await U.click('#logoutBtn');
    await U.waitForURL(BASE + '/', { timeout: 6000 });
    ok('user bấm Đăng xuất → về /');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
  }

  const fails = checks.filter((c) => !c.pass).length;
  console.log(`\n📊 UI check: ${checks.length - fails} pass / ${fails} fail`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('💥 UI check crash:', e); process.exit(2); });
