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
      onResult(res);
    } catch (e) {
      if (chip) chip.textContent = `Lỗi: ${e.message}`;
      setTimeout(() => { if (chip) chip.textContent = ''; }, 4000);
    }
  });
}
