// Nhật ký canh tác: metadata hoạt động, render timeline và drawer dùng chung.
// Phụ thuộc common.js (api, toast, uploadFile, IMAGE_EXT_RE, formatTime, openLightbox).

const PROCESS_ACTIVITIES = [
  {
    key: 'sowing',
    label: 'Gieo hạt',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>',
  },
  {
    key: 'fertilizing',
    label: 'Bón phân',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l-1.2 12H7.2L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><path d="M10 13h4M10 16h4"/></svg>',
  },
  {
    key: 'watering',
    label: 'Tưới nước',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/></svg>',
  },
  {
    key: 'pesticide',
    label: 'Phun thuốc',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9h6l1 12H8L9 9Z"/><path d="M10.5 9V6.5h3V9"/><path d="M16 4h4M18 2v4"/><path d="M11 14h2"/></svg>',
  },
  {
    key: 'pruning',
    label: 'Tỉa cành',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M8.2 7.6 20 17M8.2 16.4 20 7"/></svg>',
  },
  {
    key: 'harvest',
    label: 'Thu hoạch',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11h16l-1.6 8H5.6L4 11Z"/><path d="M8.5 11 12 4l3.5 7"/><path d="M8 15h8"/></svg>',
  },
  {
    key: 'other',
    label: 'Khác',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  },
];

const PROCESS_ACTIVITY_MAP = PROCESS_ACTIVITIES.reduce((acc, item) => {
  acc[item.key] = item;
  return acc;
}, {});

// Thang đánh giá chất lượng do admin chấm (1-5)
const PROCESS_QUALITY_LABELS = {
  1: 'Kém',
  2: 'Yếu',
  3: 'Trung bình',
  4: 'Tốt',
  5: 'Rất tốt',
};

const processNumberFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });

function processNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? processNumberFormat.format(num) : '';
}

// 3 mùa vụ lúa phổ biến (theo tháng thực hiện trong nhật ký)
const PROCESS_SEASONS = [
  { key: 'dong-xuan', label: 'Đông Xuân', months: [12, 1, 2, 3, 4] },
  { key: 'he-thu', label: 'Hè Thu', months: [5, 6, 7, 8] },
  { key: 'thu-dong', label: 'Thu Đông', months: [9, 10, 11] },
];

function processSeasonOf(iso) {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(iso || '');
  if (!m) return null;
  const month = Number(m[1]);
  return PROCESS_SEASONS.find((s) => s.months.includes(month)) || null;
}

function processActivityMeta(key) {
  return PROCESS_ACTIVITY_MAP[key] || PROCESS_ACTIVITY_MAP.other;
}

function todayIsoDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatProcessDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
  const [year, month, day] = iso.split('-');
  const today = todayIsoDate();
  const yesterday = new Date(`${today}T00:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  const yesterdayIso = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
  if (iso === today) return `Hôm nay · ${day}/${month}/${year}`;
  if (iso === yesterdayIso) return `Hôm qua · ${day}/${month}/${year}`;
  return `${day}/${month}/${year}`;
}

function processIconEl(activity) {
  const span = document.createElement('span');
  span.className = 'process-icon';
  span.innerHTML = processActivityMeta(activity).icon; // SVG tĩnh trong file này
  span.setAttribute('aria-hidden', 'true');
  return span;
}

// Một đính kèm {url, name} của mục nhật ký: ảnh (bấm mở lightbox) hoặc link tải tệp
function processAttachmentEl(att) {
  const isImage = IMAGE_EXT_RE.test(att.name || att.url);
  if (isImage) {
    const media = document.createElement('figure');
    media.className = 'process-entry-media';
    const link = document.createElement('a');
    link.href = att.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = document.createElement('img');
    img.src = att.url;
    img.alt = att.name || 'Ảnh nhật ký canh tác';
    img.loading = 'lazy';
    img.title = 'Bấm để xem ảnh to';
    img.addEventListener('click', (e) => {
      e.preventDefault(); // xem tại chỗ bằng lightbox; giữ link cho mở tab mới
      openLightbox(att.url, att.name);
    });
    link.appendChild(img);
    media.appendChild(link);
    return media;
  }
  const link = document.createElement('a');
  link.className = 'process-entry-file';
  link.href = att.url;
  link.download = att.name || 'tai-lieu';
  link.textContent = `Đính kèm: ${att.name || 'tệp'}`;
  return link;
}

function processEmptyEl() {
  const empty = document.createElement('div');
  empty.className = 'process-empty';
  empty.innerHTML = `
    <div class="process-empty-art" aria-hidden="true">
      <span class="process-empty-ring ring-1"></span>
      <span class="process-empty-ring ring-2"></span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/>
        <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>
      </svg>
    </div>
    <h3>Chưa có nhật ký canh tác</h3>
    <p>Ghi lại ngày gieo, cách bón tưới và hình ảnh thực tế để cả quá trình được lưu lại rõ ràng.</p>
  `;
  return empty;
}

function processSummaryEl(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.activity, (counts.get(entry.activity) || 0) + 1);

  const summary = document.createElement('div');
  summary.className = 'process-summary';

  const total = document.createElement('span');
  total.className = 'process-total';
  total.textContent = `${entries.length} mục`;
  summary.appendChild(total);

  for (const activity of PROCESS_ACTIVITIES) {
    const count = counts.get(activity.key);
    if (!count) continue;
    const chip = document.createElement('span');
    chip.className = `process-chip activity-${activity.key}`;
    chip.append(processIconEl(activity.key));
    const text = document.createElement('span');
    text.textContent = `${activity.label} ${count}`;
    chip.appendChild(text);
    summary.appendChild(chip);
  }

  const totalOutput = entries.reduce((sum, e) => sum + (Number(e.outputTons) || 0), 0);
  if (totalOutput > 0) {
    const chip = document.createElement('span');
    chip.className = 'process-output-total';
    chip.textContent = `Tổng sản lượng ${processNumber(totalOutput)} tấn`;
    summary.appendChild(chip);
  }

  return summary;
}

// Diện tích / năng suất / sản lượng của mục thu hoạch
function processYieldEl(entry) {
  const items = [];
  if (entry.areaHa != null) items.push(['Diện tích', entry.areaHa, 'ha']);
  if (entry.yieldPerHa != null) items.push(['Năng suất', entry.yieldPerHa, 'tấn/ha']);
  if (entry.outputTons != null) items.push(['Sản lượng', entry.outputTons, 'tấn']);
  if (!items.length) return null;

  const row = document.createElement('div');
  row.className = 'process-yield';
  for (const [label, value, unit] of items) {
    const chip = document.createElement('span');
    chip.className = 'process-yield-chip';
    const strong = document.createElement('strong');
    strong.textContent = `${label} `;
    chip.append(strong, document.createTextNode(`${processNumber(value)} ${unit}`));
    row.appendChild(chip);
  }
  return row;
}

// Đánh giá chất lượng: user/partner chỉ xem; admin (canRate) được chấm 1-5 + nhận xét
function processQualityEl(entry, opts = {}) {
  const hasRating = Number.isInteger(entry.qualityRating) && entry.qualityRating >= 1;
  if (!hasRating && !opts.canRate) return null;

  const block = document.createElement('div');
  block.className = 'process-quality';

  if (hasRating) {
    const badge = document.createElement('span');
    badge.className = `process-quality-badge quality-${entry.qualityRating}`;
    badge.textContent = `Chất lượng: ${entry.qualityRating}/5 · ${PROCESS_QUALITY_LABELS[entry.qualityRating] || ''}`;
    block.appendChild(badge);
    if (entry.qualityNote) {
      const note = document.createElement('p');
      note.className = 'process-quality-note';
      note.textContent = entry.qualityNote;
      block.appendChild(note);
    }
  } else {
    const hint = document.createElement('span');
    hint.className = 'process-quality-hint';
    hint.textContent = 'Chưa có đánh giá chất lượng';
    block.appendChild(hint);
  }

  if (opts.canRate) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'process-quality-toggle';
    toggle.textContent = hasRating ? 'Sửa đánh giá' : 'Đánh giá chất lượng';

    const form = document.createElement('form');
    form.className = 'process-quality-form';
    form.hidden = true;

    const ratingField = document.createElement('label');
    ratingField.className = 'process-field';
    const ratingTitle = document.createElement('span');
    ratingTitle.textContent = 'Mức chất lượng';
    const ratingSelect = document.createElement('select');
    for (const [value, label] of Object.entries(PROCESS_QUALITY_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${value} · ${label}`;
      ratingSelect.appendChild(option);
    }
    ratingSelect.value = String(hasRating ? entry.qualityRating : 5);
    ratingField.append(ratingTitle, ratingSelect);

    const noteField = document.createElement('label');
    noteField.className = 'process-field';
    const noteTitle = document.createElement('span');
    noteTitle.textContent = 'Nhận xét';
    const noteInput = document.createElement('textarea');
    noteInput.rows = 2;
    noteInput.maxLength = 500;
    noteInput.placeholder = 'Ví dụ: Hạt đều, ít sâu bệnh, đạt tiêu chuẩn xuất khẩu...';
    noteInput.value = entry.qualityNote || '';
    noteField.append(noteTitle, noteInput);

    const actions = document.createElement('div');
    actions.className = 'process-form-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn-primary';
    saveBtn.textContent = 'Lưu đánh giá';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'chat-btn';
    cancelBtn.textContent = 'Hủy';
    actions.append(saveBtn, cancelBtn);
    form.append(ratingField, noteField, actions);

    toggle.addEventListener('click', () => {
      form.hidden = !form.hidden;
      if (!form.hidden) ratingSelect.focus();
    });
    cancelBtn.addEventListener('click', () => {
      form.hidden = true;
      toggle.focus();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      const { status, data } = await api(`/process/${entry.id}/quality`, {
        method: 'POST',
        body: JSON.stringify({ rating: Number(ratingSelect.value), note: noteInput.value.trim() }),
      });
      saveBtn.disabled = false;
      if (status === 200 && data && data.success) {
        toast('Đã lưu đánh giá chất lượng.', 'success');
        if (typeof opts.onRated === 'function') await opts.onRated();
      } else {
        toast((data && data.error) || 'Không lưu được đánh giá', 'error');
      }
    });

    block.append(toggle, form);
  }

  return block;
}

