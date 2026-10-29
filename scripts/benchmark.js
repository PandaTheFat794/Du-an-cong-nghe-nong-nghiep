// Benchmark hiệu năng: API latency (p50/p95/p99) + page metrics (Core Web Vitals, page weight).
// Chạy:
//   npm run benchmark           → đo, lưu .ecc/benchmarks/latest.json
//   npm run benchmark:baseline  → đo, lưu .ecc/benchmarks/baseline.json
//   npm run benchmark:compare   → đo, so sánh với baseline.json
// Env: BENCH_REQUESTS (100), BENCH_CONCURRENCY (10), BENCH_PAGE_RUNS (3),
//      BENCH_PORT (3200), BENCH_SKIP_BROWSER=1, BENCH_FAIL_ON_REGRESSION=1, UI_BROWSER=<chrome/msedge>.
// Server tách biệt hoàn toàn: port riêng + DB data/benchmark.db (xoá trước mỗi lần chạy).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.BENCH_PORT || 3200);
const BASE = `http://localhost:${PORT}`;
const DB_PATH = path.join(ROOT, 'data', 'benchmark.db');
const OUT_DIR = path.join(ROOT, '.ecc', 'benchmarks');
const BASELINE_PATH = path.join(OUT_DIR, 'baseline.json');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');

const REQUESTS = Number(process.env.BENCH_REQUESTS || 100);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY || 10);
const PAGE_RUNS = Number(process.env.BENCH_PAGE_RUNS || 3);
const SKIP_BROWSER = process.env.BENCH_SKIP_BROWSER === '1';
const MODE = ['baseline', 'compare'].includes((process.argv[2] || '').toLowerCase())
  ? process.argv[2].toLowerCase()
  : 'run';

