# Project Context: Web Tu van Nong nghiep (User - Admin - Partner)

## 1. Tong quan du an
He thong web tu van truc tuyen (mo phong giao dien kieu Zalo chat):
- **User (Khach hang)**: Dang ky, dang nhap, chat voi Admin + Partner, gui kem anh/tai lieu. Tu ghi **nhat ky canh tac** (hoat dong, ngay, phuong phap, chi tiet, anh) va xem timeline cua minh.
- **Admin**: Sidebar quan ly danh sach user can tu van (kem badge unread + so muc nhat ky), khung chat truc tiep, gan "Ben thu 3" (Partner) cho user, xem nhat ky canh tac cua khach.
- **Partner (Ben thu 3)**: Dang nhap, xem danh sach khach hang duoc admin gan, xem **nhat ky canh tac** + lich su chat. Nhan tin duoc trong cung luong chat 3 ben (user–admin–partner) sau khi duoc gan; khong tao/xoa duoc nhat ky.

## 2. Tech Stack
- **Backend**: Node.js + Express + Socket.io (WebSocket chat real-time, path: /ws; client bundle nam tai `/ws/socket.io.js`).
- **Database**: SQLite qua better-sqlite3 (file `data/app.db`, module db.js) gom 5 bang: users, conversations, messages, process_entries, sessions.
  - `journal_mode=WAL` + `busy_timeout=5000`; index `idx_messages_conversation_id ON messages(conversation_id, id)` va `idx_process_entries_user ON process_entries(user_id, performed_at DESC, id DESC)`.
- **Auth**: express-session + **SQLite session store tu viet** (`session-store.js`, song sot qua restart). Socket handshake xac thuc bang `?sessionId=` (tra ve tu /api/login) qua cung store. Login cap session id moi (`req.session.regenerate` + `save`) chong session fixation.
- **Upload**: multer → `public/uploads/`, toi da 5MB, whitelist phan mo rong (jpg/png/gif/webp/pdf/doc/docx) + **kiem tra magic bytes** chan file gia mao dinh dang.
- **Rate limit** (`rate-limit.js`, cua so truot trong bo nho): socket message 8 tin/10s/user; login 20/5 phut/IP; register 10/10 phut/IP; upload 30/10 phut/user.
- **Env**: `dotenv` doc `.env` (mau tai `.env.example`); bien trong shell duoc uu tien.
- **Frontend**: HTML5, CSS3, Vanilla JavaScript thuan (khong dung build tools/bundler).

## 3. Cau truc thu muc
- server.js: Entry point (session, socket events, page guards /chat /admin /partner theo role).
- db.js: Schema SQLite + migration + helpers:
  - `getMessagesPage(convId, beforeId, limit)` → `{ messages, has_more }` (trang moi nhat truoc, sap cu → moi).
  - `markAsRead` / `countUnread`: watermark `conversations.admin_last_read_id`, chi dem tin co `sender_id = user_id` (khong dem tin admin/partner tu tra loi).
  - Nhat ky: `getProcessEntries(userId)` (toi da 200, moi nhat truoc), `getProcessEntry`, `insertProcessEntry`, `deleteProcessEntry`, `getUserById`.
- session-store.js: Store express-session tren SQLite + getSessionUser() cho socket.
- auth.js: Middleware requireAuth/requireRole + login (regenerate session)/logout.
- rate-limit.js: `createRateLimiter({ windowMs, max, message, keyFn })` → middleware 429.
- routes/:
  - auth.js: /api/register (validate username 3-32 `[a-zA-Z0-9_.-]`, password 6-72, display_name 1-60; rate-limit), /api/login (rate-limit), /api/logout, /api/me (kem conversation_id cho role user), POST /api/me/password (doi mat khau), DELETE /api/me (user tu xoa tai khoan, cascade xoa lich su).
  - chat.js: GET /api/conversations/:id/messages?before=&limit= (mac dinh 50, toi da 100; owner/admin/partner duoc gan).
  - admin.js: GET /api/admin/users (1 query duy nhat: preview + unread, khong N+1), GET /api/admin/partners, POST /api/admin/conversations/:id/connect, DELETE /api/admin/users/:id (admin xoa khach).
  - partner.js: GET /api/partner/conversations (kem `process_count`, `message_count`).
  - process.js: GET /api/process?userId= (admin/owner/partner duoc gan), POST /api/process (chi role user, validate activity/ngay that/title/method/details/attachment path), DELETE /api/process/:id (owner hoac admin). Moi thay doi phat socket `process-updated` toi room `admins` + `conv_<id>`.
  - upload.js: POST /api/upload (multipart field "file", rate-limit theo user).
