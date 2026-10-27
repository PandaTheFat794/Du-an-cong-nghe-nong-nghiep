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

// Nút nào trong header vượt mép phải khung chat (bị cắt) → trả về nhãn
async function headerOverflow(page) {
  return page.evaluate(() => {
    const headerRight = document.querySelector('.chat-header').getBoundingClientRect().right;
    return [...document.querySelectorAll('.chat-header .chat-controls > *')]
      .filter((el) => !el.hidden && el.getClientRects().length)
      .map((el) => ({ text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 24), right: el.getBoundingClientRect().right }))
      .filter((x) => x.right > headerRight + 1)
      .map((x) => x.text);
  });
}

(async () => {
  const server = process.env.UI_BASE ? null : startServer();
  let browser = null;
  try {
    await waitForServer();
    browser = await chromium.launch({
      executablePath: EXEC,
      headless: true,
      // Cho phép test ghi âm bằng micro giả của Chromium
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });

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

    const quickLabels = await L.locator('.quick-account').allInnerTexts();
    assert(quickLabels.length === 3
      && quickLabels.some((t) => t.includes('Khách hàng'))
      && quickLabels.some((t) => t.includes('Admin'))
      && quickLabels.some((t) => t.includes('Partner')),
      '🔍 trang login có 3 nút vào nhanh User/Admin/Partner', quickLabels.join(' | '));
    await L.click('.quick-account[data-quick-user="admin"]');
    await L.waitForURL('**/admin', { timeout: 10000 });
    ok('bấm nút Admin → vào thẳng /admin, không cần gõ mật khẩu', L.url());

    // ===== User vào /chat =====
    const ctxU = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const U = await login(ctxU, 'user1', 'user123', '/chat');
    ok('user1 login → redirect /chat', U.url());
    assert(!(await U.locator('#threadTabs').isVisible()),
      '🔍 chưa gán partner → chỉ có luồng chat với admin (tab partner ẩn)', 'threadTabs visible=false');
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

    // ===== User tự ghi nhật ký canh tác kèm ảnh =====
    await U.click('#processBtn');
    await U.waitForSelector('.process-overlay.open', { timeout: 4000 });
    await U.click('#processAddToggle');
    await U.selectOption('#processActivity', 'fertilizing');
    await U.fill('#processDate', '2026-10-20');
    await U.fill('#processTitle', 'Bón lót vụ đông');
    await U.fill('#processMethod', 'Bón vãi');
    await U.fill('#processDetails', 'NPK 20-20-15, 150kg/ha');
    await U.setInputFiles('#processAttachInput', FIXTURE_PNG);
    await U.waitForFunction(() => document.getElementById('processAttachChip').textContent.includes('attach.png'), null, { timeout: 8000 });
    await U.click('#processSubmitBtn');
    await U.waitForFunction(
      () => [...document.querySelectorAll('.process-entry-title')].some((el) => el.textContent.includes('Bón lót')),
      null, { timeout: 8000 }
    );
    assert((await U.locator('.process-entry-media img').count()) >= 1,
      'user thêm nhật ký kèm ảnh → timeline hiện card + ảnh');
    await U.waitForTimeout(450); // chờ animation stagger của timeline kết thúc
    await U.screenshot({ path: SHOT('04-user-nhat-ky.png') });
    await U.click('#processDrawerClose');
    await U.waitForSelector('.process-overlay', { state: 'hidden', timeout: 4000 });
    ok('drawer nhật ký đóng được sau khi lưu');

    // ===== Admin vào /admin =====
    const ctxA = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['microphone'],
    });
    const A = await login(ctxA, 'admin', 'admin123', '/admin');
    ok('admin login → redirect /admin', A.url());
    await A.waitForSelector('.user-item');
    const badge = await A.locator('.user-unread:not(.partner)').first().innerText();
    assert(badge === '1', 'sidebar admin hiện badge unread = 1', `badge="${badge}"`);
    const stats = await A.evaluate(() => ({
      customers: document.getElementById('statCustomers').textContent,
      unread: document.getElementById('statUnread').textContent,
      partner: document.getElementById('statPartnerUnread').textContent,
      process: document.getElementById('statProcess').textContent,
    }));
    assert(stats.customers === '1' && stats.unread === '1' && stats.partner === '0' && stats.process === '1',
      'sidebar admin có 4 thẻ tổng quan đúng số liệu', JSON.stringify(stats));

    // 🔍 tìm khách không tồn tại → empty state, Esc xóa lọc khôi phục danh sách
    await A.fill('#adminSearch', 'khong-co-ai');
    await A.waitForFunction(() => document.querySelectorAll('#adminUserList .user-item').length === 0, null, { timeout: 3000 });
    const searchEmpty = await A.locator('#adminUserList .no-partner').innerText();
    assert(searchEmpty.includes('Không tìm thấy'), '🔍 tìm khách không tồn tại → danh sách trống + gợi ý', searchEmpty);
    await A.press('#adminSearch', 'Escape');
    await A.waitForFunction(() => document.querySelectorAll('#adminUserList .user-item').length === 1, null, { timeout: 3000 });
    ok('Esc trong ô tìm kiếm → xóa từ khóa, danh sách khách hiện lại');

    await A.screenshot({ path: SHOT('02-admin-sidebar.png') });

    await A.click('.user-item');
    await A.waitForSelector('.message.admin', { timeout: 5000 });
    const histMsg = await A.locator('.message.admin').first().innerText();
    assert(histMsg.includes('vàng lá'), 'admin mở conv → history có tin của user', histMsg.slice(0, 40));

    await A.waitForFunction(() => {
      const b = document.querySelector('.user-unread:not(.partner)');
      return !!b && b.hidden;
    }, null, { timeout: 5000 }).catch(() => {});
    const badgeHidden = await A.locator('.user-unread:not(.partner)').first().isVisible().catch(() => false);
    assert(!badgeHidden, 'admin mở chat → badge unread bị ẩn (socket read)', `visible=${badgeHidden}`);
    const unreadStatAfterRead = await A.locator('#statUnread').innerText();
    assert(unreadStatAfterRead === '0', 'thẻ "Tin khách chưa đọc" cập nhật về 0 realtime', `stat=${unreadStatAfterRead}`);

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
    await U.waitForTimeout(350);
    await U.screenshot({ path: SHOT('03-user-nhan-anh.png') });

    // ===== Lightbox xem ảnh to trong chat =====
    await U.click('.message.admin img');
    await U.waitForSelector('.lightbox', { state: 'visible', timeout: 4000 });
    const lbSrc = await U.locator('.lightbox img').getAttribute('src');
    assert((lbSrc || '').includes('/uploads/'), '🔍 bấm ảnh tin nhắn → lightbox hiện ảnh to', lbSrc || 'null');
    await U.waitForTimeout(300);
    await U.screenshot({ path: SHOT('03c-lightbox.png') });
    await U.keyboard.press('Escape');
    await U.waitForSelector('.lightbox', { state: 'hidden', timeout: 4000 });
    ok('🔍 Esc → đóng lightbox');

    // ===== Ghi âm tin nhắn thoại (micro giả của Chromium) =====
    assert(await A.locator('#voiceBtn').isVisible(), 'admin thấy nút ghi âm trong khung chat');
    await A.click('#voiceBtn');
    try {
      await A.waitForSelector('#voiceBtn.recording', { timeout: 5000 });
      ok('🎙️ bấm micro → vào trạng thái ghi âm (nút đỏ)');
      await A.waitForFunction(() => document.getElementById('attachChip').textContent.includes('Đang ghi âm'), null, { timeout: 3000 });
      ok('chip hiện đồng hồ đếm khi đang ghi');
      await A.waitForTimeout(1400);
      await A.screenshot({ path: SHOT('06-admin-dang-ghi-am.png') });
      await A.click('#voiceBtn');
      await A.waitForSelector('#messagesArea .message.user:not(.pending) audio', { timeout: 15000 });
      ok('dừng ghi → tự upload + gửi bubble có <audio>');
      const audioSrc = await A.locator('#messagesArea .message.user audio').last().getAttribute('src');
      assert(/^\/uploads\/.*\.(webm|ogg|m4a)$/.test(audioSrc || ''), 'audio trỏ tới file đã upload', audioSrc || 'null');
      await A.waitForFunction(() => !document.querySelector('#voiceBtn.recording'), null, { timeout: 4000 });
      assert(!(await A.locator('#msgInput').isDisabled()), 'kết thúc ghi âm → mở khóa ô nhập');
      try {
        await U.waitForSelector('#messagesArea .message.admin audio', { timeout: 10000 });
        ok('⚡ user nhận tin nhắn thoại realtime');
      } catch { bad('user nhận tin nhắn thoại', 'không thấy <audio> sau 10s'); }
      await U.waitForTimeout(350);
      await U.screenshot({ path: SHOT('03b-user-nhan-audio.png') });
    } catch (e) {
      bad('ghi âm tin nhắn', e.message.split('\n')[0]);
    }

    // ===== Admin gán Partner qua UI =====
    await A.selectOption('#partnerSelect', { label: 'Partner Test' });
    await A.click('#connectPartnerBtn');
    const toastLoc = A.locator('.toast', { hasText: /kết nối/i });
    await toastLoc.waitFor({ state: 'visible', timeout: 5000 });
    const status = await toastLoc.innerText();
    assert(/kết nối/i.test(status), 'admin bấm Kết nối Partner → toast xác nhận', status);
    await A.waitForSelector('#threadTabs:visible .view-tab[data-thread="partner"]', { timeout: 4000 });
    const partnerTabTxt = await A.locator('#threadTabs .view-tab[data-thread="partner"]').innerText();
    assert(partnerTabTxt.includes('Partner Test'), 'gán partner → admin có tab chat riêng với partner', partnerTabTxt);
    const clipped = await headerOverflow(A);
    assert(clipped.length === 0, 'header admin không tràn nút ra ngoài khung', clipped.join(' | ') || 'không tràn');
    await A.waitForSelector('.toast', { state: 'detached', timeout: 6000 });
    await A.waitForTimeout(450);
    await A.screenshot({ path: SHOT('04-admin-da-gan-partner.png') });

    // ===== Admin xem nhật ký canh tác của khách =====
    await A.click('#processBtn');
    await A.waitForSelector('.process-overlay.open .process-entry', { timeout: 5000 });
    const adminProc = await A.locator('.process-entry-title').first().innerText();
    assert(adminProc.includes('Bón lót'), 'admin mở Nhật ký → thấy mục user vừa ghi', adminProc);

    // 🔍 lọc theo hoạt động không có mục → empty state riêng, nút xuất bị khóa
    await A.selectOption('#processFilterActivity', 'watering');
    await A.waitForSelector('.process-empty-filtered', { timeout: 3000 });
    const filterEmptyTxt = await A.locator('.process-empty-filtered h3').innerText();
    const filterNoteTxt = await A.locator('#processFilterNote').innerText();
    assert(filterEmptyTxt.includes('khớp bộ lọc'), '🔍 lọc hoạt động không có mục → empty state riêng', filterEmptyTxt);
    assert(filterNoteTxt.includes('0/1'), 'bộ lọc hiện số mục khớp/tổng', filterNoteTxt);
    assert(await A.locator('#processExportBtn').isDisabled(), '🔍 không có mục khớp → nút Xuất CSV bị khóa');

    // 🔍 lọc khoảng ngày loại mục cũ → vẫn giữ được dữ liệu gốc khi xóa lọc
    await A.click('#processFilterReset');
    await A.waitForSelector('.process-entry', { timeout: 3000 });
    await A.fill('#processFilterFrom', '2026-10-21');
    await A.waitForSelector('.process-empty-filtered', { timeout: 3000 });
    assert((await A.locator('#processFilterNote').innerText()).includes('0/1'),
      '🔍 lọc "Từ ngày" sau ngày ghi → loại đúng mục cũ');
    await A.click('#processFilterReset');
    await A.waitForSelector('.process-entry', { timeout: 3000 });
    ok('xóa lọc → timeline hiện lại đủ mục');

    // Xuất CSV theo bộ lọc
    const [download] = await Promise.all([
      A.waitForEvent('download', { timeout: 8000 }),
      A.click('#processExportBtn'),
    ]);
    const csv = fs.readFileSync(await download.path(), 'utf8');
    assert(download.suggestedFilename().endsWith('.csv')
      && csv.includes('Bón phân') && csv.includes('Bón lót vụ đông'),
      'xuất CSV nhật ký đúng tên file + dữ liệu', download.suggestedFilename());

    await A.waitForTimeout(450);
    await A.screenshot({ path: SHOT('04b-admin-nhat-ky.png') });
    await A.click('#processDrawerClose');
    await A.waitForSelector('.process-overlay', { state: 'hidden', timeout: 4000 });

    // ===== Partner: nhật ký + 2 luồng chat riêng =====
    const ctxP = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['microphone'],
    });
    const P = await login(ctxP, 'partner1', 'admin123', '/partner');
    ok('partner1 login → redirect /partner', P.url());
    await P.waitForSelector('.partner-item');
    const itemTxt = await P.locator('.partner-item').first().innerText();
    assert(itemTxt.includes('Khách hàng Test') && /nhật ký/i.test(itemTxt), 'partner thấy khách được gán kèm số nhật ký', itemTxt.replace(/\n/g, ' · '));

    await P.waitForSelector('.partner-item.active', { timeout: 5000 });
    const defaultTab = await P.locator('.view-tab.active').innerText();
    assert(defaultTab.includes('Nhật ký'), 'partner mặc định mở tab Nhật ký canh tác', defaultTab.trim());
    const partnerTabs = await P.locator('#viewTabs .view-tab').allInnerTexts();
    assert(partnerTabs.length === 3
      && partnerTabs.some((t) => t.includes('Nhắn khách hàng'))
      && partnerTabs.some((t) => t.includes('Nhắn admin')),
      'partner có 3 tab: nhật ký + chat riêng khách + chat riêng admin', partnerTabs.join(' | '));
    await P.waitForSelector('.process-entry', { timeout: 6000 });
    const partnerProc = await P.locator('.process-entry-title').first().innerText();
    assert(partnerProc.includes('Bón lót'), 'partner xem được nhật ký khách hàng vừa ghi', partnerProc);
    assert((await P.locator('.process-entry-media img').count()) >= 1, 'partner thấy ảnh đính kèm trong nhật ký');
    await P.screenshot({ path: SHOT('05-partner-nhat-ky.png') });

    // Partner → khách (riêng tư, không lẫn chat admin)
    await P.click('.view-tab[data-view="customer"]');
    await P.waitForSelector('#chatPane:visible', { timeout: 4000 });
    assert((await P.locator('#partnerMessages .message').count()) === 0,
      '🔍 thread partner↔khách bắt đầu trống (không lẫn lịch sử admin↔khách)', '0 tin');
    assert(await P.locator('#msgInput').isVisible(), 'partner có ô nhập tin nhắn riêng cho khách', 'msgInput visible');

    await P.fill('#msgInput', 'Nhắn riêng cho khách nhé');
    await P.click('#sendBtn');
    await P.waitForSelector('#partnerMessages .message.user', { timeout: 5000 });
    ok('partner gửi tin riêng cho khách → bubble của partner hiện bên phải');
    try {
      await P.waitForFunction(
        () => !document.querySelector('#partnerMessages .message.pending'),
        null, { timeout: 6000 }
      );
      ok('🔍 server echo thay bubble "đang gửi" bằng tin thật');
    } catch { bad('bubble pending của partner không được thay', 'vẫn còn .message.pending sau 6s'); }

    await P.waitForTimeout(700);
    const adminLeak = await A.locator('#messagesArea .message.role-partner').count();
    assert(adminLeak === 0, '🔍 admin KHÔNG thấy tin partner↔khách (cách ly thread)', `role-partner=${adminLeak}`);

    // Partner ghi âm trong luồng khách (dùng chung wireVoiceRecorder)
    assert(await P.locator('#voiceBtn').isVisible(), 'partner thấy nút ghi âm trong khung chat');
    await P.click('#voiceBtn');
    try {
      await P.waitForSelector('#voiceBtn.recording', { timeout: 5000 });
      await P.waitForTimeout(1000);
      await P.click('#voiceBtn');
      await P.waitForSelector('#partnerMessages .message.user:not(.pending) audio', { timeout: 15000 });
      ok('🎙️ partner ghi âm → tự gửi bubble audio trong luồng khách');
      const pAudio = await P.locator('#partnerMessages .message.user audio').last().getAttribute('src');
      assert(/^\/uploads\/.*\.(webm|ogg|m4a)$/.test(pAudio || ''), 'audio của partner trỏ tới file upload', pAudio || 'null');
    } catch (e) {
      bad('partner ghi âm', e.message.split('\n')[0]);
    }

    // Partner → admin (riêng tư) → badge amber, không lẫn vào chat khách
    await P.click('.view-tab[data-view="admin"]');
    await P.waitForSelector('#chatPane:visible', { timeout: 4000 });
    assert((await P.locator('#partnerMessages .message').count()) === 0, '🔍 thread partner↔admin bắt đầu trống', '0 tin');
    await P.fill('#msgInput', 'Báo cáo riêng cho admin');
    await P.click('#sendBtn');
    await P.waitForSelector('#partnerMessages .message.user', { timeout: 5000 });
    ok('partner gửi tin riêng cho admin');

    await A.waitForSelector('.user-unread.partner:visible', { timeout: 8000 });
    const partnerBadgeTxt = await A.locator('.user-unread.partner').first().innerText();
    assert(partnerBadgeTxt === '1', 'sidebar admin hiện badge partner riêng khi partner nhắn', `badge="${partnerBadgeTxt}"`);
    const partnerStat = await A.locator('#statPartnerUnread').innerText();
    assert(partnerStat === '1', 'thẻ "Tin partner chưa đọc" cập nhật realtime', `stat=${partnerStat}`);
    const adminPartnerLeak = await A.locator('#messagesArea .message.role-partner').count();
    assert(adminPartnerLeak === 0, '🔍 admin đang mở chat khách → tin partner không lẫn vào khung chat', `role-partner=${adminPartnerLeak}`);
    const titleUnreadA = await A.title();
    assert(titleUnreadA.includes('(1)'), '🔍 title tab admin hiện (1) khi có tin chưa đọc', titleUnreadA);
    await A.screenshot({ path: SHOT('05b-admin-badge-partner.png') });

    // Admin chuyển sang tab Partner: thấy tin, badge ẩn, trả lời
    await A.click('#threadTabs .view-tab[data-thread="partner"]');
    await A.waitForFunction(
      () => [...document.querySelectorAll('#messagesArea .message')].some((el) => el.textContent.includes('Báo cáo riêng cho admin')),
      null, { timeout: 6000 }
    ).then(
      () => ok('admin mở tab Partner → thấy tin riêng của partner'),
      () => bad('admin không thấy tin partner trong tab riêng', 'timeout 6s')
    );
    await A.waitForFunction(() => {
      const b = document.querySelector('.user-unread.partner');
      return !!b && b.hidden;
    }, null, { timeout: 5000 }).catch(() => {});
    assert(!(await A.locator('.user-unread.partner').first().isVisible().catch(() => false)),
      'admin mở tab Partner → badge partner bị ẩn (đã đọc)');
    const partnerStatAfterRead = await A.locator('#statPartnerUnread').innerText();
    assert(partnerStatAfterRead === '0', 'thẻ "Tin partner chưa đọc" về 0 sau khi mở tab', `stat=${partnerStatAfterRead}`);
    assert(!(await A.title()).includes('('), 'mở tab Partner → title admin hết số chưa đọc', await A.title());
    const clippedPartnerTab = await headerOverflow(A);
    assert(clippedPartnerTab.length === 0, 'header admin (tab Partner) không tràn nút ra ngoài khung', clippedPartnerTab.join(' | ') || 'không tràn');
    await A.waitForTimeout(400);
    await A.screenshot({ path: SHOT('05c-admin-partner-chat.png') });

    await A.fill('#msgInput', 'Phản hồi riêng cho partner');
    await A.click('#sendBtn');
    await A.waitForSelector('#messagesArea .message.user', { timeout: 5000 });
    await P.waitForFunction(
      () => [...document.querySelectorAll('#partnerMessages .message')].some((el) => el.textContent.includes('Phản hồi riêng cho partner')),
      null, { timeout: 6000 }
    ).then(
      () => ok('⚡ partner nhận tin riêng của admin realtime'),
      () => bad('partner không nhận tin admin trong tab riêng', 'timeout 6s')
    );
    await P.waitForTimeout(350);
    await P.screenshot({ path: SHOT('05d-partner-chat-admin.png') });

    // ===== User reload → tab chat riêng với partner =====
    await U.reload();
    await U.waitForSelector('#threadTabs:visible .view-tab[data-thread="partner"]', { timeout: 6000 });
    const userPartnerTab = await U.locator('#threadTabs .view-tab[data-thread="partner"]').innerText();
    assert(userPartnerTab.includes('Partner Test'), 'user reload → header có tab chat riêng với partner', userPartnerTab);
    await U.click('#threadTabs .view-tab[data-thread="partner"]');
    await U.waitForFunction(
      () => [...document.querySelectorAll('#messagesArea .message')].some((el) => el.textContent.includes('Nhắn riêng cho khách nhé')),
      null, { timeout: 6000 }
    ).then(
      () => ok('user thấy lịch sử chat riêng với partner (không lẫn chat admin)'),
      () => bad('user không thấy tin partner trong tab riêng', 'timeout 6s')
    );
    const userAdminLeak = await U.locator('#messagesArea .message').filter({ hasText: 'Báo cáo riêng cho admin' }).count();
    assert(userAdminLeak === 0, '🔍 user KHÔNG thấy tin partner↔admin', `leak=${userAdminLeak}`);
    await U.fill('#msgInput', 'Cảm ơn partner');
    await U.click('#sendBtn');
    await U.waitForSelector('#messagesArea .message.user', { timeout: 5000 });
    await U.waitForTimeout(400);
    await U.screenshot({ path: SHOT('09-user-partner-thread.png') });

    await P.waitForFunction(() => {
      const tab = document.querySelector('.view-tab[data-view="customer"]');
      return tab && tab.classList.contains('has-new');
    }, null, { timeout: 6000 }).then(
      () => ok('⚡ partner đang ở tab admin → tab khách hiện chấm tin mới'),
      () => bad('partner không thấy chấm tin mới ở tab khách', 'timeout 6s')
    );
    const titleUnreadP = await P.title();
    assert(titleUnreadP.includes('(1)'), '🔍 title tab partner hiện (1) khi khách nhắn thread khác', titleUnreadP);
    await P.click('.view-tab[data-view="customer"]');
    await P.waitForFunction(
      () => [...document.querySelectorAll('#partnerMessages .message')].some((el) => el.textContent.includes('Cảm ơn partner')),
      null, { timeout: 6000 }
    ).then(
      () => ok('partner mở tab khách → thấy tin mới của khách'),
      () => bad('partner không thấy tin khách trong tab riêng', 'timeout 6s')
    );
    assert(!(await P.locator('.view-tab[data-view="customer"]').evaluate((el) => el.classList.contains('has-new'))),
      'mở tab khách → chấm tin mới được xóa');
    assert(!(await P.title()).includes('('), 'mở tab khách → title partner hết số chưa đọc', await P.title());
    await P.waitForTimeout(400);
    await P.screenshot({ path: SHOT('06-partner-chat-khach.png') });

    const adminLeakUserPartner = await A.locator('#messagesArea .message').filter({ hasText: 'Cảm ơn partner' }).count();
    assert(adminLeakUserPartner === 0, '🔍 admin KHÔNG thấy tin khách↔partner', `leak=${adminLeakUserPartner}`);

    // ===== Dashboard thống kê admin =====
    await A.click('#statsBtn');
    await A.waitForSelector('#statsOverlay', { state: 'visible', timeout: 4000 });
    await A.waitForFunction(() => document.getElementById('kpiCustomers').textContent === '1', null, { timeout: 6000 });
    const kpis = await A.evaluate(() => ({
      customers: document.getElementById('kpiCustomers').textContent,
      messages: Number(document.getElementById('kpiMessages').textContent),
      process: document.getElementById('kpiProcess').textContent,
      partners: document.getElementById('kpiPartners').textContent,
      bars: document.querySelectorAll('#barChart .bar-col').length,
      legend: document.querySelectorAll('#donutLegend li').length,
      top: document.getElementById('topCustomers').textContent,
    }));
    assert(kpis.customers === '1' && kpis.messages >= 9 && kpis.process === '1' && kpis.partners === '1',
      'dashboard KPI đúng số liệu (khách=1, tin≥9, nhật ký=1, partner=1)', JSON.stringify(kpis));
    assert(kpis.bars === 7, 'biểu đồ cột có đúng 7 ngày', `bars=${kpis.bars}`);
    assert(kpis.legend >= 1 && kpis.top.includes('Khách hàng Test'),
      'biểu đồ tròn hoạt động + top khách hàng hiển thị', `legend=${kpis.legend}, top="${kpis.top}"`);
    await A.screenshot({ path: SHOT('10-admin-dashboard.png') });
    await A.click('#statsCloseBtn');
    await A.waitForSelector('#statsOverlay', { state: 'hidden', timeout: 4000 });
    ok('đóng dashboard bằng nút ×');

    // 🔍 probe: partner cố vào /admin → pageGuard đá về login
    await P.goto(BASE + '/admin');
    assert(new URL(P.url()).pathname === '/', '🔍 partner gọi thẳng /admin → redirect /', P.url());

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
    const ownBadgeVisible = await A.locator('.user-unread:not(.partner)').first().isVisible().catch(() => false);
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
