// Trang Partner: nhật ký canh tác + 2 luồng chat riêng (với khách hàng và với admin)
document.addEventListener('DOMContentLoaded', async () => {
  const me = await api('/me');
  if (!me.data || !me.data.success || me.data.user.role !== 'partner') {
    window.location.href = '/';
    return;
  }
  const myUser = me.data.user;
  document.getElementById('partnerName').textContent = myUser.display_name;
  wireLogout('logoutBtn');

  const listEl = document.getElementById('partnerList');
  const messagesEl = document.getElementById('partnerMessages');
  const noPartnerMsg = document.getElementById('noPartnerMsg');
  const processTimeline = document.getElementById('processTimeline');
  const processPane = document.getElementById('processPane');
  const chatPane = document.getElementById('chatPane');
  const tabs = document.getElementById('viewTabs');
  const tabButtons = [...tabs.querySelectorAll('.view-tab')];
  const chatTitle = document.getElementById('partnerChatTitle');
  const chatMeta = document.getElementById('partnerChatMeta');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const attachChip = document.getElementById('attachChip');

  let selectedCustomer = null;
  let activeView = 'process'; // 'process' | 'customer' | 'admin'
  let activeConvId = null;
  let pendingFile = null;
  let processTimer = null;
  let socket = null;
  let voice = null; // bộ ghi âm tin nhắn thoại
  const convOwners = new Map(); // convId → { userId, view } để định tuyến tin nhắn/số đếm

  let seenWatermark = 0; // mốc "bên kia đã đọc" của luồng đang mở (nhãn Đã xem)
  const pager = createHistoryPager(
    messagesEl,
    document.getElementById('loadMoreBtn'),
    (msg) => messageEl(msg, msg.senderId === myUser.id),
    () => applySeenStatus(messagesEl, seenWatermark, 'partner')
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
  const typingView = createTypingView(messagesEl, scrollBottom);
  const pendingSends = new Map();

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function tabFor(view) {
    return tabButtons.find((btn) => btn.dataset.view === view);
  }

  function markTabNew(view) {
    if (view === activeView) return;
    const tab = tabFor(view);
    if (tab) tab.classList.add('has-new');
  }

  async function loadProcess() {
    if (!selectedCustomer) return;
    const requestedUserId = selectedCustomer.user_id;
    if (!processTimeline.dataset.ready) {
      processTimeline.innerHTML = '<div class="process-loading">Đang tải nhật ký canh tác...</div>';
    }
    const { data } = await api(`/process?userId=${requestedUserId}`);
    if (!selectedCustomer || requestedUserId !== selectedCustomer.user_id) return;
    if (data && data.success) {
      renderProcessTimeline(processTimeline, data.entries, {});
      processTimeline.dataset.ready = '1';
    } else {
      processTimeline.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'process-empty';
      const p = document.createElement('p');
      p.textContent = (data && data.error) || 'Không tải được nhật ký canh tác.';
      err.appendChild(p);
      processTimeline.appendChild(err);
    }
  }

  async function openChat(view) {
    if (!selectedCustomer) return;
    const convId = view === 'customer'
      ? selectedCustomer.user_conversation_id
      : selectedCustomer.admin_conversation_id;
    if (!convId) return;
    activeConvId = convId;
    const tab = tabFor(view);
    if (tab) tab.classList.remove('has-new');
    unreadTitle.clear(`conv:${convId}`);
    msgInput.placeholder = view === 'customer'
      ? `Nhắn riêng cho ${selectedCustomer.user_name}...`
      : 'Nhắn riêng cho admin...';
    typingView.hide();
    pendingSends.clear();
    voice?.cancel();
    chatSearch.reset();
    if (socket) socket.emit('join', { convId });
    const data = await pager.open(convId);
    if (activeConvId === convId) {
      // Trong partner_user partner đóng vai admin-side; partner_admin là user-side
      const myUserSide = view === 'admin';
      seenWatermark = data && data.conversation
        ? (myUserSide ? data.conversation.admin_last_read_id : data.conversation.user_last_read_id) || 0
        : 0;
      applySeenStatus(messagesEl, seenWatermark, 'partner');
      scrollBottom();
      if (socket) socket.emit('read', { convId });
    }
  }

  async function setView(view) {
    const next = view === 'customer' || view === 'admin' ? view : 'process';
    if (next !== 'process' && !selectedCustomer) return;
    voice?.cancel();
    chatSearch.reset();
    activeView = next;
    for (const btn of tabButtons) {
      const active = btn.dataset.view === activeView;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    }
    processPane.hidden = activeView !== 'process';
    chatPane.hidden = activeView === 'process';
    if (activeView === 'process') {
      await loadProcess();
    } else {
      await openChat(activeView);
    }
  }
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }
  wireTablist('viewTabs', (btn) => setView(btn.dataset.view));
  document.getElementById('refreshProcessBtn').addEventListener('click', () => {
    processTimeline.dataset.ready = '';
    loadProcess();
  });
  document.getElementById('exportProcessBtn').addEventListener('click', async () => {
    if (!selectedCustomer) return;
    try {
      await downloadFile(`/process/export?userId=${selectedCustomer.user_id}`, 'nhat-ky.xlsx');
      toast('Đã xuất nhật ký của khách ra Excel.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  function updateItemCounts(userId, processDelta, messageDelta) {
    const item = listEl.querySelector(`.partner-item[data-user-id="${userId}"]`);
    if (!item) return;
    const processCount = Math.max(0, Number(item.dataset.processCount || 0) + processDelta);
    const messageCount = Math.max(0, Number(item.dataset.messageCount || 0) + messageDelta);
    item.dataset.processCount = String(processCount);
    item.dataset.messageCount = String(messageCount);
    const meta = item.querySelector('.partner-item-meta');
    if (meta) meta.textContent = `${processCount} nhật ký · ${messageCount} tin nhắn`;
  }

  async function openCustomer(c, itemEl) {
    selectedCustomer = c;
    document.querySelectorAll('.partner-item').forEach((el) => el.classList.remove('active'));
    if (itemEl) itemEl.classList.add('active');
    chatTitle.textContent = c.user_name;
    chatMeta.textContent = 'Nhật ký canh tác và trò chuyện riêng';
    noPartnerMsg.hidden = true;
    tabs.hidden = false;
    processPane.hidden = activeView !== 'process';
    chatPane.hidden = activeView === 'process';
    activeConvId = null;
    typingView.hide();
    pendingSends.clear();
    voice?.cancel();
    chatSearch.reset();
    processTimeline.dataset.ready = '';

    // Join cả 2 phòng riêng để nhận tin realtime kể cả khi đang xem tab khác
    if (socket) {
      socket.emit('join', { convId: c.user_conversation_id });
      socket.emit('join', { convId: c.admin_conversation_id });
    }
    if (activeView === 'process') await loadProcess();
    else await openChat(activeView);
  }

  // ===== Danh sách khách được gán =====
  const { data } = await api('/partner/conversations');
  let firstCustomer = null;
  if (data && data.success && data.conversations.length) {
    for (const c of data.conversations) {
      convOwners.set(c.user_conversation_id, { userId: c.user_id, view: 'customer' });
      convOwners.set(c.admin_conversation_id, { userId: c.user_id, view: 'admin' });

      const item = document.createElement('div');
      item.className = 'partner-item';
      item.dataset.userId = c.user_id;
      item.dataset.processCount = c.process_count;
      item.dataset.messageCount = c.message_count;

      const info = document.createElement('div');
      info.className = 'partner-item-info';
      const name = document.createElement('div');
      name.className = 'partner-item-name';
      name.textContent = c.user_name;
      const meta = document.createElement('div');
      meta.className = 'partner-item-meta';
      meta.textContent = `${c.process_count} nhật ký · ${c.message_count} tin nhắn`;
      info.append(name, meta);

      item.append(avatarEl(c.user_name, 'user'), info);
      item.addEventListener('click', () => openCustomer(c, item));
      listEl.appendChild(item);
      if (!firstCustomer) firstCustomer = { item, conv: c };
    }
    // Mở sẵn khách đầu tiên để màn hình không trống
    await openCustomer(firstCustomer.conv, firstCustomer.item);
  }

  // ===== Socket =====
  socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  const typing = createTypingSender(socket, () => activeConvId);
  wireConnectionIndicator(socket, document.getElementById('connDot'));

  socket.on('connect', () => {
    if (!selectedCustomer) return;
    socket.emit('join', { convId: selectedCustomer.user_conversation_id });
    socket.emit('join', { convId: selectedCustomer.admin_conversation_id });
  });
  socket.on('message', (msg) => {
    const pending = msg.clientId && pendingSends.get(msg.clientId);
    if (pending) {
      pending.el.remove();
      pendingSends.delete(msg.clientId);
    }
    const owner = convOwners.get(msg.convId);
    if (owner) updateItemCounts(owner.userId, 0, 1);

    if (msg.convId === activeConvId) {
      typingView.hide();
      messagesEl.appendChild(messageEl(msg, msg.senderId === myUser.id));
      scrollBottom();
      // Đang mở luồng → xem được ngay, báo server để bên kia thấy "Đã xem"
      if (msg.senderId !== myUser.id && socket) socket.emit('read', { convId: msg.convId });
      return;
    }
    // Tin đến luồng khác → đếm lên title tab + chấm đỏ/toast nếu là khách đang mở
    if (!owner) return;
    if (msg.senderId !== myUser.id) {
      unreadTitle.bump(`conv:${msg.convId}`);
      playPing();
    }
    if (!selectedCustomer || owner.userId !== selectedCustomer.user_id) return;
    markTabNew(owner.view);
    if (msg.senderId !== myUser.id) toast(`Tin nhắn mới từ ${msg.senderName}`, 'info');
  });
  socket.on('typing', (d) => {
    if (activeView === 'process' || d.convId !== activeConvId || d.userId === myUser.id) return;
    if (d.isTyping) typingView.show();
    else typingView.hide();
  });
  // Bên kia đã đọc luồng đang mở → hiện "Đã xem" cho tin partner đã gửi
  socket.on('read-by', (d) => {
    if (d.convId !== activeConvId) return;
    const myUserSide = activeView === 'admin';
    if (d.userSide === myUserSide) return;
    applySeenStatus(messagesEl, d.seenUpTo, 'partner');
  });
  socket.on('process-updated', (d) => {
    updateItemCounts(d.userId, d.action === 'created' ? 1 : d.action === 'deleted' ? -1 : 0, 0);
    if (!selectedCustomer || d.userId !== selectedCustomer.user_id) return;
    clearTimeout(processTimer);
    processTimer = setTimeout(loadProcess, 250);
    if (d.action === 'created' && activeView !== 'process') {
      toast(`${d.userName} vừa cập nhật nhật ký canh tác.`, 'info');
    }
  });
  socket.on('error', (e) => {
    toast(e.message, 'error');
    failAllPending();
  });

  // ===== Gửi tin + đính kèm =====
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
    if (activeView === 'process' || !activeConvId) return;
    const content = msgInput.value.trim();
    if (!content && !pendingFile) return;
    if (!socket.connected) {
      toast('Chưa kết nối lại được máy chủ, tin chưa được gửi.', 'error');
      return;
    }
    const draft = { content, attachment: pendingFile };
    const clientId = `p${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    const el = messageEl({
      senderId: myUser.id,
      senderName: myUser.display_name,
      senderRole: 'partner',
      content,
      attachmentUrl: pendingFile ? pendingFile.url : null,
      attachmentName: pendingFile ? pendingFile.name : null,
      createdAt: utcNowDb(),
    }, true);
    el.classList.add('pending');
    messagesEl.appendChild(el);
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

  // Ghi âm: dừng là tự gửi vào đúng luồng đã bắt đầu ghi
  voice = wireVoiceRecorder({
    buttonId: 'voiceBtn',
    chipId: 'attachChip',
    canStart: () => activeView !== 'process' && !!activeConvId && !pendingFile,
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
});
