// Helpers dùng chung cho cả 3 role (vanilla JS, không build tool)
const API_BASE = '/api';

function getSessionId() {
  return localStorage.getItem('sessionId');
}
function saveSession(sessionId) {
  localStorage.setItem('sessionId', sessionId);
}
function clearSession() {
  localStorage.removeItem('sessionId');
}
function homeFor(role) {
  return role === 'admin' ? '/admin' : role === 'partner' ? '/partner' : '/chat';
}

async function api(path, opts = {}) {
  const resp = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try { data = await resp.json(); } catch { /* response không phải JSON */ }
  return { status: resp.status, data };
}

async function logout() {
  await api('/logout', { method: 'POST' });
  clearSession();
  window.location.href = '/';
}

// Upload 1 file lên /api/upload (multipart) → { url, name }
async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const resp = await fetch(API_BASE + '/upload', { method: 'POST', body: fd });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'Upload thất bại');
  return data;
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;

// SQLite datetime('now') trả về UTC dạng "YYYY-MM-DD HH:MM:SS"
function parseDbTime(value) {
  return new Date(String(value).replace(' ', 'T') + 'Z');
}
function utcNowDb() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function formatTime(value) {
  return parseDbTime(value).toLocaleTimeString('vi-VN');
}

/**
 * Tạo 1 bubble tin nhắn. Render bằng textContent (không innerHTML) để tránh XSS.
 * msg: { senderName, senderRole, content, attachmentUrl, attachmentName, createdAt }
 * mine: tin của mình → bong bóng bên phải
 */
function messageEl(msg, mine, cssBase = 'message') {
  const div = document.createElement('div');
  div.className = `${cssBase} ${mine ? 'user' : 'admin'}`;

  if (!mine && msg.senderName) {
    const name = document.createElement('div');
    name.className = `${cssBase}-sender`;
    name.textContent = msg.senderName;
    div.appendChild(name);
  }

  if (msg.content) {
    const text = document.createElement('div');
    text.textContent = msg.content;
    div.appendChild(text);
  }

  if (msg.attachmentUrl) {
    if (IMAGE_EXT_RE.test(msg.attachmentName || msg.attachmentUrl)) {
      const img = document.createElement('img');
      img.className = `${cssBase}-img`;
      img.src = msg.attachmentUrl;
      img.alt = msg.attachmentName || 'hình ảnh';
      div.appendChild(img);
    } else {
      const link = document.createElement('a');
      link.className = `${cssBase}-file`;
      link.href = msg.attachmentUrl;
      link.download = msg.attachmentName || 'tai-lieu';
      link.textContent = `Đính kèm: ${msg.attachmentName || 'tệp'}`;
      div.appendChild(link);
    }
  }

  const time = document.createElement('div');
  time.className = `${cssBase}-time`;
  time.textContent = formatTime(msg.createdAt);
  div.appendChild(time);

  return div;
}

// Gắn nút logout cho mọi trang
function wireLogout(buttonId) {
  const btn = document.getElementById(buttonId);
  if (btn) btn.addEventListener('click', logout);
}

// ===== Toast: thông báo nổi ở góc phải (thay cho alert/flash text) =====
function toast(message, type = 'info', duration = 3500) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ===== Avatar chữ cái đầu (TDK của tên hiển thị) =====
function initialsOf(name) {
  const words = String(name || '?').trim().split(/\s+/);
  return words.slice(-2).map((w) => w[0]).join('').toUpperCase();
}
function avatarEl(name, role) {
  const av = document.createElement('div');
  av.className = 'avatar' + (role ? ` role-${role}` : '');
  av.textContent = initialsOf(name);
  av.setAttribute('aria-hidden', 'true');
  return av;
}

// ===== Typing indicator =====
function typingRowEl() {
  const row = document.createElement('div');
  row.className = 'message admin typing-row';
  const dots = document.createElement('span');
  dots.className = 'typing-bubble';
  for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement('i'));
  row.appendChild(dots);
  return row;
}

/** Người gửi: throttle "đang gõ" khi input thay đổi, tự tắt sau 2.5s ngừng gõ. */
function createTypingSender(socket, getConvId) {
  let active = false;
  let stopTimer = null;
  function stop() {
    if (!active) return;
    active = false;
    clearTimeout(stopTimer);
    const convId = getConvId();
    if (convId) socket.emit('typing', { convId, isTyping: false });
  }
  return {
    onInput() {
      const convId = getConvId();
      if (!convId) return;
      if (!active) {
        active = true;
        socket.emit('typing', { convId, isTyping: true });
      }
      clearTimeout(stopTimer);
      stopTimer = setTimeout(stop, 2500);
    },
    stop,
  };
}

/** Người nhận: thêm/bớt bong bóng 3 chấm trong khung tin nhắn. */
function createTypingView(area, scrollBottom) {
  let row = null;
  let hideTimer = null;
  function hide() {
    clearTimeout(hideTimer);
    if (row) { row.remove(); row = null; }
  }
  return {
    show() {
      if (!row) {
        row = typingRowEl();
        area.appendChild(row);
      }
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 5000); // phòng khi mất event isTyping:false
      scrollBottom();
    },
    hide,
  };
}

/** Dot trạng thái kết nối + toast khi rớt/mở lại socket. */
function wireConnectionIndicator(socket, dotEl) {
  socket.on('connect', () => {
    if (dotEl) { dotEl.classList.add('online'); dotEl.classList.remove('offline'); }
  });
  socket.on('disconnect', () => {
    if (dotEl) { dotEl.classList.add('offline'); dotEl.classList.remove('online'); }
    toast('Mất kết nối máy chủ, đang thử kết nối lại...', 'error');
  });
}

// Ô input file → gửi lên server, trả về {url, name} (dùng cho chat & admin)
function wireAttachButton(attachBtnId, fileInputId, chipId, onResult) {
  const btn = document.getElementById(attachBtnId);
  const input = document.getElementById(fileInputId);
  const chip = document.getElementById(chipId);
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const res = await uploadFile(file);
      if (chip) chip.textContent = `Đang đính kèm: ${res.name}`;
      toast(`Đã tải lên ${res.name}`, 'success');
      onResult(res);
    } catch (e) {
      if (chip) chip.textContent = '';
      toast(e.message, 'error');
    }
  });
}
