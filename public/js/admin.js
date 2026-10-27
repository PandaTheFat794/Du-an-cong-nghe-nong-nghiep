// Trang Admin: sidebar khách hàng + 2 luồng chat riêng (với khách và với partner được gán)
document.addEventListener('DOMContentLoaded', async () => {
  const me = await api('/me');
  if (!me.data || !me.data.success || me.data.user.role !== 'admin') {
    window.location.href = '/';
    return;
  }
  const myUser = me.data.user;
  document.getElementById('adminName').textContent = myUser.display_name;
  wireLogout('logoutBtn');

  const messagesArea = document.getElementById('messagesArea');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const attachBtn = document.getElementById('attachBtn');
  const voiceBtn = document.getElementById('voiceBtn');
  const chatTitle = document.getElementById('chatTitle');
  const partnerSelect = document.getElementById('partnerSelect');
  const connectPartnerBtn = document.getElementById('connectPartnerBtn');
  const disconnectPartnerBtn = document.getElementById('disconnectPartnerBtn');
  const disconnectOverlay = document.getElementById('disconnectOverlay');
  const disconnectDesc = document.getElementById('disconnectDesc');
  const disconnectCancelBtn = document.getElementById('disconnectCancelBtn');
  const disconnectConfirmBtn = document.getElementById('disconnectConfirmBtn');
  const partnerChip = document.getElementById('partnerChip');
  const partnerChipName = document.getElementById('partnerChipName');
  const botToggleWrap = document.getElementById('botToggleWrap');
  const botToggleInput = document.getElementById('botToggleInput');
  const processBtn = document.getElementById('processBtn');
  const statsBtn = document.getElementById('statsBtn');
  const threadTabs = document.getElementById('threadTabs');
  const partnerThreadTab = document.getElementById('partnerThreadTab');
  const tabButtons = [...threadTabs.querySelectorAll('.view-tab')];

  // Drawer nhật ký canh tác (admin xem + xóa, không thêm thay khách)
  const processDrawer = createProcessDrawer({});
  processBtn.addEventListener('click', () => {
    if (selectedUser) processDrawer.open(selectedUser.id, selectedUser.display_name);
  });

  let seenWatermark = 0; // mốc "bên kia đã đọc" của thread đang mở (nhãn Đã xem)
  const pager = createHistoryPager(
    messagesArea,
    document.getElementById('loadMoreBtn'),
    (msg) => messageEl(msg, msg.senderRole === 'admin'),
    () => applySeenStatus(messagesArea, seenWatermark, myUser.role)
  );

  // Tìm trong lịch sử của thread đang mở; click kết quả → nhảy tới tin đó
  const chatSearch = wireChatSearch({
    toggleBtn: document.getElementById('searchToggleBtn'),
    panel: document.getElementById('chatSearch'),
    input: document.getElementById('chatSearchInput'),
    results: document.getElementById('chatSearchResults'),
    closeBtn: document.getElementById('chatSearchClose'),
    getConvId: () => activeConvId,
    onJump: (id) => pager.jumpAround(id),
  });

  let selectedUser = null; // row mới nhất từ /admin/users
  let activeThread = 'user'; // 'user' | 'partner'
  let activeConvId = null;
  let partners = [];
  let pendingFile = null;
  let voice = null; // bộ ghi âm tin nhắn thoại
  let usersReloadTimer = null;
  let processReloadTimer = null;

  function scrollBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  // ===== Sidebar =====
  const userListEl = document.getElementById('adminUserList');
  const searchInput = document.getElementById('adminSearch');
  let latestUsers = [];
  let searchQuery = '';

  function renderOverview(users) {
    document.getElementById('statCustomers').textContent = users.length;
    document.getElementById('statUnread').textContent = users.reduce((sum, u) => sum + (u.unread_count || 0), 0);
    document.getElementById('statPartnerUnread').textContent = users.reduce((sum, u) => sum + (u.partner_unread || 0), 0);
    document.getElementById('statProcess').textContent = users.reduce((sum, u) => sum + (u.process_count || 0), 0);
    // Đồng bộ tổng tin chưa đọc lên title tab
    unreadTitle.setAll(
      users.reduce((sum, u) => sum + (u.unread_count || 0) + (u.partner_unread || 0), 0)
    );
  }

  function renderUserList() {
    const list = userListEl;
    const prevScroll = list.scrollTop;
    const q = searchQuery.trim().toLowerCase();
    const users = q
      ? latestUsers.filter((u) => String(u.display_name || '').toLowerCase().includes(q)
        || String(u.username || '').toLowerCase().includes(q))
      : latestUsers;

    list.innerHTML = '';
    if (!users.length) {
      const empty = document.createElement('div');
      empty.className = 'no-partner';
      empty.textContent = latestUsers.length ? 'Không tìm thấy khách hàng phù hợp' : 'Chưa có khách hàng nào';
      list.appendChild(empty);
    }
    for (const u of users) {
      const item = document.createElement('div');
      item.className = 'user-item' + (selectedUser && u.id === selectedUser.id ? ' active' : '');
      item.dataset.convId = u.conversation_id;
      item.dataset.userId = u.id;

      const info = document.createElement('div');
      info.className = 'user-info';
      const meta = document.createElement('div');
      meta.className = 'user-meta';
      const name = document.createElement('div');
      name.className = 'user-name';
      name.textContent = u.display_name;
      const last = document.createElement('div');
      last.className = 'user-last-msg';
      last.textContent = u.last_message;
      meta.append(name, last);
      if (u.process_count > 0) {
        const activity = document.createElement('span');
        activity.className = 'user-process-count';
        activity.textContent = `${u.process_count} nhật ký canh tác`;
        meta.appendChild(activity);
      }
      info.append(avatarEl(u.display_name, 'user'), meta);

      const badge = document.createElement('span');
      badge.className = 'user-unread';
      badge.id = `unread-${u.conversation_id}`;
      badge.textContent = u.unread_count;
      badge.title = 'Tin nhắn chưa đọc từ khách hàng';
      badge.hidden = !u.unread_count;

      const partnerBadge = document.createElement('span');
      partnerBadge.className = 'user-unread partner';
      partnerBadge.id = `partner-unread-${u.id}`;
      partnerBadge.textContent = u.partner_unread;
      partnerBadge.title = 'Tin nhắn chưa đọc từ partner';
      partnerBadge.hidden = !u.partner_unread;

      const actions = document.createElement('div');
      actions.className = 'user-actions';
      const del = document.createElement('button');
      del.className = 'user-delete';
      del.type = 'button';
      del.textContent = 'Xóa';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteUser(u);
      });
      actions.append(badge, partnerBadge, del);

      item.append(info, actions);
      item.addEventListener('click', () => selectUser(u));
      list.appendChild(item);
    }
    list.scrollTop = prevScroll;
    if (selectedUser) updateThreadTabs();
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderUserList();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchQuery = '';
      renderUserList();
    }
  });

  async function loadUsers() {
    const { data } = await api('/admin/users');
    if (!data || !data.success) return;

    if (selectedUser) {
      const fresh = data.users.find((u) => u.id === selectedUser.id);
      if (!fresh) {
        resetChatArea();
      } else {
        Object.assign(selectedUser, fresh);
      }
    }

    latestUsers = data.users;
    renderOverview(latestUsers);
    renderUserList();
  }

  async function deleteUser(u) {
    if (!confirm(`Xóa tài khoản "${u.display_name}" (${u.username})? Toàn bộ lịch sử chat sẽ mất.`)) return;
    const { data } = await api(`/admin/users/${u.id}`, { method: 'DELETE' });
    if (data && data.success) {
      latestUsers = latestUsers.filter((x) => x.id !== u.id);
      renderOverview(latestUsers);
      renderUserList();
      if (selectedUser && selectedUser.id === u.id) resetChatArea();
      if (processDrawer.isOpenFor(u.id)) processDrawer.close();
      toast(`Đã xóa tài khoản ${u.display_name}`, 'success');
    } else {
      toast((data && data.error) || 'Không xóa được tài khoản', 'error');
    }
  }

  function resetChatArea() {
    selectedUser = null;
    activeThread = 'user';
    activeConvId = null;
    typingView.hide();
    pendingSends.clear();
    botStreams.clear();
    voice?.cancel();
    pager.reset();
    chatSearch.reset();
    chatTitle.textContent = 'Chọn một khách hàng để tư vấn';
    [msgInput, sendBtn, attachBtn, voiceBtn].forEach((el) => { el.disabled = true; });
    partnerSelect.hidden = true;
    connectPartnerBtn.hidden = true;
    disconnectPartnerBtn.hidden = true;
    partnerChip.hidden = true;
    botToggleWrap.hidden = true;
    processBtn.hidden = true;
    threadTabs.hidden = true;
    partnerThreadTab.hidden = true;
    messagesArea.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'no-partner';
    hint.textContent = 'Chưa chọn cuộc trò chuyện';
    messagesArea.appendChild(hint);
  }

  function setUserBadge(convId, count) {
    const badge = document.getElementById(`unread-${convId}`);
    if (badge) {
      badge.textContent = count;
      badge.hidden = !count;
    }
  }

  function setPartnerBadge(userId, count) {
    const badge = document.getElementById(`partner-unread-${userId}`);
    if (badge) {
      badge.textContent = count;
      badge.hidden = !count;
    }
  }

  // ===== Chọn khách hàng + luồng chat =====
  function updateThreadTabs() {
    const hasPartnerThread = !!(selectedUser && selectedUser.partner_conversation_id);
    threadTabs.hidden = !selectedUser;
    partnerThreadTab.hidden = !hasPartnerThread;
    if (hasPartnerThread) {
      partnerThreadTab.textContent = `Partner: ${selectedUser.partner_name || ''}`;
      partnerThreadTab.title = `Trò chuyện riêng với ${selectedUser.partner_name || 'partner'}`;
    }
    if (!hasPartnerThread && activeThread === 'partner') activeThread = 'user';
    for (const btn of tabButtons) {
      const active = btn.dataset.thread === activeThread;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    }
  }

  async function openThread(threadKey) {
    if (!selectedUser) return;
    const convId = threadKey === 'partner'
      ? selectedUser.partner_conversation_id
      : selectedUser.conversation_id;
    if (!convId) return;

    activeThread = threadKey;
    activeConvId = convId;
    updateThreadTabs();
    const isPartnerThread = threadKey === 'partner';
    chatTitle.textContent = isPartnerThread
      ? `Partner: ${selectedUser.partner_name || ''}`
      : selectedUser.display_name;
    msgInput.placeholder = isPartnerThread
      ? 'Nhắn riêng cho partner...'
      : `Nhắn cho ${selectedUser.display_name}...`;
    typingView.hide();
    pendingSends.clear();
    botStreams.clear();
    voice?.cancel();
    chatSearch.reset();

    socket.emit('join', { convId });
    const data = await pager.open(convId);
    if (activeConvId !== convId) return; // đã chuyển luồng khác trong lúc chờ
    scrollBottom();
    if (data && data.conversation) {
      seenWatermark = data.conversation.user_last_read_id || 0;
      applySeenStatus(messagesArea, seenWatermark, myUser.role);
    }
    if (data && data.conversation.kind === 'user_admin') {
      selectedUser.partner_id = data.conversation.partner_id;
      selectedUser.partner_name = data.conversation.partner_name;
      renderPartnerControl(selectedUser.partner_id, selectedUser.partner_name);
      updateThreadTabs();
    }

    // Admin mở luồng → đánh dấu đã đọc (server bắn badge-cleared/partner-badge-cleared)
    socket.emit('read', { convId });
  }

  async function selectUser(u) {
    const sameUser = selectedUser && selectedUser.id === u.id;
    selectedUser = { ...u };
    if (!sameUser) activeThread = 'user';
    if (activeThread === 'partner' && !selectedUser.partner_conversation_id) activeThread = 'user';

    document.querySelectorAll('.user-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.userId) === u.id);
    });
    [msgInput, sendBtn, attachBtn, voiceBtn].forEach((el) => { el.disabled = false; });
    partnerSelect.hidden = false;
    connectPartnerBtn.hidden = false;
    processBtn.hidden = false;
    botToggleWrap.hidden = false;
    botToggleInput.checked = selectedUser.bot_enabled !== false;
    renderPartnerControl(selectedUser.partner_id, selectedUser.partner_name);
    updateThreadTabs();
    await openThread(activeThread);
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => openThread(btn.dataset.thread));
  }
  wireTablist('threadTabs', (btn) => openThread(btn.dataset.thread));

  // ===== Gán Partner =====
  async function loadPartners() {
    const { data } = await api('/admin/partners');
    if (data && data.success) partners = data.partners;
  }

  function renderPartnerControl(assignedId, assignedName) {
    const connected = !!assignedId;
    partnerChip.hidden = !connected;
    disconnectPartnerBtn.hidden = !connected;
    partnerChipName.textContent = assignedName ? `Đã kết nối: ${assignedName}` : 'Đã kết nối';
    partnerSelect.hidden = connected;
    connectPartnerBtn.hidden = connected;
    partnerSelect.innerHTML = '';
    if (!connected) {
      for (const p of partners) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.display_name;
        partnerSelect.appendChild(opt);
      }
      connectPartnerBtn.disabled = !partnerSelect.options.length;
    }
  }

  connectPartnerBtn.addEventListener('click', async () => {
    if (!selectedUser || !partnerSelect.value) return;
    const chosenId = Number(partnerSelect.value);
    const { data } = await api(`/admin/conversations/${selectedUser.conversation_id}/connect`, {
      method: 'POST',
      body: JSON.stringify({ partner_id: chosenId }),
    });
    if (data && data.success) {
      const chosen = partners.find((p) => p.id === data.partnerId);
      selectedUser.partner_id = data.partnerId;
      selectedUser.partner_name = chosen ? chosen.display_name : '';
      selectedUser.partner_conversation_id = data.partnerConversationId;
      toast('Đã kết nối Partner cho khách hàng này.', 'success');
      await loadUsers();
      renderPartnerControl(selectedUser.partner_id, selectedUser.partner_name);
      updateThreadTabs();
      await openThread(activeThread);
    } else {
      toast((data && data.error) || 'Không gán được Partner', 'error');
    }
  });

  // Hộp thoại xác nhận hủy liên kết (thay confirm() mặc định của trình duyệt)
  function openDisconnectDialog() {
    if (!selectedUser || !selectedUser.partner_id) return;
    disconnectDesc.textContent = `Partner "${selectedUser.partner_name || ''}" sẽ mất quyền xem nhật ký canh tác và nhắn tin với "${selectedUser.display_name}". Lịch sử trò chuyện vẫn được giữ lại.`;
    disconnectOverlay.hidden = false;
    disconnectCancelBtn.focus();
  }
  function closeDisconnectDialog(restoreFocus = true) {
    disconnectOverlay.hidden = true;
    if (restoreFocus && !disconnectPartnerBtn.hidden) disconnectPartnerBtn.focus();
  }
  disconnectPartnerBtn.addEventListener('click', openDisconnectDialog);
  disconnectCancelBtn.addEventListener('click', () => closeDisconnectDialog());
  disconnectOverlay.addEventListener('click', (e) => {
    if (e.target === disconnectOverlay) closeDisconnectDialog();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !disconnectOverlay.hidden) closeDisconnectDialog();
  });
  disconnectConfirmBtn.addEventListener('click', async () => {
    if (!selectedUser || !selectedUser.partner_id) return closeDisconnectDialog();
    disconnectConfirmBtn.disabled = true;
    try {
      const { data } = await api(`/admin/conversations/${selectedUser.conversation_id}/disconnect`, {
        method: 'POST',
      });
      if (data && data.success) {
        selectedUser.partner_id = null;
        selectedUser.partner_name = '';
        selectedUser.partner_conversation_id = null;
        if (activeThread === 'partner') activeThread = 'user';
        toast('Đã hủy liên kết Partner.', 'success');
        await loadUsers();
        renderPartnerControl(null, '');
        updateThreadTabs();
        await openThread(activeThread);
        closeDisconnectDialog(false);
        connectPartnerBtn.focus();
      } else {
        toast((data && data.error) || 'Không hủy được liên kết', 'error');
      }
    } finally {
      disconnectConfirmBtn.disabled = false;
    }
  });

  // ===== Bật/tắt Bot chuyên gia cho khách đang chọn =====
  botToggleInput.addEventListener('change', async () => {
    if (!selectedUser) return;
    const enabled = botToggleInput.checked;
    const { data } = await api(`/admin/conversations/${selectedUser.conversation_id}/bot`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    if (data && data.success) {
      selectedUser.bot_enabled = enabled;
      const u = latestUsers.find((x) => x.id === selectedUser.id);
      if (u) u.bot_enabled = enabled;
      toast(enabled ? 'Bot AI đã bật cho khách này.' : 'Bot AI đã tắt cho khách này.', 'success');
    } else {
      botToggleInput.checked = !enabled; // hoàn tác nếu server từ chối
      toast((data && data.error) || 'Không đổi được trạng thái bot', 'error');
    }
  });

  // ===== Thống kê hệ thống =====
  const statsOverlay = document.getElementById('statsOverlay');
  const statsCloseBtn = document.getElementById('statsCloseBtn');
  const ACTIVITY_META = {
    sowing: { label: 'Gieo hạt', color: '#16a34a' },
    fertilizing: { label: 'Bón phân', color: '#b45309' },
    watering: { label: 'Tưới nước', color: '#0284c7' },
    pesticide: { label: 'Phun thuốc', color: '#7c3aed' },
    pruning: { label: 'Tỉa cành', color: '#db2777' },
    harvest: { label: 'Thu hoạch', color: '#ca8a04' },
    other: { label: 'Khác', color: '#64748b' },
  };

  function closeStats() {
    statsOverlay.hidden = true;
    statsBtn.focus();
  }

  function renderBarChart(container, days) {
    container.innerHTML = '';
    const max = Math.max(1, ...days.map((d) => d.count));
    for (const d of days) {
      const col = document.createElement('div');
      col.className = 'bar-col';

      const num = document.createElement('div');
      num.className = 'bar-num';
      num.textContent = d.count;

      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.height = `${Math.round((d.count / max) * 100)}%`;
      fill.title = `${d.date}: ${d.count} tin nhắn`;
      track.appendChild(fill);

      const day = document.createElement('div');
      day.className = 'bar-day';
      day.textContent = d.date.slice(5); // MM-DD

      col.append(num, track, day);
      container.appendChild(col);
    }
  }

  function renderDonut(activities) {
    const donut = document.getElementById('donutChart');
    const legend = document.getElementById('donutLegend');
    const total = activities.reduce((s, a) => s + a.count, 0);
    legend.innerHTML = '';
    if (!total) {
      donut.style.setProperty('--donut-grad', '#e2e8f0 0 100%');
      donut.dataset.total = '0';
      const li = document.createElement('li');
      li.textContent = 'Chưa có mục nhật ký nào';
      legend.appendChild(li);
      return;
    }
    donut.dataset.total = total;
    let cursor = 0;
    const segments = activities.map((a) => {
      const meta = ACTIVITY_META[a.activity] || ACTIVITY_META.other;
      const start = cursor;
      cursor += (a.count / total) * 100;
      return { meta, start, end: cursor, count: a.count };
    });
    donut.style.setProperty(
      '--donut-grad',
      segments.map((s) => `${s.meta.color} ${s.start}% ${s.end}%`).join(', ')
    );
    for (const s of segments) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = s.meta.color;
      const name = document.createElement('span');
      name.textContent = s.meta.label;
      const n = document.createElement('span');
      n.className = 'legend-num';
      n.textContent = s.count;
      li.append(dot, name, n);
      legend.appendChild(li);
    }
  }

  function renderTopCustomers(container, rows) {
    container.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'top-empty';
      empty.textContent = 'Chưa có khách hàng nhắn tin';
      container.appendChild(empty);
      return;
    }
    rows.forEach((r, i) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'top-rank';
      rank.textContent = i + 1;
      const name = document.createElement('span');
      name.className = 'top-name';
      name.textContent = r.display_name;
      name.title = r.display_name;
      const count = document.createElement('span');
      count.className = 'top-count';
      count.textContent = `${r.message_count} tin`;
      li.append(rank, name, count);
      container.appendChild(li);
    });
  }

  let statsDays = 7;

  async function loadStats() {
    const { data } = await api(`/admin/stats?days=${statsDays}`);
    if (!data || !data.success) {
      toast((data && data.error) || 'Không tải được thống kê', 'error');
      return;
    }
    document.getElementById('kpiCustomers').textContent = data.totals.customers;
    document.getElementById('kpiMessages').textContent = data.totals.messages;
    document.getElementById('kpiProcess').textContent = data.totals.processEntries;
    document.getElementById('kpiPartners').textContent = data.totals.partners;
    document.getElementById('kpiMessagesLabel').textContent = `Tin nhắn (${data.days} ngày)`;
    document.getElementById('kpiProcessLabel').textContent = `Mục nhật ký (${data.days} ngày)`;
    document.getElementById('barChartTitle').textContent = `Tin nhắn ${data.days} ngày gần nhất`;
    document.querySelectorAll('.stats-range-btn').forEach((btn) => {
      btn.classList.toggle('is-active', Number(btn.dataset.statsDays) === data.days);
    });
    renderBarChart(document.getElementById('barChart'), data.messagesByDay);
    renderDonut(data.processByActivity);
    renderTopCustomers(document.getElementById('topCustomers'), data.topCustomers);
  }

  document.querySelectorAll('.stats-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = Number(btn.dataset.statsDays);
      if (days === statsDays) return;
      statsDays = days;
      loadStats();
    });
  });

  statsBtn.addEventListener('click', async () => {
    statsOverlay.hidden = false;
    statsCloseBtn.focus();
    await loadStats();
  });
  statsCloseBtn.addEventListener('click', closeStats);
  statsOverlay.addEventListener('click', (e) => {
    if (e.target === statsOverlay) closeStats();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !statsOverlay.hidden) closeStats();
  });

  // ===== Socket =====
  const socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  const typing = createTypingSender(socket, () => activeConvId);
  const typingView = createTypingView(messagesArea, scrollBottom);
  const pendingSends = new Map(); // clientId → bubble "đang gửi" chờ server xác nhận
  const botStreams = new Map(); // clientId → bubble bot đang trả lời (stream)
  wireConnectionIndicator(socket, document.getElementById('connDot'));

  socket.on('connect', () => {
    if (activeConvId) socket.emit('join', { convId: activeConvId });
  });
  socket.on('message', (msg) => {
    const pending = msg.clientId && pendingSends.get(msg.clientId);
    if (pending) {
      pending.el.remove();
      pendingSends.delete(msg.clientId);
    }
    const stream = msg.clientId && botStreams.get(msg.clientId);
    if (stream) {
      stream.el.remove(); // bot trả lời xong → thay bubble stream bằng tin thật
      botStreams.delete(msg.clientId);
    }
    if (msg.convId !== activeConvId) return;
    typingView.hide();
    messagesArea.appendChild(messageEl(msg, msg.senderRole === 'admin'));
    scrollBottom();
    if (msg.senderId !== myUser.id) socket.emit('read', { convId: msg.convId });
  });
  // Khách/partner đã đọc thread đang mở → hiện "Đã xem" cho tin admin đã gửi
  socket.on('read-by', (d) => {
    if (d.convId !== activeConvId || !d.userSide) return;
    applySeenStatus(messagesArea, d.seenUpTo, myUser.role);
  });
  // Bot chuyên gia đang trả lời khách → bubble stream từng cụm chữ (admin xem ké)
  socket.on('bot-stream', (d) => {
    if (d.convId !== activeConvId) return;
    typingView.hide();
    let stream = botStreams.get(d.clientId);
    if (!stream) {
      stream = botStreamRow('Trợ lý AI');
      botStreams.set(d.clientId, stream);
      messagesArea.appendChild(stream.el);
    }
    if (d.reset) stream.reset();
    else stream.append(d.delta);
    scrollBottom();
  });
  socket.on('typing', (d) => {
    if (d.convId !== activeConvId || d.userId === myUser.id) return;
    if (d.isTyping) typingView.show();
    else typingView.hide();
  });
  socket.on('user-message', () => {
    clearTimeout(usersReloadTimer);
    usersReloadTimer = setTimeout(loadUsers, 400); // debounce khi khách gửi dồn dập
  });
  socket.on('partner-message', () => {
    clearTimeout(usersReloadTimer);
    usersReloadTimer = setTimeout(loadUsers, 400);
  });
  socket.on('bot-unsure', (d) => {
    toast(`🤔 Bot không chắc câu hỏi của ${d.userName || 'khách'} — bạn nên vào trả lời nhé`, 'warn');
    playPing();
  });
  socket.on('unread-badge', ({ convId, count }) => {
    const u = latestUsers.find((x) => x.conversation_id === convId);
    if (u) {
      u.unread_count = count;
      renderOverview(latestUsers);
    }
    if (convId !== activeConvId) {
      setUserBadge(convId, count);
      playPing();
    }
  });
  socket.on('badge-cleared', ({ convId }) => {
    const u = latestUsers.find((x) => x.conversation_id === convId);
    if (u) {
      u.unread_count = 0;
      renderOverview(latestUsers);
    }
    setUserBadge(convId, 0);
  });
  socket.on('partner-badge', ({ convId, userId, count }) => {
    const u = latestUsers.find((x) => x.id === userId);
    if (u) {
      u.partner_unread = count;
      renderOverview(latestUsers);
    }
    if (convId !== activeConvId) {
      setPartnerBadge(userId, count);
      playPing();
    }
  });
  socket.on('partner-badge-cleared', ({ userId }) => {
    const u = latestUsers.find((x) => x.id === userId);
    if (u) {
      u.partner_unread = 0;
      renderOverview(latestUsers);
    }
    setPartnerBadge(userId, 0);
  });
  socket.on('process-updated', (d) => {
    if (selectedUser && d.convId === selectedUser.conversation_id) {
      if (processDrawer.isOpenFor(d.userId)) {
        clearTimeout(processReloadTimer);
        processReloadTimer = setTimeout(() => processDrawer.refresh(), 200);
      }
      if (d.action === 'created') {
        toast(`${d.userName} vừa cập nhật nhật ký canh tác.`, 'info');
      }
    }
    clearTimeout(usersReloadTimer);
    usersReloadTimer = setTimeout(loadUsers, 400);
  });
  socket.on('error', (e) => {
    toast(e.message, 'error');
    failAllPending();
  });

  // ===== Gửi tin + đính kèm =====
  const attachChip = document.getElementById('attachChip');
  wireAttachButton('attachBtn', 'attachInput', 'attachChip', (res) => { pendingFile = res; });

  function failAllPending() {
    for (const p of pendingSends.values()) {
      p.el.remove();
      if (!msgInput.value && p.content) msgInput.value = p.content;
      if (!pendingFile && p.file) {
        pendingFile = p.file;
        attachChip.textContent = `Đang đính kèm: ${p.file.name}`;
      }
    }
    pendingSends.clear();
  }

  function sendMessage() {
    const content = msgInput.value.trim();
    if (!content && !pendingFile) return;
    if (!activeConvId) return;
    if (!socket.connected) {
      toast('Chưa kết nối lại được máy chủ, tin chưa được gửi.', 'error');
      return;
    }
    const draft = { content, attachment: pendingFile };
    const clientId = `m${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    const el = messageEl({
      content,
      attachmentUrl: pendingFile ? pendingFile.url : null,
      attachmentName: pendingFile ? pendingFile.name : null,
      createdAt: utcNowDb(),
    }, true);
    el.classList.add('pending');
    messagesArea.appendChild(el);
    scrollBottom();
    pendingSends.set(clientId, { el, content, file: pendingFile });

    socket.emit('message', { convId: activeConvId, ...draft, clientId });
    msgInput.value = '';
    typing.stop();
    pendingFile = null;
    attachChip.textContent = '';
  }
  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('input', typing.onInput);
  msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  // Ghi âm: dừng là tự gửi vào đúng thread đã bắt đầu ghi
  voice = wireVoiceRecorder({
    buttonId: 'voiceBtn',
    chipId: 'attachChip',
    canStart: () => !!activeConvId && !pendingFile,
    getConvId: () => activeConvId,
    onRecorded: (res, convId) => {
      if (convId !== activeConvId) {
        toast('Đã chuyển cuộc trò chuyện, bản ghi âm không được gửi.', 'info');
        return;
      }
      pendingFile = res;
      attachChip.textContent = `Đang đính kèm: ${res.name}`;
      sendMessage();
    },
  });

  await loadPartners();
  await loadUsers();
});