const BROWSER_CANDIDATES = [
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

const MSG_TEXTS = [
  'Cây lúa đang bị vàng lá, tôi nên xử lý thế nào?',
  'Anh kiểm tra lại lượng đạm và độ pH đất giúp tôi với.',
  'Tuần này tôi tưới nước 2 lần, mỗi lần khoảng 30 phút.',
  'Đã phun thuốc trị rầy nâu theo hướng dẫn, theo dõi thêm 3 ngày.',
  'Chi phí phân bón vụ này tăng khoảng 15% so với năm ngoái.',
  'Tôi muốn ghi nhật ký bón phân hữu cơ cho ruộng lúa.',
  'Thời tiết mưa nhiều nên tôi giảm lượng nước tưới mỗi ngày.',
  'Cảm ơn tư vấn, ruộng đã đỡ vàng lá sau khi bón kali.',
];

const ACTIVITY_LABELS = {
  sowing: 'Gieo sạ',
  fertilizing: 'Bón phân',
  watering: 'Tưới nước',
  pesticide: 'Phun thuốc',
  pruning: 'Tỉa cành',
  harvest: 'Thu hoạch',
};
const ACTIVITIES = Object.keys(ACTIVITY_LABELS);

// ---------- tiện ích ----------
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${Math.round(n)}B`;
}

function fmtValue(v, unit) {
  if (unit === 'ms') return `${v.toFixed(1)}ms`;
  if (unit === 'B') return fmtBytes(v);
  if (unit === 'req') return String(Math.round(v));
  if (unit === 'req/s') return v.toFixed(0);
  if (unit === 'score') return v.toFixed(3);
  return String(v);
}

function shorten(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ---------- HTTP helper ----------
async function request(pathname, { method = 'GET', cookie, body, csrf } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf) headers['x-csrf-token'] = csrf;
  const resp = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString('utf8')); } catch { /* binary/HTML */ }
  const setCookie = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  const sid = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
  return { status: resp.status, data, buf, cookie: sid || cookie };
}

async function login(username, password) {
  const res = await request('/api/login', { method: 'POST', body: { username, password } });
  if (res.status !== 200 || !res.data || !res.data.success || !res.cookie) {
    throw new Error(`Đăng nhập ${username} thất bại (${res.status}): ${res.buf.toString().slice(0, 200)}`);
  }
  return { cookie: res.cookie, user: res.data.user, sessionId: res.data.sessionId };
}

async function getCsrfToken(cookie) {
  const res = await request('/api/csrf', { cookie });
  if (res.status !== 200 || !res.data || !res.data.csrfToken) {
    throw new Error(`Không lấy được CSRF token (${res.status})`);
  }
  return res.data.csrfToken;
}

// ---------- server lifecycle ----------
function removeDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function startServer() {
  removeDbFiles();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      SESSION_SECRET: 'benchmark-secret',
      LLM_PROVIDER: 'off',
      LLM_FALLBACK_PROVIDER: 'off',
      LLM_FALLBACK2_PROVIDER: 'off',
      OFFICE_HOURS: '0-24',
      UPLOAD_CLEANUP_INTERVAL_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.on('error', (err) => { child.output += `spawn error: ${err.message}\n`; });
  return child;
}

async function waitForServer(child, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Server thoát (code ${child.exitCode}):\n${child.output.slice(-1500)}`);
    }
    try {
      await fetch(BASE + '/api/me');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server không trả lời trong ${timeoutMs}ms (${BASE}):\n${child.output.slice(-1500)}`);
}

async function stopServer(server) {
  if (!server) return;
  server.kill();
  await Promise.race([
    new Promise((r) => server.once('exit', r)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  try { removeDbFiles(); } catch { /* file đang bị khoá — bỏ qua */ }
}

// ---------- dataset xác định ----------
function seedDataset({ userId, adminId, partnerId, conv }) {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  const insertMessage = db.prepare(
    "INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, datetime('now', ?))"
  );
  const insertEntry = db.prepare(
    `INSERT INTO process_entries
       (user_id, activity, performed_at, title, method, details,
        area_ha, yield_per_ha, output_tons, quality_rating, quality_note, quality_rated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const today = new Date();
  const tx = db.transaction(() => {
    for (let i = 0; i < 300; i++) {
      insertMessage.run(conv.userAdmin, i % 2 === 0 ? userId : adminId, MSG_TEXTS[i % MSG_TEXTS.length], `-${(300 - i) * 31} minutes`);
    }
    for (let i = 0; i < 120; i++) {
      insertMessage.run(conv.partnerUser, i % 2 === 0 ? userId : partnerId, MSG_TEXTS[(i + 3) % MSG_TEXTS.length], `-${(120 - i) * 78} minutes`);
    }
    for (let i = 0; i < 120; i++) {
      insertMessage.run(conv.partnerAdmin, i % 2 === 0 ? partnerId : adminId, MSG_TEXTS[(i + 5) % MSG_TEXTS.length], `-${(120 - i) * 79} minutes`);
    }
    for (let i = 0; i < 30; i++) {
      const activity = ACTIVITIES[i % ACTIVITIES.length];
      const date = new Date(today);
      date.setDate(date.getDate() - (i % 6));
      const performedAt = date.toISOString().slice(0, 10);
      const isHarvest = activity === 'harvest';
      const area = isHarvest ? Math.round((1 + (i % 5) * 0.5) * 100) / 100 : null;
      const yieldPerHa = isHarvest ? Math.round((5.2 + (i % 4) * 0.3) * 100) / 100 : null;
      const output = isHarvest ? Math.round(area * yieldPerHa * 100) / 100 : null;
      const rating = i % 3 === 0 ? (i % 5) + 1 : null;
      insertEntry.run(
        userId,
        activity,
        performedAt,
        `${ACTIVITY_LABELS[activity]} đợt ${i + 1}`,
        'Thực hiện theo quy trình, kiểm tra độ ẩm đất trước khi tiến hành.',
        'Theo dõi ruộng lúa 1.5 ha, ghi nhận thời tiết và sâu bệnh trong ngày.',
        area,
        yieldPerHa,
        output,
        rating,
        rating ? `Đánh giá mẫu cho bản ghi ${i + 1}` : null,
        rating ? new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ') : null
      );
    }
  });
  tx();
  db.close();
  return { messages: 540, processEntries: 30 };
}

async function prepareWorkload() {
  const admin = await login('admin', 'admin123');
  const user = await login('user1', 'user123');
  const partner = await login('partner1', 'admin123');

  const usersRes = await request('/api/admin/users', { cookie: admin.cookie });
  if (usersRes.status !== 200 || !usersRes.data || !usersRes.data.users) {
    throw new Error(`GET /api/admin/users thất bại (${usersRes.status})`);
  }
  const customer = usersRes.data.users.find((u) => u.username === 'user1');
  if (!customer || !customer.conversation_id) throw new Error('Không tìm thấy user1/conversation seed');

  const partnersRes = await request('/api/admin/partners', { cookie: admin.cookie });
  const partnerAccount = (partnersRes.data.partners || []).find((p) => p.username === 'partner1');
  if (!partnerAccount) throw new Error('Không tìm thấy partner1 seed');

  let conv;
  if (customer.partner_id) {
    const partnerConvs = await request('/api/partner/conversations', { cookie: partner.cookie });
    const row = (partnerConvs.data.conversations || []).find((c) => c.user_id === customer.id);
    if (!row) throw new Error('Partner đã được gán nhưng không có thread partner');
    conv = { userAdmin: customer.conversation_id, partnerUser: row.user_conversation_id, partnerAdmin: row.admin_conversation_id };
  } else {
    const csrf = await getCsrfToken(admin.cookie);
    const connect = await request(`/api/admin/conversations/${customer.conversation_id}/connect`, {
      method: 'POST',
      cookie: admin.cookie,
      csrf,
      body: { partner_id: partnerAccount.id },
    });
    if (connect.status !== 200 || !connect.data || !connect.data.success) {
      throw new Error(`Gán partner thất bại (${connect.status}): ${connect.buf.toString().slice(0, 200)}`);
    }
    conv = {
      userAdmin: customer.conversation_id,
      partnerUser: connect.data.partnerUserConversationId,
      partnerAdmin: connect.data.partnerConversationId,
    };
  }

  const dataset = seedDataset({
    userId: user.user.id,
    adminId: admin.user.id,
    partnerId: partnerAccount.id,
    conv,
  });

  return { admin, user, partner, conv, dataset };
}

// ---------- API benchmark ----------
function buildApiTargets({ admin, user, partner, conv }) {
  return [
    { name: 'GET /api/me (user)', path: '/api/me', cookie: user.cookie },
    { name: 'GET /api/me (admin)', path: '/api/me', cookie: admin.cookie },
    { name: 'GET messages user↔admin (admin)', path: `/api/conversations/${conv.userAdmin}/messages?limit=50`, cookie: admin.cookie },
    { name: 'GET messages user↔partner (user)', path: `/api/conversations/${conv.partnerUser}/messages?limit=50`, cookie: user.cookie },
    { name: 'GET messages partner↔admin (partner)', path: `/api/conversations/${conv.partnerAdmin}/messages?limit=50`, cookie: partner.cookie },
    { name: 'GET search user↔admin', path: `/api/conversations/${conv.userAdmin}/search?q=${encodeURIComponent('tưới')}`, cookie: admin.cookie },
    { name: 'GET /api/admin/users', path: '/api/admin/users', cookie: admin.cookie },
    { name: 'GET /api/admin/partners', path: '/api/admin/partners', cookie: admin.cookie },
    { name: 'GET /api/admin/stats?days=7', path: '/api/admin/stats?days=7', cookie: admin.cookie },
    { name: 'GET /api/partner/conversations', path: '/api/partner/conversations', cookie: partner.cookie },
    { name: 'GET /api/process (admin)', path: `/api/process?userId=${user.user.id}`, cookie: admin.cookie },
  ];
}

async function measureApiTarget(target) {
  for (let i = 0; i < 3; i++) {
    const warm = await request(target.path, { cookie: target.cookie });
    if (warm.status !== 200) {
      throw new Error(`${target.name} trả ${warm.status}: ${warm.buf.toString().slice(0, 200)}`);
    }
  }

  const latencies = new Float64Array(REQUESTS);
  const sizes = new Float64Array(REQUESTS);
  let failures = 0;
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const i = next++;
        if (i >= REQUESTS) return;
        const t0 = performance.now();
        try {
          const res = await request(target.path, { cookie: target.cookie });
          latencies[i] = performance.now() - t0;
          sizes[i] = res.buf.length;
          if (res.status !== 200) failures++;
        } catch {
          latencies[i] = performance.now() - t0;
          failures++;
        }
      }
    })
  );
  const wall = performance.now() - started;
  if (failures > 0) throw new Error(`${target.name}: ${failures}/${REQUESTS} request lỗi`);

  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    name: target.name,
    method: 'GET',
    path: target.path,
    requests: REQUESTS,
    concurrency: CONCURRENCY,
    failures,
    p50: round2(percentile(sorted, 50)),
    p95: round2(percentile(sorted, 95)),
    p99: round2(percentile(sorted, 99)),
    mean: round2(sum / REQUESTS),
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
    rps: round1(REQUESTS / (wall / 1000)),
    bytes: Math.round(median(Array.from(sizes))),
  };
}

