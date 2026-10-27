# Project Context: Web Tu van Nong nghiep (User - Admin - Partner)

## 1. Tong quan du an
He thong web tu van truc tuyen (mo phong giao dien kieu Zalo chat):
- **User (Khach hang)**: Dang ky, dang nhap, chat rieng voi Admin va chat rieng voi Partner (neu duoc gan), gui kem anh/tai lieu. Tu ghi **nhat ky canh tac** (hoat dong, ngay, phuong phap, chi tiet, anh) va xem timeline cua minh.
- **Admin**: Sidebar quan ly danh sach user can tu van (kem badge unread + badge partner + so muc nhat ky), khung chat truc tiep voi khach, tab chat rieng voi partner, gan "Ben thu 3" (Partner) cho user, xem nhat ky canh tac cua khach.
- **Partner (Ben thu 3)**: Dang nhap, xem danh sach khach hang duoc admin gan, xem **nhat ky canh tac**, va nhan tin rieng voi khach + rieng voi admin. Khong thay duoc chat admin↔khach; khong tao/xoa duoc nhat ky.

## 2. Tech Stack
- **Backend**: Node.js + Express + Socket.io (WebSocket chat real-time, path: /ws; client bundle nam tai `/ws/socket.io.js`).
- **Database**: SQLite qua better-sqlite3 (file `data/app.db`, module db.js) gom 5 bang: users, conversations, messages, process_entries, sessions.
  - `journal_mode=WAL` + `busy_timeout=5000`; index `idx_messages_conversation_id ON messages(conversation_id, id)` va `idx_process_entries_user ON process_entries(user_id, performed_at DESC, id DESC)`.
- **Auth**: express-session + **SQLite session store tu viet** (`session-store.js`, song sot qua restart). Socket handshake xac thuc bang `?sessionId=` (tra ve tu /api/login) qua cung store. Login cap session id moi (`req.session.regenerate` + `save`) chong session fixation.
- **Upload**: multer → `public/uploads/`, toi da 5MB, whitelist phan mo rong (jpg/png/gif/webp/pdf/doc/docx/webm/ogg/mp3/wav/m4a) + **kiem tra magic bytes** chan file gia mao dinh dang. Tin nhan thoai ghi truc tiep bang MediaRecorder roi upload qua cung endpoint.
- **Rate limit** (`rate-limit.js`, cua so truot trong bo nho): socket message 8 tin/10s/user; login 20/5 phut/IP; register 10/10 phut/IP; upload 30/10 phut/user.
- **Env**: `dotenv` doc `.env` (mau tai `.env.example`); bien trong shell duoc uu tien.
- **Frontend**: HTML5, CSS3, Vanilla JavaScript thuan (khong dung build tools/bundler).

## 3. Cau truc thu muc
- server.js: Entry point (session, socket events, page guards /chat /admin /partner theo role). Security headers co ban (nosniff / SAMEORIGIN / referrer-policy). Handler `message`: cap do dai 4000 ky tu; attachment URL phai bat dau `/uploads/`, khong chua `..` va file phai ton tai trong `public/uploads/` (neu khong → strip, chan tracking pixel + path traversal).
- db.js: Schema SQLite + migration + helpers:
  - `conversations.kind`: `user_admin` (khach↔admin, 1/user), `partner_user` (khach↔partner), `partner_admin` (partner↔admin, theo cap khach/partner). Partial unique index thay cho UNIQUE(user_id) cu (migration rebuild bang).
  - `getMessagesPage(convId, beforeId, limit)` → `{ messages, has_more }` (trang moi nhat truoc, sap cu → moi).
  - `getOrCreatePartnerThread` / `ensurePartnerThreads(userId, partnerId)`: tao/lay 2 thread rieng cua partner.
  - `canAccessConversation(user, conversation)`: admin → user_admin + partner_admin (khong vao partner_user); user → user_admin/partner_user cua minh (khong vao partner_admin); partner → 2 thread partner cua khach dang duoc gan (kiem tra lai user_admin.partner_id), khong vao user_admin.
  - `markAsRead` / `countUnread` / `countPartnerUnread`: watermark `conversations.admin_last_read_id`; badge do chi dem tin khach trong user_admin; badge vang (amber) chi dem tin partner trong partner_admin.
  - Nhat ky: `getProcessEntries(userId)` (toi da 200, moi nhat truoc), `getProcessEntry`, `insertProcessEntry`, `deleteProcessEntry`, `getUserById`.