- public/:
  - index.html: Form dang nhap / dang ky, tu dong redirect theo role.
  - chat.html: Giao dien chat cua User (gui tin + dinh kem, hien chip Partner, nut Tai tin cu hon, nut "Nhat ky" mo drawer).
  - admin.html: Sidebar khach hang (badge unread + so muc nhat ky) + khung chat + chon/gan Partner + nut "Nhat ky" xem drawer cua khach dang chon.
  - partner.html: Sidebar khach duoc gan + workbench 2 tab: "Nhat ky canh tac" (timeline) va "Tro chuyen" (chat 3 ben, gui duoc).
  - favicon.svg: icon la cay (tranh 404 /favicon.ico vi da co <link rel="icon"> trong 4 trang).
  - css/style.css: Design system "nong nghiep" (bien CSS, gradient, keyframe animation, glass login card, avatar mau theo role, toast, typing indicator, `.load-more`, ambient background, timeline/drawer nhat ky, `.view-tabs`, responsive + prefers-reduced-motion). **Luon khai bao `[hidden]{display:none}` cho moi class co set display** (da fix bug .user-unread, #loginForm/#registerForm, .partner-chip, .process-overlay, .process-pane/.chat-pane). Khi drawer mo (`body.drawer-open`) toast duoc day sang vung chat de khong che header.
  - js/common.js: api(), uploadFile(), messageEl() (render textContent, chong XSS, them class `role-<senderRole>`), parse thoi gian UTC tu SQLite, toast(), avatarEl(), createTypingSender/createTypingView, wireConnectionIndicator, wireAttachButton, **createHistoryPager(area, button, render)** (nut Tai tin cu hon, giu scroll, bo qua response cua conv da doi).
  - js/account.js: panel "Tai khoan" tu mount qua <body data-account-controls="..."> — doi mat khau (moi role) + tu xoa tai khoan (role user).
  - js/process.js: module nhat ky dung chung — ACTIVITIES + icon SVG, format ngay, summary chip, entry card (render textContent), `createProcessDrawer({ canAdd, onChanged })` → { open(userId, name), close, refresh, isOpenFor(id) }. User thay nut Them/Xoa; admin/partner chi xem.
  - js/{auth, chat, admin, partner}.js: Logic frontend tuong ung. chat/admin/partner co optimistic send: bubble "dang gui" + clientId, loi socket thi tra noi dung ve o nhap. chat/admin/partner deu nghe `process-updated` de refresh timeline (debounce 200–250ms); admin con refresh sidebar + toast.
- scripts/e2e.js: E2E test tu dong (REST + socket + upload + phan trang + rate-limit + restart persist). Tu spawn server port 3100, DB `data/e2e.db`.
- scripts/ui-check.js: UI check headless bang playwright-core + Edge/Chrome. Tu spawn server port 3199, DB `data/ui-check.db`, screenshot vao `.verify/` (gitignored). Tìm browser theo danh sach mac dinh hoac `UI_BROWSER`; chay tren server san co bang `UI_BASE`.
- scripts/fixtures/attach.png: file 1x1 PNG cho test upload UI.
- docs/screenshots/: anh cho README.
- .github/workflows/ci.yml: GitHub Actions chay `npm ci` + `npm run e2e` tren Node 20/22.

## 4. Trang thai hien tai & Luu y
- Ca 3 luong User–Admin–Partner da chay that: **E2E 74/74** + **UI check 40/40** (Edge headless).
- UI/UX theme xanh nong nghiep + animation: typing indicator realtime, toast thay alert(), avatar chu cai theo role, status ket noi, phan trang lich su, ambient background, timeline nhat ky + empty state dong, drawer truot.
- Nhat ky canh tac: bang `process_entries` (activity enum sowing/fertilizing/watering/pesticide/pruning/harvest/other, performed_at YYYY-MM-DD, title, method, details, attachment). User CRUD cua minh; admin xem + xoa duoc; partner chi xem khi da duoc gan. Gioi han 200 muc/khach, 1 anh/dinh kem/muc.
- Chat 3 ben: partner da duoc gan gui tin duoc (server check `conversation.partner_id === user.id`); tin partner khong lam tang badge unread cua admin (chi dem tin cua khach).
- Tai khoan seed: **admin/admin123**, **partner1/admin123**, **user1/user123** (luu y: partner1 dung hash cua admin123).
- Session persist qua restart (cookie + sessionId). Login regenerate session id moi.
- Socket event contract: client → `join {convId}`, `message {convId, content, attachment?, clientId?}`, `read {convId}`, `typing {convId, isTyping}`; server → `joined`, `message` (echo clientId, kem senderRole), `unread-badge`, `badge-cleared`, `user-message` (room `admins`, kem senderRole), `typing {convId, userId, name, isTyping}`, `process-updated {userId, userName, convId, action, entryId}`, `error`.
- Secret session: env `SESSION_SECRET` (co gia tri mac dinh cho dev).
- Unread: `admin_last_read_id` la watermark id tin; countUnread chi dem tin cua khach sau watermark.

## 5. Cach chay
- `npm ci` → `npm start` (http://localhost:3000).
- `npm run e2e` (port 3100, DB tach).
- `npm run ui-check` (tu spawn server port 3199 + DB rieng; can Edge/Chrome hoac `UI_BROWSER`).

## 6. Cong viec tiep theo goi y
- File upload (chat + nhat ky) cua user bi xoa van con tren dia (`public/uploads/`) — can job don rac.
- CSRF token (hien cookie SameSite mac dinh Lax).
- Nhat ky: loc theo mua vu/khoang ngay, nhieu anh/muc, xuat PDF/Excel.
- Virtualize DOM / phan trang theo ngay cho hoi thoai rat dai.
- Rate limiter trong bo nho → Redis neu chay nhieu instance / nhieu node.
- Thong bao push, tim kiem khach hang, dashboard thong ke.