// ---------- page benchmark ----------
function pageInitMetrics() {
  window.__bench = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__bench.lcp = Math.max(window.__bench.lcp, e.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__bench.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* browser cũ không hỗ trợ */ }
}

function pageCollectMetrics() {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = performance.getEntriesByType('paint');
  const fcpEntry = paints.find((p) => p.name === 'first-contentful-paint');
  let transfer = 0;
  let js = 0;
  let css = 0;
  let img = 0;
  const resources = performance.getEntriesByType('resource');
  for (const r of resources) {
    const size = r.transferSize || r.encodedBodySize || 0;
    transfer += size;
    const clean = r.name.split('?')[0];
    if (/\.js$/i.test(clean)) js += size;
    else if (/\.css$/i.test(clean)) css += size;
    else if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(clean)) img += size;
  }
  const bench = window.__bench || { lcp: 0, cls: 0 };
  return {
    ttfb: nav.responseStart || 0,
    fcp: fcpEntry ? fcpEntry.startTime : 0,
    lcp: bench.lcp || 0,
    cls: bench.cls || 0,
    load: nav.loadEventEnd || 0,
    requests: resources.length,
    transferBytes: transfer,
    jsBytes: js,
    cssBytes: css,
    imgBytes: img,
  };
}

function cookieValue(cookieHeader) {
  if (!cookieHeader) return null;
  const first = cookieHeader.split(';')[0].trim();
  const eq = first.indexOf('=');
  return eq >= 0 ? first.slice(eq + 1) : null;
}

