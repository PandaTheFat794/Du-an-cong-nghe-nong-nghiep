# Project Context: Web Tu van Nong nghiep (User - Admin - Partner)

## 1. Tong quan du an
He thong web tu van truc tuyen (mo phong giao dien kieu Zalo chat):
- **User (Khach hang)**: Dang ky, dang nhap, chat voi Admin de duoc tu van lo trinh/ky thuat nong nghiep, gui kem anh/tai lieu.
- **Admin**: Sidebar quan ly danh sach user can tu van (kem badge unread), khung chat truc tiep voi user, gan "Ben thu 3" (Partner) cho user.
- **Partner (Ben thu 3)**: Dang nhap, xem danh sach khach hang duoc admin gan, xem toan bo lich su/lo trinh tu van (che do Read-only, nhan tin moi realtime nhung khong gui duoc).

## 2. Tech Stack
- **Backend**: Node.js + Express + Socket.io (WebSocket chat real-time, path: /ws; client bundle nam tai `/ws/socket.io.js`).
- **Database**: SQLite qua better-sqlite3 (file `data/app.db`, module db.js) gom 4 bang: users, conversations, messages, sessions.
- **Auth**: express-session + **SQLite session store tu viet** (`session-store.js`, sống sót qua restart). Socket handshake xac thuc bang `?sessionId=` (tra ve tu /api/login) qua cung store.
- **Upload**: multer → `public/uploads/`, toi da 5MB, whitelist phan mo rong (jpg/png/gif/webp/pdf/doc/docx) + **kiem tra magic bytes** chan file gia mao dinh dang.
- **Chong spam**: socket 'message' gioi han 8 tin / 10 giay / user (server.js, token-window Map).
- **Frontend**: HTML5, CSS3, Vanilla JavaScript thuan (khong dung build tools/bundler).

## 3. Cau truc thu muc
- server.js: Entry point (session, socket events, page guards /chat /admin /partner theo role).
- db.js: Schema SQLite + helpers (insertMessage tra row day du, getMessages tra field camelCase).
- session-store.js: Store express-session tren SQLite + getSessionUser() cho socket.
- auth.js: Middleware requireAuth/requireRole + login/logout/me.
- routes/:
  - auth.js: /api/register, /api/login, /api/logout, /api/me (kem conversation_id cho role user), POST /api/me/password (doi mat khau), DELETE /api/me (user tu xoa tai khoan, cascade xoa lich su).
  - chat.js: GET /api/conversations/:id/messages (owner/admin/partner duoc gan).
  - admin.js: GET /api/admin/users, GET /api/admin/partners, POST /api/admin/conversations/:id/connect, DELETE /api/admin/users/:id (admin xoa khach).
  - partner.js: GET /api/partner/conversations.
  - upload.js: POST /api/upload (multipart field "file").
- public/:
  - index.html: Form dang nhap / dang ky, tu dong redirect theo role.
  - chat.html: Giao dien chat cua User (gui tin + dinh kem, hien chip Partner).
  - admin.html: Sidebar khach hang + khung chat + chon/gan Partner.
  - partner.html: Danh sach khach duoc gan + lich su read-only.
  - css/style.css: Layout Zalo-style.
  - js/common.js: api(), uploadFile(), messageEl() (render textContent, chong XSS), parse thoi gian UTC tu SQLite.
  - js/account.js: panel "Tai khoan" tu mount qua <body data-account-controls="..."> — doi mat khau (moi role) + tu xoa tai khoan (role user).
  - js/{auth, chat, admin, partner}.js: Logic frontend tuong ung.
- scripts/e2e.js: E2E test tu dong (REST + socket + upload + restart persist).

## 4. Trang thai hien tai & Luu y
- Ca 3 luong User–Admin–Partner da chay that (E2E 40/40 + UI check 22/22 tren Edge headless).
- Tai khoan seed: **admin/admin123**, **partner1/admin123**, **user1/user123** (luu y: partner1 dung hash cua admin123).
- Session da persist: restart server khong lam mat dang nhap (cookie + sessionId deu con hieu luc).
- Socket event contract: client → `join {convId}`, `message {convId, content, attachment?}`, `read {convId}`; server → `joined`, `message`, `unread-badge`, `badge-cleared`, `user-message` (room `admins`), `error`.
- Secret session: env `SESSION_SECRET` (co gia tri mac dinh cho dev).

## 5. Cach chay
- `npm install` → `npm start` (http://localhost:3000) → `npm run e2e` (server tam tren port 3100, DB tach `data/e2e.db`).

## 6. Cong viec tiep theo goi y
- File upload cua user bi xoa van con tren dia (`public/uploads/`) — can doi khi don rac.
- Phan trang / virtual hoa lich su chat dai.
- Bao mat them: CSRF token (hien cookie SameSite mac dinh Lax), rate-limit cho API login (hien moi chi chan spam socket message).