- session-store.js: Store express-session tren SQLite + getSessionUser() cho socket.
- auth.js: Middleware requireAuth/requireRole + login (regenerate session)/logout.
- rate-limit.js: `createRateLimiter({ windowMs, max, message, keyFn })` → middleware 429.
- routes/:
  - auth.js: /api/register (validate username 3-32 `[a-zA-Z0-9_.-]`, password 6-72, display_name 1-60; rate-limit), /api/login (rate-limit), /api/logout, /api/me (role user: `conversation_id` + `partner: {id, display_name, conversation_id}` cua thread partner_user), POST /api/me/password (doi mat khau), DELETE /api/me (user tu xoa tai khoan, cascade xoa lich su).
  - chat.js: GET /api/conversations/:id/messages?before=&limit= (mac dinh 50, toi da 100; qua `canAccessConversation`).
  - admin.js: GET /api/admin/users (1 query duy nhat: preview + unread do + `partner_id`, `partner_name`, `partner_conversation_id`, `partner_unread`), GET /api/admin/partners, POST /api/admin/conversations/:id/connect (tra `conversationId`, `partnerId`, `partnerConversationId`, `partnerUserConversationId`), DELETE /api/admin/users/:id (admin xoa khach), GET /api/admin/stats (dashboard: totals customers/partners/messages/processEntries + `messagesByDay` 7 ngay gan nhat + `processByActivity` + `topCustomers` top 5 theo so tin).
  - partner.js: GET /api/partner/conversations (kem `process_count`, `message_count`, `user_conversation_id`, `admin_conversation_id`).
  - process.js: GET /api/process?userId= (admin/owner/partner dang duoc gan), POST /api/process (chi role user, validate activity/ngay that/title/method/details/attachment path), DELETE /api/process/:id (owner hoac admin). Moi thay doi phat socket `process-updated` toi room `admins` + `conv_<id>` cua user_admin + `conv_<id>` cua thread partner_user cua partner dang gan.
  - upload.js: POST /api/upload (multipart field "file", rate-limit theo user).