function buildPageTargets({ user, admin, partner }) {
  return [
    { name: 'Đăng nhập', path: '/', cookie: null },
    { name: 'Khách hàng', path: '/chat', cookie: user.cookie },
    { name: 'Admin', path: '/admin', cookie: admin.cookie },
    { name: 'Partner', path: '/partner', cookie: partner.cookie },
  ];
}

async function measurePageTarget(browser, target) {
  const runs = [];
  for (let i = 0; i < PAGE_RUNS; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const value = cookieValue(target.cookie);
      if (value) {
        await context.addCookies([{ name: 'connect.sid', value, url: BASE }]);
      }
      const page = await context.newPage();
      await page.addInitScript(pageInitMetrics);
      const resp = await page.goto(BASE + target.path, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1200);
      const finalPath = new URL(page.url()).pathname;
      if (finalPath !== target.path) {
        throw new Error(`${target.path} bị chuyển hướng tới ${finalPath} — kiểm tra phiên đăng nhập`);
      }
      const status = resp ? resp.status() : 0;
      if (status !== 200) throw new Error(`${target.path} trả ${status}`);
      runs.push(await page.evaluate(pageCollectMetrics));
    } finally {
      await context.close();
    }
  }
  const pick = (key) => median(runs.map((r) => r[key]));
  return {
    name: target.name,
    path: target.path,
    status: 200,
    ttfb: round1(pick('ttfb')),
    fcp: round1(pick('fcp')),
    lcp: round1(pick('lcp')),
    cls: round3(pick('cls')),
    load: round1(pick('load')),
    requests: Math.round(pick('requests')),
    transferBytes: Math.round(pick('transferBytes')),
    jsBytes: Math.round(pick('jsBytes')),
    cssBytes: Math.round(pick('cssBytes')),
    imgBytes: Math.round(pick('imgBytes')),
  };
}

let browserLabel = 'không có';

async function launchBrowser() {
  if (SKIP_BROWSER) return null;
  const exec = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exec) {
    console.warn('⚠ Không tìm thấy Chrome/Edge — bỏ qua page metrics (đặt UI_BROWSER=... hoặc BENCH_SKIP_BROWSER=1).');
    return null;
  }
  browserLabel = path.basename(exec);
  return chromium.launch({ executablePath: exec, headless: true });
}

