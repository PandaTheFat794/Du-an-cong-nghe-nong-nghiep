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
const AUDIO_EXT_RE = /\.(webm|ogg|oga|mp3|wav|m4a)$/i;

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
  if (msg.senderRole) div.classList.add(`role-${msg.senderRole}`);

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
    const name = msg.attachmentName || msg.attachmentUrl;
    if (IMAGE_EXT_RE.test(name)) {
      const img = document.createElement('img');
      img.className = `${cssBase}-img`;
      img.src = msg.attachmentUrl;
      img.alt = msg.attachmentName || 'hình ảnh';
      img.title = 'Bấm để xem ảnh to';
      img.addEventListener('click', () => openLightbox(msg.attachmentUrl, msg.attachmentName));
      div.appendChild(img);
    } else if (AUDIO_EXT_RE.test(name)) {
      const audio = document.createElement('audio');
      audio.className = `${cssBase}-audio`;
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = msg.attachmentUrl;
      audio.title = `Tin nhắn thoại: ${name}`;
      div.appendChild(audio);
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

/**
 * Phân trang lịch sử chat: trang đầu là tin mới nhất; nút "Tải tin cũ hơn"
 * nạp thêm một trang cũ hơn và giữ nguyên vị trí người dùng đang đọc.
 * - area: khung chứa tin, button: nút tải thêm (hidden khi hết tin)
 * - render(msg): trả về element của một tin
 */
function createHistoryPager(area, button, render) {
  const PAGE_SIZE = 50;
  let convId = null;
  let oldestId = null;
  let hasMore = false;
  let loading = false;

  function syncButton() {
    if (button) button.hidden = !hasMore;
  }

  function applyPage(data, prepend) {
    const prevHeight = area.scrollHeight;
    const frag = document.createDocumentFragment();
    for (const msg of data.messages) frag.appendChild(render(msg));
    if (prepend) {
      area.insertBefore(frag, area.firstChild);
      // Bù scroll để nội dung đang đọc không bị nhảy khi chèn trang cũ lên đầu
      area.scrollTop += area.scrollHeight - prevHeight;
    } else {
      area.appendChild(frag);
    }
    hasMore = !!data.has_more;
    if (data.messages.length) oldestId = data.messages[0].id;
    syncButton();
  }

  async function loadMore() {
    if (!convId || !hasMore || loading) return;
    loading = true;
    const requestedConv = convId;
    if (button) button.disabled = true;
    const { data } = await api(`/conversations/${requestedConv}/messages?before=${oldestId}&limit=${PAGE_SIZE}`);
    loading = false;
    if (button) button.disabled = false;
    // Bỏ qua nếu người dùng đã chuyển sang conversation khác trong lúc chờ
    if (requestedConv === convId && data && data.success) applyPage(data, true);
  }

  if (button) button.addEventListener('click', loadMore);

  return {
    async open(id) {
      convId = id;
      oldestId = null;
      hasMore = false;
      syncButton();
      area.innerHTML = '';
      const { data } = await api(`/conversations/${id}/messages?limit=${PAGE_SIZE}`);
      if (convId !== id || !data || !data.success) return null;
      applyPage(data, false);
      return data;
    },
    reset() {
      convId = null;
      oldestId = null;
      hasMore = false;
      syncButton();
    },
    loadMore,
  };
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

// ===== Lightbox xem ảnh to =====
let lightboxEl = null;

function closeLightbox() {
  if (!lightboxEl || lightboxEl.hidden) return;
  lightboxEl.classList.remove('open');
  document.body.classList.remove('lightbox-open');
  setTimeout(() => {
    // Đã mở ảnh khác ngay sau khi đóng → không ẩn lightbox mới
    if (!lightboxEl.classList.contains('open')) {
      lightboxEl.hidden = true;
      lightboxEl.querySelector('img').src = '';
    }
  }, 200);
}

function openLightbox(src, alt) {
  if (!lightboxEl) {
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox';
    lightboxEl.hidden = true;
    lightboxEl.setAttribute('role', 'dialog');
    lightboxEl.setAttribute('aria-label', 'Xem ảnh phóng to');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Đóng');
    closeBtn.textContent = '×';

    const img = document.createElement('img');
    img.alt = '';

    lightboxEl.appendChild(closeBtn);
    lightboxEl.appendChild(img);
    lightboxEl.addEventListener('click', (e) => {
      if (e.target !== img) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });
    document.body.appendChild(lightboxEl);
  }
  const img = lightboxEl.querySelector('img');
  img.src = src;
  img.alt = alt || '';
  lightboxEl.hidden = false;
  document.body.classList.add('lightbox-open');
  requestAnimationFrame(() => lightboxEl.classList.add('open'));
}

// ===== Âm thanh thông báo (Web Audio, không cần file asset) =====
let audioCtx = null;
let lastPingAt = 0;

function playPing() {
  const now = Date.now();
  if (now - lastPingAt < 1200) return;
  lastPingAt = now;
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [880, 1174.66].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch { /* trình duyệt chặn audio khi chưa tương tác */ }
}

// ===== Số tin chưa đọc trên title tab =====
const unreadTitle = (() => {
  const base = document.title;
  const counts = new Map();
  function render() {
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    document.title = total > 0 ? `(${total}) ${base}` : base;
  }
  return {
    bump(key) {
      counts.set(key, (counts.get(key) || 0) + 1);
      render();
    },
    clear(key) {
      if (counts.delete(key)) render();
    },
    setAll(total) {
      counts.clear();
      if (total > 0) counts.set('__all__', total);
      render();
    },
  };
})();

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

// ===== Ghi âm tin nhắn (MediaRecorder) =====
const VOICE_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

function voiceExtFor(mime) {
  if (/ogg/.test(mime)) return 'ogg';
  if (/mp4|aac/.test(mime)) return 'm4a';
  if (/wav/.test(mime)) return 'wav';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  return 'webm';
}

/**
 * Bấm micro để ghi âm, bấm lần nữa để dừng → tự upload và gọi onRecorded(res, convId).
 * - canStart(): chặn khi chưa chọn hội thoại / đang có file đính kèm
 * - convId được chụp lúc bắt đầu ghi; người gọi tự kiểm tra đã chuyển thread chưa
 * Trả về { cancel, isRecording } để hủy khi đổi cuộc trò chuyện.
 */
function wireVoiceRecorder({ buttonId, chipId, canStart, getConvId, onRecorded, maxSeconds = 60 }) {
  const btn = document.getElementById(buttonId);
  const chip = chipId ? document.getElementById(chipId) : null;
  if (!btn) return null;

  // Khóa ô nhập + nút gửi/đính kèm trong lúc ghi để tránh gửi lẫn
  const lockables = [...(btn.closest('.input-area')?.querySelectorAll('.attach-btn, .input-btn, .input-field') || [])]
    .filter((el) => el !== btn);
  const wasDisabled = new Map();
  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;
  let tickTimer = null;
  let autoStopTimer = null;
  let activeSession = null;

  function setChip(text) {
    if (chip) chip.textContent = text;
  }

  function setRecordingUI(recording) {
    btn.classList.toggle('recording', recording);
    btn.setAttribute('aria-pressed', recording ? 'true' : 'false');
    btn.title = recording ? 'Dừng ghi âm và gửi' : 'Ghi âm tin nhắn';
    btn.setAttribute('aria-label', btn.title);
    if (recording) {
      for (const el of lockables) {
        wasDisabled.set(el, el.disabled);
        el.disabled = true;
      }
    } else {
      for (const [el, disabled] of wasDisabled) el.disabled = disabled;
      wasDisabled.clear();
    }
  }

  function releaseStream() {
    clearInterval(tickTimer);
    clearTimeout(autoStopTimer);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
  }

  function reset() {
    releaseStream();
    recorder = null;
    chunks = [];
    activeSession = null;
    setChip('');
    setRecordingUI(false);
  }

  async function start() {
    if (activeSession) return;
    if (canStart && !canStart()) {
      toast('Hãy gửi hoặc bỏ đính kèm hiện tại trước khi ghi âm.', 'info');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast('Trình duyệt không hỗ trợ ghi âm trực tiếp.', 'error');
      return;
    }

    const session = { cancelled: false, convId: getConvId ? getConvId() : null };
    let media;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('Không truy cập được micro. Hãy kiểm tra quyền trình duyệt.', 'error');
      return;
    }
    if (session.cancelled) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }

    const mimeType = VOICE_MIME_CANDIDATES.find(
      (m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)
    ) || '';
    try {
      recorder = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
    } catch {
      media.getTracks().forEach((track) => track.stop());
      toast('Không khởi động được bộ ghi âm.', 'error');
      return;
    }

    stream = media;
    activeSession = session;
    chunks = [];
    startedAt = Date.now();
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    recorder.addEventListener('stop', () => finish(session));
    recorder.start();
    setRecordingUI(true);

    const tick = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      setChip(`● Đang ghi âm ${mm}:${ss} — bấm micro để dừng`);
    };
    tick();
    tickTimer = setInterval(tick, 500);
    autoStopTimer = setTimeout(() => {
      if (activeSession === session) {
        toast(`Đã đạt giới hạn ${maxSeconds} giây, bản ghi âm được gửi.`, 'info');
        stop();
      }
    }, maxSeconds * 1000);
  }

  async function finish(session) {
    const duration = Date.now() - startedAt;
    const mime = (recorder && recorder.mimeType) || 'audio/webm';
    const blob = new Blob(chunks, { type: mime });
    releaseStream();
    recorder = null;
    chunks = [];
    activeSession = null;
    setRecordingUI(false);

    if (session.cancelled) {
      setChip('');
      return;
    }
    if (duration < 600 || !blob.size) {
      setChip('');
      toast('Bản ghi quá ngắn, hãy giữ micro lâu hơn một chút.', 'info');
      return;
    }

    setChip('Đang tải bản ghi âm...');
    const ext = voiceExtFor(mime);
    const file = new File([blob], `ghi-am-${Date.now()}.${ext}`, { type: mime });
    try {
      const res = await uploadFile(file);
      if (session.cancelled) {
        setChip('');
        return;
      }
      setChip('');
      onRecorded(res, session.convId);
    } catch (e) {
      setChip('');
      toast(e.message, 'error');
    }
  }

  function stop() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { reset(); }
    }
  }

  function cancel() {
    if (!activeSession) return;
    activeSession.cancelled = true;
    // Mở khóa ngay để nơi gọi (vd resetChatArea) kịp disable lại theo trạng thái mới
    setChip('');
    setRecordingUI(false);
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { reset(); }
    } else {
      reset(); // đang upload: bỏ kết quả, finish() sẽ thấy cancelled
    }
  }

  btn.addEventListener('click', () => {
    if (activeSession) stop();
    else start();
  });

  return { cancel, isRecording: () => !!activeSession };
}