/**
 * Một mục nhật ký dạng card trên timeline.
 * opts: { canDelete, onDelete, canRate, onRated, index }
 */
function processEntryEl(entry, opts = {}) {
  const meta = processActivityMeta(entry.activity);
  const article = document.createElement('article');
  article.className = `process-entry activity-${entry.activity}`;
  if (Number.isInteger(opts.index)) article.style.setProperty('--i', String(opts.index));

  const marker = document.createElement('div');
  marker.className = 'process-marker';
  marker.appendChild(processIconEl(entry.activity));

  const card = document.createElement('div');
  card.className = 'process-card';

  const head = document.createElement('div');
  head.className = 'process-entry-head';

  const badge = document.createElement('span');
  badge.className = `process-activity activity-${entry.activity}`;
  badge.append(processIconEl(entry.activity));
  const badgeLabel = document.createElement('span');
  badgeLabel.textContent = meta.label;
  badge.appendChild(badgeLabel);

  const date = document.createElement('time');
  date.className = 'process-entry-date';
  date.dateTime = entry.performedAt || '';
  date.textContent = formatProcessDate(entry.performedAt);

  head.append(badge, date);

  const title = document.createElement('h3');
  title.className = 'process-entry-title';
  title.textContent = entry.title || '';

  card.append(head, title);

  if (entry.method) {
    const method = document.createElement('p');
    method.className = 'process-entry-method';
    const label = document.createElement('strong');
    label.textContent = 'Phương pháp: ';
    method.append(label, document.createTextNode(entry.method));
    card.appendChild(method);
  }

  if (entry.details) {
    const details = document.createElement('p');
    details.className = 'process-entry-details';
    details.textContent = entry.details;
    card.appendChild(details);
  }

  const yieldRow = processYieldEl(entry);
  if (yieldRow) card.appendChild(yieldRow);

  const attachments = (entry.attachments && entry.attachments.length)
    ? entry.attachments
    : (entry.attachmentUrl ? [{ url: entry.attachmentUrl, name: entry.attachmentName || '' }] : []);

  if (attachments.length === 1) {
    card.appendChild(processAttachmentEl(attachments[0]));
  } else if (attachments.length > 1) {
    const grid = document.createElement('div');
    grid.className = 'process-entry-media-grid';
    attachments.forEach((att) => grid.appendChild(processAttachmentEl(att)));
    card.appendChild(grid);
  }

  const quality = processQualityEl(entry, opts);
  if (quality) card.appendChild(quality);

  const foot = document.createElement('div');
  foot.className = 'process-entry-foot';
  const created = document.createElement('span');
  created.className = 'process-entry-created';
  created.textContent = entry.createdAt ? `Cập nhật ${formatTime(entry.createdAt)}` : '';
  foot.appendChild(created);

  if (opts.canDelete && typeof opts.onDelete === 'function') {
    const del = document.createElement('button');
    del.className = 'process-entry-delete';
    del.type = 'button';
    del.textContent = 'Xóa';
    del.addEventListener('click', () => opts.onDelete(entry));
    foot.appendChild(del);
  }

  card.appendChild(foot);
  article.append(marker, card);
  return article;
}

