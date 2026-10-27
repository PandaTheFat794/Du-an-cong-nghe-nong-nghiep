// Nhật ký canh tác: metadata hoạt động, render timeline và drawer dùng chung.
// Phụ thuộc common.js (api, toast, wireAttachButton, IMAGE_EXT_RE, formatTime).

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

  return summary;
}

/**
 * Một mục nhật ký dạng card trên timeline.
 * opts: { canDelete, onDelete, index }
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

  if (entry.attachmentUrl) {
    const isImage = IMAGE_EXT_RE.test(entry.attachmentName || entry.attachmentUrl);
    if (isImage) {
      const media = document.createElement('figure');
      media.className = 'process-entry-media';
      const link = document.createElement('a');
      link.href = entry.attachmentUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.src = entry.attachmentUrl;
      img.alt = entry.attachmentName || 'Ảnh nhật ký canh tác';
      img.loading = 'lazy';
      img.title = 'Bấm để xem ảnh to';
      img.addEventListener('click', (e) => {
        e.preventDefault(); // xem tại chỗ bằng lightbox; giữ link cho mở tab mới
        openLightbox(entry.attachmentUrl, entry.attachmentName);
      });
      link.appendChild(img);
      media.appendChild(link);
      card.appendChild(media);
    } else {
      const link = document.createElement('a');
      link.className = 'process-entry-file';
      link.href = entry.attachmentUrl;
      link.download = entry.attachmentName || 'tai-lieu';
      link.textContent = `Đính kèm: ${entry.attachmentName || 'tệp'}`;
      card.appendChild(link);
    }
  }

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
function createProcessDrawer({ canAdd = false, onChanged = null } = {}) {
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
        <div class="process-attach-row">
          <button class="attach-btn" id="processAttachBtn" type="button" title="Đính kèm ảnh" aria-label="Đính kèm ảnh hoặc tài liệu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <input type="file" id="processAttachInput" hidden accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx">
          <span class="attach-chip process-attach-chip" id="processAttachChip"></span>
        </div>
        <div class="process-form-actions">
          <button class="btn-primary" id="processSubmitBtn" type="submit">Lưu nhật ký</button>
          <button class="chat-btn" id="processCancelBtn" type="button">Hủy</button>
        </div>
      </form>
      <div class="process-filters" id="processFilters" hidden>
        <div class="process-filter-row">
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
  const timelineEl = overlay.querySelector('#processTimeline');
  const closeBtn = overlay.querySelector('#processDrawerClose');
  const cancelBtn = overlay.querySelector('#processCancelBtn');
  const submitBtn = overlay.querySelector('#processSubmitBtn');
  const attachChip = overlay.querySelector('#processAttachChip');
  const filtersEl = overlay.querySelector('#processFilters');
  const filterActivity = overlay.querySelector('#processFilterActivity');
  const filterFrom = overlay.querySelector('#processFilterFrom');
  const filterTo = overlay.querySelector('#processFilterTo');
  const filterReset = overlay.querySelector('#processFilterReset');
  const filterNote = overlay.querySelector('#processFilterNote');
  const exportBtn = overlay.querySelector('#processExportBtn');

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
  let pendingAttachment = null;
  let allEntries = [];
  let currentName = '';

  if (canAdd) {
    toolbar.hidden = false;
    wireAttachButton('processAttachBtn', 'processAttachInput', 'processAttachChip', (res) => {
      pendingAttachment = res;
    });
  } else {
    toolbar.remove();
    form.remove();
  }

  function resetForm() {
    form.reset();
    dateInput.value = todayIsoDate();
    activitySelect.value = 'sowing';
    pendingAttachment = null;
    attachChip.textContent = '';
  }

  function close() {
    overlay.hidden = true;
    overlay.classList.remove('open');
    document.body.classList.remove('drawer-open');
  }

  function clearFilterInputs() {
    filterActivity.value = '';
    filterFrom.value = '';
    filterTo.value = '';
    filterNote.textContent = '';
    exportBtn.disabled = true;
  }

  function filteredEntries() {
    return allEntries.filter((entry) => {
      if (filterActivity.value && entry.activity !== filterActivity.value) return false;
      if (filterFrom.value && (entry.performedAt || '') < filterFrom.value) return false;
      if (filterTo.value && (entry.performedAt || '') > filterTo.value) return false;
      return true;
    });
  }

  function renderFiltered() {
    const activeFilter = filterActivity.value || filterFrom.value || filterTo.value;
    const entries = filteredEntries();
    filtersEl.hidden = !allEntries.length;
    filterNote.textContent = activeFilter ? `Hiển thị ${entries.length}/${allEntries.length} mục` : '';
    exportBtn.disabled = !entries.length;
    exportBtn.title = entries.length
      ? `Xuất ${entries.length} mục nhật ký ra CSV`
      : 'Không có mục để xuất';

    if (allEntries.length && !entries.length) {
      timelineEl.innerHTML = '';
      const empty = processEmptyEl();
      empty.classList.add('process-empty-filtered');
      const heading = empty.querySelector('h3');
      const desc = empty.querySelector('p');
      if (heading) heading.textContent = 'Không có mục nào khớp bộ lọc';
      if (desc) desc.textContent = 'Thử chọn hoạt động khác hoặc xóa khoảng ngày để xem toàn bộ nhật ký.';
      timelineEl.appendChild(empty);
      return;
    }

    renderProcessTimeline(timelineEl, entries, {
      canDelete: true,
      onDelete: deleteEntry,
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

    const rows = [['Hoạt động', 'Ngày thực hiện', 'Tiêu đề', 'Phương pháp', 'Chi tiết', 'Tệp đính kèm']];
    for (const entry of entries) {
      rows.push([
        processActivityMeta(entry.activity).label,
        entry.performedAt || '',
        entry.title || '',
        entry.method || '',
        entry.details || '',
        entry.attachmentUrl ? new URL(entry.attachmentUrl, location.origin).href : '',
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

  async function refresh() {
    if (!userId) return;
    const { data } = await api(`/process?userId=${userId}`);
    if (!data || !data.success) {
      allEntries = [];
      filtersEl.hidden = true;
      filterNote.textContent = '';
      exportBtn.disabled = true;
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
    titleInput.focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  cancelBtn.addEventListener('click', () => {
    resetForm();
    form.hidden = true;
    addToggle.hidden = false;
  });

  for (const el of [filterActivity, filterFrom, filterTo]) {
    el.addEventListener('input', renderFiltered);
    el.addEventListener('change', renderFiltered);
  }
  filterReset.addEventListener('click', resetFilters);
  exportBtn.addEventListener('click', exportCsv);

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
    if (pendingAttachment) body.attachment = pendingAttachment;

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