- public/:
  - index.html: Form dang nhap / dang ky + 3 nut "Vao nhanh" tai khoan seed (user1/admin/partner1), tu dong redirect theo role.
  - chat.html: Giao dien chat cua User: tab "Chuyen gia" (admin) + tab partner (khi duoc gan), gui tin + dinh kem, nut micro ghi am, nut Tai tin cu hon, nut "Nhat ky" mo drawer.
  - admin.html: Sidebar khach hang (4 the tong quan khach/tin khach chua doc/tin partner chua doc/muc nhat ky, o tim kiem theo ten hoac username, badge unread do + badge partner amber + so muc nhat ky) + khung chat voi 2 tab "Khach hang"/"Partner: <ten>" + chon/gan Partner + nut micro ghi am + nut "Nhat ky" xem drawer cua khach dang chon + nut **"Thong ke"** mo modal `#statsOverlay` (4 KPI, bieu do cot 7 ngay, donut conic-gradient theo hoat dong, top 5 khach nhan nhieu nhat; dong bang ×/backdrop/Esc).
  - partner.html: Sidebar khach duoc gan + workbench 3 tab: "Nhat ky canh tac" (timeline), "Nhan khach hang", "Nhan admin" (2 thread rieng, gui duoc, co nut micro ghi am).
  - favicon.svg: icon la cay (tranh 404 /favicon.ico vi da co <link rel="icon"> trong 4 trang).
  - css/style.css: Design system "nong nghiep" (bien CSS, gradient, keyframe animation, glass login card, avatar mau theo role, toast, typing indicator, `.load-more`, ambient background, timeline/drawer nhat ky, `.view-tabs`, `.view-tab.has-new` cham tin moi, `.voice-btn.recording` mic do nhap nhay, `.message-audio` player trong bubble, `.admin-overview/.admin-stat/.admin-search` tong quan + tim kiem, `.process-filters` loc/xuat CSV, `.lightbox` xem anh to (backdrop blur + close × + zoom), `.stats-overlay/.stats-modal/.stats-kpis/.bar-chart/.donut/.top-customers` modal thong ke, responsive + prefers-reduced-motion). **Luon khai bao `[hidden]{display:none}` cho moi class co set display** (da fix bug .user-unread, #loginForm/#registerForm, .view-tab, .process-overlay, .process-pane/.chat-pane; co them quy tac global `[hidden]{display:none!important}` cuoi file). `.chat-controls` co `flex:1 1 auto; min-width:0` de header wrap thay vi tran nut; `.chat-header` z-index 10 de panel Tai khoan khong bi bubble de len; toast trang partner ha xuong duoi topbar.
  - js/common.js: api(), uploadFile(), messageEl() (render textContent, chong XSS, them class `role-<senderRole>`, anh `<img>` bam mo **lightbox**, am thanh `<audio controls>`), parse thoi gian UTC tu SQLite, toast(), avatarEl(), createTypingSender/createTypingView, wireConnectionIndicator, wireAttachButton, **wireVoiceRecorder({ buttonId, chipId, canStart, getConvId, onRecorded })** (MediaRecorder: ghi toi da 60s, toi thieu 0.6s, tu upload + gui, khoa o nhap khi ghi, `cancel()` khi doi thread), **createHistoryPager(area, button, render)** (nut Tai tin cu hon, giu scroll, bo qua response cua conv da doi), **openLightbox/closeLightbox(src, alt)** (xem anh to, dong bang ×/backdrop/Esc, chong race dong-mo lai <200ms), **playPing()** (2 not sine 880+1174Hz bang Web Audio, throttle 1.2s, khong can asset), **unreadTitle** ({ bump(key), clear(key), setAll(total) }) dem tin chua doc tren title tab `(n) ...`.
  - js/account.js: panel "Tai khoan" tu mount qua <body data-account-controls="..."> — doi mat khau (moi role) + tu xoa tai khoan (role user).
  - js/process.js: module nhat ky dung chung — ACTIVITIES + icon SVG, format ngay, summary chip, entry card (render textContent), `createProcessDrawer({ canAdd, onChanged })` → { open(userId, name), close, refresh, isOpenFor(id) }. Bo loc theo hoat dong + khoang ngay (loc client-side tren toi da 200 muc), empty state rieng khi khong khop, xuat CSV (BOM UTF-8, escape o, ten file `nhat-ky-<slug>-<ngay>.csv`). Anh trong timeline bam mo lightbox (giu link cho mo tab moi). User thay nut Them/Xoa; admin xem/xoa; partner xem timeline rieng.
  - js/{auth, chat, admin, partner}.js: Logic frontend tuong ung, moi role chuyen thread bang tab. chat/admin/partner co optimistic send: bubble "dang gui" + clientId, loi socket thi tra noi dung ve o nhap. `activeConvId` doi theo tab; pager reset theo thread; ghi am tu gui vao dung conv da bat dau va bi huy khi doi thread/khach. chat/admin/partner deu nghe `process-updated` de refresh timeline (debounce 200–250ms); admin con refresh sidebar + toast. **Thong bao**: tin den thread khong dang mo → `playPing()` + `unreadTitle.bump(...)`; mo thread → `unreadTitle.clear(...)`; admin dung `unreadTitle.setAll(tongUnread)` trong renderOverview (tu dong cap nhat khi badge socket thay doi). Admin giu `latestUsers` + `searchQuery`, loc danh sach client-side, cap nhat 4 the tong quan khi loadUsers hoac badge socket (`unread-badge`, `badge-cleared`, `partner-badge`, `partner-badge-cleared`). Tin moi o thread khong active → `.has-new` + toast, khong chen vao khung dang mo.
- scripts/e2e.js: E2E test tu dong (REST + socket + upload anh/am thanh + phan trang + rate-limit + restart persist + security: attachment strip, cap 4000 ky tu, headers, /api/admin/stats). Tu spawn server port 3100, DB `data/e2e.db`. Luu y budget rate-limit 8 tin/10s cho role user khi them test socket moi.
- scripts/ui-check.js: UI check headless bang playwright-core + Edge/Chrome (co `--use-fake-device-for-media-stream` de test ghi am). Tu spawn server port 3199, DB `data/ui-check.db`, screenshot vao `.verify/` (gitignored). Tìm browser theo danh sach mac dinh hoac `UI_BROWSER`; chay tren server san co bang `UI_BASE`. Test them: modal thong ke admin, lightbox anh (mo bang click, dong bang Esc), title tab unread cho admin + partner.
- scripts/fixtures/attach.png: file 1x1 PNG cho test upload UI.
- docs/screenshots/: anh cho README.
- .github/workflows/ci.yml: GitHub Actions — job e2e (Node 20/22) + job ui-check (Node 22, dung Google Chrome co san tren ubuntu-latest).

## 4. Trang thai hien tai & Luu y
- Ca 3 luong User–Admin–Partner da chay that voi **3 thread rieng tu** (user_admin / partner_user / partner_admin): **E2E 104/104** + **UI check 90/90** (Edge headless).
- UI/UX theme xanh nong nghiep + animation: typing indicator realtime, toast thay alert(), avatar chu cai theo role, status ket noi, phan trang lich su, ambient background, timeline nhat ky + empty state dong, drawer truot, tab thread + cham tin moi, sidebar admin co 4 the tong quan + tim kiem khach, bo loc nhat ky + xuat CSV, **modal thong ke (KPI + bieu do cot 7 ngay + donut hoat dong + top khach)**, **lightbox xem anh to** (chat + nhat ky), **am thanh ping + so tin chua doc tren title tab** o ca 3 role.
- Security: attachment URL trong tin nhan socket phai la file that su nam trong `public/uploads/` (chan tracking pixel/path traversal), tin nhan cap 4000 ky tu, 3 security headers (nosniff, SAMEORIGIN, referrer-policy).
- Tin nhan thoai: ghi bang MediaRecorder o ca 3 giao dien (toi da 60 giay, toi thieu 0.6 giay), tu upload `.webm/.ogg` roi gui ngay; hien `<audio controls>` trong bubble; huy khi doi thread; chip hien dong ho dem. Upload server nhan them mp3/wav/m4a (magic bytes).
- Nhat ky canh tac: bang `process_entries` (activity enum sowing/fertilizing/watering/pesticide/pruning/harvest/other, performed_at YYYY-MM-DD, title, method, details, attachment). User CRUD cua minh; admin xem + xoa duoc; partner chi xem khi da duoc gan. Gioi han 200 muc/khach, 1 anh/dinh kem/muc. Drawer user/admin co loc theo hoat dong/khoang ngay va xuat CSV (client-side, khong doi API).
- Chat rieng tu: partner↔khach va partner↔admin la 2 thread doc lap (tao khi admin gan partner). Admin khong thay partner↔khach; user khong thay partner↔admin; partner khong thay user↔admin. Quyen partner bi thu hoi ngay khi admin gan partner khac (kiem tra user_admin.partner_id moi lan access).
- Tai khoan seed: **admin/admin123**, **partner1/admin123**, **user1/user123** (luu y: partner1 dung hash cua admin123). Trang login co 3 nut "Vao nhanh" bam la dang nhap luon (van goi /api/login voi thong tin seed, khong mo endpoint passwordless).
- Session persist qua restart (cookie + sessionId). Login regenerate session id moi.
- Socket event contract: client → `join {convId}`, `message {convId, content, attachment?, clientId?}`, `read {convId}`, `typing {convId, isTyping}`; server → `joined`, `message` (echo clientId, kem senderRole), `unread-badge`, `badge-cleared` (thread user_admin), `partner-badge`, `partner-badge-cleared` (thread partner_admin), `user-message` (room `admins`, kem senderRole), `partner-message` (room `admins`, tin partner trong partner_admin), `typing {convId, userId, name, isTyping}`, `process-updated {userId, userName, convId, action, entryId}`, `error`. Moi `join`/`message`/`read` deu qua `canAccessConversation`; client join tat ca thread cua minh luc connect de nhan realtime.
- Secret session: env `SESSION_SECRET` (co gia tri mac dinh cho dev).
- Unread: `admin_last_read_id` la watermark id tin theo tung conversation; badge do dem tin khach sau watermark trong user_admin; badge partner (amber) dem tin partner sau watermark trong partner_admin.

## 5. Cach chay
- `npm ci` → `npm start` (http://localhost:3000).
- `npm run e2e` (port 3100, DB tach).
- `npm run ui-check` (tu spawn server port 3199 + DB rieng; can Edge/Chrome hoac `UI_BROWSER`).

## 6. Cong viec tiep theo goi y
- File upload (chat + nhat ky) cua user bi xoa van con tren dia (`public/uploads/`) — can job don rac.
- CSRF token (hien cookie SameSite mac dinh Lax).
- Nhat ky: nhieu anh/muc, xuat PDF/Excel, loc theo mua vu.
- Virtualize DOM / phan trang theo ngay cho hoi thoai rat dai.
- Rate limiter trong bo nho → Redis neu chay nhieu instance / nhieu node.
- Thong bao push (Notification API + service worker), dashboard thong ke theo thang/mua vu, tim kiem trong lich su chat, am thanh ping cho phien ban mobile.