/**
 * Render toàn bộ timeline vào container.
 * opts: { canDelete, onDelete }
 */
function renderProcessTimeline(container, entries, opts = {}) {
  container.innerHTML = '';
  if (!entries || !entries.length) {
    container.appendChild(processEmptyEl());
    return;
  }
  container.appendChild(processSummaryEl(entries));

  const list = document.createElement('div');
  list.className = 'process-list';
  entries.forEach((entry, index) => {
    list.appendChild(processEntryEl(entry, { ...opts, index }));
  });
  container.appendChild(list);
}

/**
 * Drawer trượt từ phải, dùng cho trang User (thêm/xóa) và Admin (xem/xóa).
 * canAdd: hiện form thêm nhật ký. onChanged: callback sau khi thêm/xóa.
 */
function createProcessDrawer({ canAdd = false, canRate = false, canExcel = false, onChanged = null } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'process-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <aside class="process-drawer" role="dialog" aria-modal="true" aria-labelledby="processDrawerTitle">
      <header class="process-drawer-head">
        <div class="process-drawer-heading">
          <p class="process-eyebrow">Nhật ký canh tác</p>
          <h2 id="processDrawerTitle" class="process-drawer-title">Nhật ký</h2>
        </div>
        <button class="drawer-close" id="processDrawerClose" type="button" aria-label="Đóng nhật ký">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="process-drawer-toolbar" hidden>
        <button class="btn-primary process-add-toggle" id="processAddToggle" type="button">Thêm nhật ký</button>
      </div>
      <form class="process-form" id="processForm" hidden>
        <div class="process-form-row">
          <label class="process-field">
            <span>Hoạt động</span>
            <select id="processActivity" required></select>
          </label>
          <label class="process-field">
            <span>Ngày thực hiện</span>
            <input id="processDate" type="date" required>
          </label>
        </div>
        <label class="process-field">
          <span>Tiêu đề</span>
          <input id="processTitle" type="text" maxlength="120" placeholder="Ví dụ: Gieo lúa vụ đông" required>
        </label>
        <label class="process-field">
          <span>Phương pháp</span>
          <input id="processMethod" type="text" maxlength="160" placeholder="Ví dụ: Sạ hàng, tưới nhỏ giọt...">
        </label>
        <label class="process-field">
          <span>Chi tiết</span>
          <textarea id="processDetails" rows="4" maxlength="2000" placeholder="Liều lượng, thời tiết, tình trạng cây trồng..."></textarea>
        </label>
        <div class="process-yield-block" id="processYieldBlock" hidden>
          <p class="process-yield-heading">Năng suất &amp; sản lượng <span>dành cho mục thu hoạch</span></p>
          <div class="process-form-row process-yield-row">
            <label class="process-field">
              <span>Diện tích (ha)</span>
              <input id="processArea" type="number" min="0" max="1000000" step="0.01" placeholder="2">
            </label>
            <label class="process-field">
              <span>Năng suất (tấn/ha)</span>
              <input id="processYield" type="number" min="0" max="100" step="0.01" placeholder="6.5">
            </label>
            <label class="process-field">
              <span>Sản lượng (tấn)</span>
              <input id="processOutput" type="number" min="0" max="10000000" step="0.01" placeholder="13">
            </label>
          </div>
          <p class="process-yield-hint">Sản lượng tự tính = diện tích × năng suất nếu để trống.</p>
        </div>
        <div class="process-attach-row">
          <button class="attach-btn" id="processAttachBtn" type="button" title="Đính kèm ảnh" aria-label="Đính kèm ảnh hoặc tài liệu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <input type="file" id="processAttachInput" hidden multiple accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx">
          <span class="process-attach-chips" id="processAttachChips"></span>
        </div>
        <div class="process-form-actions">
          <button class="btn-primary" id="processSubmitBtn" type="submit">Lưu nhật ký</button>
          <button class="chat-btn" id="processCancelBtn" type="button">Hủy</button>
        </div>
      </form>
      <div class="process-filters" id="processFilters" hidden>
        <div class="process-filter-row">
          <label class="process-filter-field">
            <span>Mùa vụ</span>
            <select id="processFilterSeason">
              <option value="">Tất cả mùa vụ</option>
            </select>
          </label>
          <label class="process-filter-field">
            <span>Hoạt động</span>
            <select id="processFilterActivity">
              <option value="">Tất cả hoạt động</option>
            </select>
          </label>
          <label class="process-filter-field">
            <span>Từ ngày</span>
            <input id="processFilterFrom" type="date">
          </label>
          <label class="process-filter-field">
            <span>Đến ngày</span>
            <input id="processFilterTo" type="date">
          </label>
        </div>
        <div class="process-filter-actions">
          <button class="chat-btn" id="processFilterReset" type="button">Xóa lọc</button>
          <button class="chat-btn process-export-btn" id="processExportBtn" type="button" disabled>Xuất CSV</button>
          <button class="chat-btn process-excel-btn" id="processExcelBtn" type="button" disabled>Xuất Excel</button>
          <span class="process-filter-note" id="processFilterNote"></span>
        </div>
      </div>
      <div class="process-drawer-body">
        <div class="process-timeline" id="processTimeline"></div>
      </div>
    </aside>
  `;
  document.body.appendChild(overlay);

  const titleEl = overlay.querySelector('#processDrawerTitle');
  const toolbar = overlay.querySelector('.process-drawer-toolbar');
  const addToggle = overlay.querySelector('#processAddToggle');
  const form = overlay.querySelector('#processForm');
  const activitySelect = overlay.querySelector('#processActivity');
  const dateInput = overlay.querySelector('#processDate');
  const titleInput = overlay.querySelector('#processTitle');
  const methodInput = overlay.querySelector('#processMethod');
  const detailsInput = overlay.querySelector('#processDetails');
  const yieldBlock = overlay.querySelector('#processYieldBlock');
  const areaInput = overlay.querySelector('#processArea');
  const yieldInput = overlay.querySelector('#processYield');
  const outputInput = overlay.querySelector('#processOutput');
  const timelineEl = overlay.querySelector('#processTimeline');
  const closeBtn = overlay.querySelector('#processDrawerClose');
  const cancelBtn = overlay.querySelector('#processCancelBtn');
  const submitBtn = overlay.querySelector('#processSubmitBtn');
  const attachBtn = overlay.querySelector('#processAttachBtn');
  const attachInput = overlay.querySelector('#processAttachInput');
  const attachChipsEl = overlay.querySelector('#processAttachChips');
  const filtersEl = overlay.querySelector('#processFilters');
  const filterSeason = overlay.querySelector('#processFilterSeason');
  const filterActivity = overlay.querySelector('#processFilterActivity');
  const filterFrom = overlay.querySelector('#processFilterFrom');
  const filterTo = overlay.querySelector('#processFilterTo');
  const filterReset = overlay.querySelector('#processFilterReset');
  const filterNote = overlay.querySelector('#processFilterNote');
  const exportBtn = overlay.querySelector('#processExportBtn');
  const excelBtn = overlay.querySelector('#processExcelBtn');
  if (!canExcel) excelBtn.hidden = true; // khách hàng chỉ xuất CSV

  for (const season of PROCESS_SEASONS) {
    const option = document.createElement('option');
    option.value = season.key;
    option.textContent = season.label;
    filterSeason.appendChild(option);
  }

  for (const activity of PROCESS_ACTIVITIES) {
    const option = document.createElement('option');
    option.value = activity.key;
    option.textContent = activity.label;
    activitySelect.appendChild(option);

    const filterOption = document.createElement('option');
    filterOption.value = activity.key;
    filterOption.textContent = activity.label;
    filterActivity.appendChild(filterOption);
  }

  let userId = null;
  let pendingAttachments = [];
  let allEntries = [];
  let currentName = '';
  let outputAuto = false;

  const PROCESS_ATTACH_MAX = 5;

  function syncYieldVisibility() {
    yieldBlock.hidden = activitySelect.value !== 'harvest';
  }

  // Sản lượng = diện tích × năng suất khi người dùng chưa tự sửa ô sản lượng
  function autoCalcOutput() {
    if (outputInput.value && !outputAuto) return;
    const area = Number(areaInput.value);
    const yieldNum = Number(yieldInput.value);
    if (area > 0 && yieldNum > 0) {
      outputInput.value = String(Math.round(area * yieldNum * 100) / 100);
      outputAuto = true;
    } else if (outputAuto) {
      outputInput.value = '';
      outputAuto = false;
    }
  }

  if (canAdd) {
    toolbar.hidden = false;
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', async () => {
      const files = Array.from(attachInput.files || []);
      attachInput.value = '';
      for (const file of files) {
        if (pendingAttachments.length >= PROCESS_ATTACH_MAX) {
          toast(`Tối đa ${PROCESS_ATTACH_MAX} tệp đính kèm mỗi mục nhật ký.`, 'warn');
          break;
        }
        try {
          const res = await uploadFile(file);
          pendingAttachments.push(res);
          renderAttachChips();
        } catch (e) {
          toast(e.message, 'error');
        }
      }
    });
  } else {
    toolbar.remove();
    form.remove();
  }

  function renderAttachChips() {
    attachChipsEl.innerHTML = '';
    pendingAttachments.forEach((item, index) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip process-attach-chip';
      chip.append(document.createTextNode(item.name || 'tệp'));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attach-chip-remove';
      remove.setAttribute('aria-label', `Gỡ ${item.name || 'tệp'}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        pendingAttachments.splice(index, 1);
        renderAttachChips();
      });
      chip.appendChild(remove);
      attachChipsEl.appendChild(chip);
    });
  }

  function resetForm() {
    form.reset();
    dateInput.value = todayIsoDate();
    activitySelect.value = 'sowing';
    pendingAttachments = [];
    outputAuto = false;
    renderAttachChips();
    syncYieldVisibility();
  }

  activitySelect.addEventListener('change', syncYieldVisibility);
  areaInput.addEventListener('input', autoCalcOutput);
  yieldInput.addEventListener('input', autoCalcOutput);
  outputInput.addEventListener('input', () => { outputAuto = false; });

  function close() {
    overlay.hidden = true;
    overlay.classList.remove('open');
    document.body.classList.remove('drawer-open');
  }

  function clearFilterInputs() {
    filterSeason.value = '';
    filterActivity.value = '';
    filterFrom.value = '';
    filterTo.value = '';
    filterNote.textContent = '';
    exportBtn.disabled = true;
    excelBtn.disabled = true;
  }

  function filteredEntries() {
    return allEntries.filter((entry) => {
      if (filterSeason.value) {
        const season = processSeasonOf(entry.performedAt);
        if (!season || season.key !== filterSeason.value) return false;
      }
      if (filterActivity.value && entry.activity !== filterActivity.value) return false;
      if (filterFrom.value && (entry.performedAt || '') < filterFrom.value) return false;
      if (filterTo.value && (entry.performedAt || '') > filterTo.value) return false;
      return true;
    });
  }

  function renderFiltered() {
    const activeFilter = filterSeason.value || filterActivity.value || filterFrom.value || filterTo.value;
    const entries = filteredEntries();
    filtersEl.hidden = !allEntries.length;
    filterNote.textContent = activeFilter ? `Hiển thị ${entries.length}/${allEntries.length} mục` : '';
    exportBtn.disabled = !entries.length;
    exportBtn.title = entries.length
      ? `Xuất ${entries.length} mục nhật ký ra CSV`
      : 'Không có mục để xuất';
    excelBtn.disabled = !entries.length;
    excelBtn.title = entries.length
      ? `Xuất ${entries.length} mục nhật ký ra Excel (kèm tổng hợp)`
      : 'Không có mục để xuất';

    if (allEntries.length && !entries.length) {
      timelineEl.innerHTML = '';
      const empty = processEmptyEl();
      empty.classList.add('process-empty-filtered');
      const heading = empty.querySelector('h3');
      const desc = empty.querySelector('p');
      if (heading) heading.textContent = 'Không có mục nào khớp bộ lọc';
      if (desc) desc.textContent = 'Thử chọn mùa vụ/hoạt động khác hoặc xóa khoảng ngày để xem toàn bộ nhật ký.';
      timelineEl.appendChild(empty);
      return;
    }

    renderProcessTimeline(timelineEl, entries, {
      canDelete: true,
      onDelete: deleteEntry,
      canRate,
      onRated: async () => {
        await refresh();
        if (onChanged) onChanged();
      },
    });
  }

  function resetFilters() {
    clearFilterInputs();
    renderFiltered();
  }

  function csvCell(value) {
    let text = value == null ? '' : String(value);
    // Chặn CSV formula injection khi mở file bằng Excel
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function slugify(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
  }

  function exportCsv() {
    const entries = filteredEntries();
    if (!entries.length) return;

    const rows = [[
      'Hoạt động', 'Ngày thực hiện', 'Tiêu đề', 'Phương pháp', 'Chi tiết',
      'Diện tích (ha)', 'Năng suất (tấn/ha)', 'Sản lượng (tấn)',
      'Chất lượng (1-5)', 'Nhận xét chất lượng', 'Tệp đính kèm',
    ]];
    for (const entry of entries) {
      const attachmentUrls = (entry.attachments && entry.attachments.length)
        ? entry.attachments
        : (entry.attachmentUrl ? [{ url: entry.attachmentUrl }] : []);
      rows.push([
        processActivityMeta(entry.activity).label,
        entry.performedAt || '',
        entry.title || '',
        entry.method || '',
        entry.details || '',
        entry.areaHa ?? '',
        entry.yieldPerHa ?? '',
        entry.outputTons ?? '',
        entry.qualityRating ?? '',
        entry.qualityNote || '',
        attachmentUrls.map((a) => new URL(a.url, location.origin).href).join('; '),
      ]);
    }
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    // BOM để Excel nhận đúng UTF-8 (tiếng Việt có dấu)
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nhat-ky-${slugify(currentName) || 'khach'}-${todayIsoDate()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Đã xuất ${entries.length} mục nhật ký ra CSV.`, 'success');
  }

  async function exportExcel() {
    const entries = filteredEntries();
    if (!entries.length || !userId) return;
    const params = new URLSearchParams({ userId });
    if (filterSeason.value) params.set('season', filterSeason.value);
    if (filterActivity.value) params.set('activity', filterActivity.value);
    if (filterFrom.value) params.set('from', filterFrom.value);
    if (filterTo.value) params.set('to', filterTo.value);
    try {
      await downloadFile(`/process/export?${params.toString()}`, 'nhat-ky.xlsx');
      toast(`Đã xuất ${entries.length} mục nhật ký ra Excel.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function refresh() {
    if (!userId) return;
    const { data } = await api(`/process?userId=${userId}`);
    if (!data || !data.success) {
      allEntries = [];
      filtersEl.hidden = true;
      filterNote.textContent = '';
      exportBtn.disabled = true;
      excelBtn.disabled = true;
      timelineEl.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'process-empty';
      const p = document.createElement('p');
      p.textContent = (data && data.error) || 'Không tải được nhật ký canh tác.';
      err.appendChild(p);
      timelineEl.appendChild(err);
      return;
    }
    allEntries = data.entries || [];
    renderFiltered();
  }

  async function deleteEntry(entry) {
    if (!confirm('Xóa mục nhật ký này?')) return;
    const { data } = await api(`/process/${entry.id}`, { method: 'DELETE' });
    if (data && data.success) {
      toast('Đã xóa mục nhật ký.', 'success');
      await refresh();
      if (onChanged) onChanged();
    } else {
      toast((data && data.error) || 'Không xóa được mục nhật ký', 'error');
    }
  }

  async function open(targetUserId, displayName) {
    userId = targetUserId;
    currentName = displayName || '';
    allEntries = [];
    clearFilterInputs();
    filtersEl.hidden = true;
    titleEl.textContent = displayName ? `Nhật ký của ${displayName}` : 'Nhật ký canh tác';
    if (canAdd) {
      resetForm();
      form.hidden = true;
      addToggle.hidden = false;
    }
    overlay.hidden = false;
    document.body.classList.add('drawer-open');
    requestAnimationFrame(() => overlay.classList.add('open'));
    timelineEl.innerHTML = '<div class="process-loading">Đang tải nhật ký canh tác...</div>';
    await refresh();
    closeBtn.focus();
  }

  addToggle.addEventListener('click', () => {
    form.hidden = false;
    addToggle.hidden = true;
    dateInput.value = todayIsoDate();
    syncYieldVisibility();
    titleInput.focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  cancelBtn.addEventListener('click', () => {
    resetForm();
    form.hidden = true;
    addToggle.hidden = false;
  });

  for (const el of [filterSeason, filterActivity, filterFrom, filterTo]) {
    el.addEventListener('input', renderFiltered);
    el.addEventListener('change', renderFiltered);
  }
  filterReset.addEventListener('click', resetFilters);
  exportBtn.addEventListener('click', exportCsv);
  excelBtn.addEventListener('click', exportExcel);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!userId) return;
    const body = {
      activity: activitySelect.value,
      performed_at: dateInput.value,
      title: titleInput.value.trim(),
      method: methodInput.value.trim(),
      details: detailsInput.value.trim(),
    };
    if (activitySelect.value === 'harvest') {
      if (areaInput.value !== '') body.area_ha = Number(areaInput.value);
      if (yieldInput.value !== '') body.yield_per_ha = Number(yieldInput.value);
      if (outputInput.value !== '') body.output_tons = Number(outputInput.value);
    }
    if (pendingAttachments.length) body.attachments = pendingAttachments;

    submitBtn.disabled = true;
    const { status, data } = await api('/process', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    submitBtn.disabled = false;

    if (status === 201) {
      toast('Đã thêm nhật ký canh tác.', 'success');
      resetForm();
      form.hidden = true;
      addToggle.hidden = false;
      clearFilterInputs();
      await refresh();
      if (onChanged) onChanged();
    } else {
      toast((data && data.error) || 'Không thêm được nhật ký', 'error');
    }
  });

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return {
    open,
    close,
    refresh,
    isOpenFor(id) {
      return !overlay.hidden && userId === id;
    },
  };
}