// ---------- so sánh baseline ----------
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function verdict(before, after, { abs = 0, warnPct = 20, betterPct = 10, higherIsBetter = false } = {}) {
  const delta = after - before;
  if (Math.abs(delta) <= abs) return 'OK';
  let pct;
  if (before === 0) pct = after === 0 ? 0 : 100;
  else pct = (delta / Math.abs(before)) * 100;
  if (higherIsBetter) pct = -pct;
  if (pct <= -betterPct) return 'BETTER';
  if (pct >= warnPct) return 'WARN';
  return 'OK';
}

function fmtDelta(before, after) {
  if (before === 0) return after === 0 ? '0%' : '+∞';
  const pct = ((after - before) / Math.abs(before)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function buildComparison(previous, current) {
  const rows = [];
  // Windows preempt thread ~15.6ms nên p95/p99/rps dao động mạnh giữa các lần chạy;
  // p50 là chỉ số ổn định nhất để bắt regression thật.
  const apiDefs = [
    ['p50', 'ms', { abs: 0.5, warnPct: 20, betterPct: 10 }],
    ['p95', 'ms', { abs: 20, warnPct: 30, betterPct: 15 }],
    ['p99', 'ms', { abs: 25, warnPct: 30, betterPct: 15 }],
    ['rps', 'req/s', { abs: 100, warnPct: 40, betterPct: 20, higherIsBetter: true }],
    ['bytes', 'B', { abs: 1024, warnPct: 10 }],
  ];
  const prevApi = new Map((previous.api || []).map((a) => [a.name, a]));
  for (const cur of current.api) {
    const prev = prevApi.get(cur.name);
    if (!prev) continue;
    for (const [key, unit, opts] of apiDefs) {
      rows.push({
        metric: `${cur.name} · ${key}`,
        before: prev[key],
        after: cur[key],
        unit,
        opts,
      });
    }
  }

  const pageDefs = [
    ['ttfb', 'ms', { abs: 5 }],
    ['fcp', 'ms', { abs: 15 }],
    ['lcp', 'ms', { abs: 15 }],
    ['cls', 'score', { abs: 0.01 }],
    ['load', 'ms', { abs: 20 }],
    ['requests', 'req', { abs: 0 }],
    ['transferBytes', 'B', { abs: 2048, warnPct: 10 }],
    ['jsBytes', 'B', { abs: 1024, warnPct: 10 }],
    ['cssBytes', 'B', { abs: 512, warnPct: 10 }],
  ];
  const prevPages = new Map((previous.pages || []).map((p) => [p.path, p]));
  for (const cur of current.pages) {
    const prev = prevPages.get(cur.path);
    if (!prev) continue;
    for (const [key, unit, opts] of pageDefs) {
      rows.push({
        metric: `${cur.path} · ${key}`,
        before: prev[key],
        after: cur[key],
        unit,
        opts,
      });
    }
  }
  return rows.map((row) => ({
    ...row,
    verdict: verdict(row.before, row.after, row.opts),
    delta: fmtDelta(row.before, row.after),
  }));
}

function printComparison(previous, rows) {
  console.log(`\n== So sánh với baseline (${previous.createdAt || 'không rõ thời gian'}) ==`);
  console.log('(p95/p99/rps có thể nhiễu ~16ms do scheduler Windows — ưu tiên p50 khi đánh giá)');
  const header = `${'Metric'.padEnd(48)}${'Before'.padStart(11)}${'After'.padStart(11)}${'Delta'.padStart(10)}  Verdict`;
  console.log(header);
  console.log('-'.repeat(header.length));
  const counts = { BETTER: 0, OK: 0, WARN: 0 };
  for (const row of rows) {
    counts[row.verdict]++;
    console.log(
      `${shorten(row.metric, 47).padEnd(48)}${fmtValue(row.before, row.unit).padStart(11)}${fmtValue(row.after, row.unit).padStart(11)}${row.delta.padStart(10)}  ${row.verdict}`
    );
  }
  console.log('-'.repeat(header.length));
  console.log(`${counts.BETTER} BETTER · ${counts.OK} OK · ${counts.WARN} WARN`);
  if (counts.WARN === 0) console.log('✓ Không có hồi quy đáng kể.');
  return counts;
}

function printApi(api) {
  console.log(`\n== API: ${REQUESTS} request/endpoint, concurrency ${CONCURRENCY} ==`);
  const header = `${'Endpoint'.padEnd(46)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'RPS'.padStart(8)}${'Size'.padStart(10)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of api) {
    console.log(
      `${shorten(row.name, 45).padEnd(46)}${`${row.p50.toFixed(1)}ms`.padStart(9)}${`${row.p95.toFixed(1)}ms`.padStart(9)}${`${row.p99.toFixed(1)}ms`.padStart(9)}${row.rps.toFixed(0).padStart(8)}${fmtBytes(row.bytes).padStart(10)}`
    );
  }
}

function printPages(pages, browserName) {
  if (pages.length === 0) {
    console.log('\n== Pages: bỏ qua (không có trình duyệt) ==');
    return;
  }
  console.log(`\n== Pages: median của ${PAGE_RUNS} lần load (${browserName}, headless 1280×800) ==`);
  const header = `${'Trang'.padEnd(16)}${'TTFB'.padStart(9)}${'FCP'.padStart(9)}${'LCP'.padStart(9)}${'CLS'.padStart(8)}${'Req'.padStart(6)}${'Transfer'.padStart(11)}${'JS'.padStart(10)}${'CSS'.padStart(9)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of pages) {
    console.log(
      `${row.name.padEnd(16)}${`${row.ttfb.toFixed(0)}ms`.padStart(9)}${`${row.fcp.toFixed(0)}ms`.padStart(9)}${`${row.lcp.toFixed(0)}ms`.padStart(9)}${row.cls.toFixed(3).padStart(8)}${String(row.requests).padStart(6)}${fmtBytes(row.transferBytes).padStart(11)}${fmtBytes(row.jsBytes).padStart(10)}${fmtBytes(row.cssBytes).padStart(9)}`
    );
  }
  console.log('(INP không đo — benchmark không mô phỏng tương tác người dùng)');
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const compareTarget = MODE === 'compare'
    ? readJson(BASELINE_PATH) || readJson(LATEST_PATH)
    : null;

  let server = null;
  let browser = null;
  try {
    console.log(`▶ Benchmark (mode: ${MODE}) tại ${BASE}`);
    server = startServer();
    await waitForServer(server);
    const { admin, user, partner, conv, dataset } = await prepareWorkload();
    console.log(`  dataset: ${dataset.messages} tin nhắn, ${dataset.processEntries} nhật ký`);

    const apiTargets = buildApiTargets({ admin, user, partner, conv });
    const api = [];
    for (const target of apiTargets) {
      api.push(await measureApiTarget(target));
    }

    let pages = [];
    browser = await launchBrowser();
    if (browser) {
      const pageTargets = buildPageTargets({ user, admin, partner });
      for (const target of pageTargets) {
        pages.push(await measurePageTarget(browser, target));
      }
    }

    const result = {
      version: 1,
      mode: MODE,
      createdAt: new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      config: { requests: REQUESTS, concurrency: CONCURRENCY, pageRuns: PAGE_RUNS },
      dataset,
      api,
      pages,
    };

    printApi(api);
    printPages(pages, browserLabel);

    fs.writeFileSync(LATEST_PATH, JSON.stringify(result, null, 2) + '\n');
    console.log(`\nĐã lưu: ${path.relative(ROOT, LATEST_PATH)}`);

    if (MODE === 'baseline' || !fs.existsSync(BASELINE_PATH)) {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2) + '\n');
      console.log(`Đã lưu baseline: ${path.relative(ROOT, BASELINE_PATH)}`);
    }

    if (MODE === 'compare') {
      if (!compareTarget) {
        console.log('⚠ Chưa có baseline trước đó — lần chạy này được lưu làm baseline.');
      } else {
        const rows = buildComparison(compareTarget, result);
        const counts = printComparison(compareTarget, rows);
        if (process.env.BENCH_FAIL_ON_REGRESSION === '1' && counts.WARN > 0) {
          process.exitCode = 1;
        }
      }
    }
  } catch (err) {
    console.error(`\n❌ Benchmark lỗi: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }
})();
