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
  const chatTitle = document.getElementById('chatTitle');
  const partnerSelect = document.getElementById('partnerSelect');
  const connectPartnerBtn = document.getElementById('connectPartnerBtn');
  const processBtn = document.getElementById('processBtn');
  const threadTabs = document.getElementById('threadTabs');
  const partnerThreadTab = document.getElementById('partnerThreadTab');
  const tabButtons = [...threadTabs.querySelectorAll('.view-tab')];

  // Drawer nhật ký canh tác (admin xem + xóa, không thêm thay khách)
  const processDrawer = createProcessDrawer({});
  processBtn.addEventListener('click', () => {
    if (selectedUser) processDrawer.open(selectedUser.id, selectedUser.display_name);
  });

  const pager = createHistoryPager(
    messagesArea,
    document.getElementById('loadMoreBtn'),
    (msg) => messageEl(msg, msg.senderRole === 'admin')
  );

  let selectedUser = null; // row mới nhất từ /admin/users
  let activeThread = 'user'; // 'user' | 'partner'
  let activeConvId = null;
  let partners = [];
  let pendingFile = null;
  let usersReloadTimer = null;
  let processReloadTimer = null;

  function scrollBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  // ===== Sidebar =====
  async function loadUsers() {
    const list = document.getElementById('adminUserList');
    const prevScroll = list.scrollTop;
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

    list.innerHTML = '';
    if (!data.users.length) {
      const empty = document.createElement('div');
      empty.className = 'no-partner';
      empty.textContent = 'Chưa có khách hàng nào';
      list.appendChild(empty);
    }
    for (const u of data.users) {
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
        deleteUser(u, item);
      });
      actions.append(badge, partnerBadge, del);

      item.append(info, actions);
      item.addEventListener('click', () => selectUser(u));
      list.appendChild(item);
    }
    list.scrollTop = prevScroll;
    if (selectedUser) updateThreadTabs();
  }

  async function deleteUser(u, itemEl) {
    if (!confirm(`Xóa tài khoản "${u.display_name}" (${u.username})? Toàn bộ lịch sử chat sẽ mất.`)) return;
    const { data } = await api(`/admin/users/${u.id}`, { method: 'DELETE' });
    if (data && data.success) {
      itemEl.remove();
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
    pager.reset();
    chatTitle.textContent = 'Chọn một khách hàng để tư vấn';
    [msgInput, sendBtn, attachBtn].forEach((el) => { el.disabled = true; });
    partnerSelect.hidden = true;
    connectPartnerBtn.hidden = true;
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

    socket.emit('join', { convId });
    const data = await pager.open(convId);
    if (activeConvId !== convId) return; // đã chuyển luồng khác trong lúc chờ
    scrollBottom();
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
    [msgInput, sendBtn, attachBtn].forEach((el) => { el.disabled = false; });
    partnerSelect.hidden = false;
    connectPartnerBtn.hidden = false;
    processBtn.hidden = false;
    renderPartnerControl(selectedUser.partner_id, selectedUser.partner_name);
    updateThreadTabs();
    await openThread(activeThread);
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => openThread(btn.dataset.thread));
  }

  // ===== Gán Partner =====
  async function loadPartners() {
    const { data } = await api('/admin/partners');
    if (data && data.success) partners = data.partners;
  }

  function renderPartnerControl(assignedId, assignedName) {
    partnerSelect.innerHTML = '';
    if (assignedId) {
      const opt = document.createElement('option');
      opt.value = assignedId;
      opt.textContent = `Đang gán: ${assignedName || ''}`;
      partnerSelect.appendChild(opt);
    }
    for (const p of partners) {
      if (p.id === assignedId) continue;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.display_name;
      partnerSelect.appendChild(opt);
    }
    connectPartnerBtn.disabled = !partners.length;
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

  // ===== Socket =====
  const socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  const typing = createTypingSender(socket, () => activeConvId);
  const typingView = createTypingView(messagesArea, scrollBottom);
  const pendingSends = new Map(); // clientId → bubble "đang gửi" chờ server xác nhận
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
    if (msg.convId !== activeConvId) return;
    typingView.hide();
    messagesArea.appendChild(messageEl(msg, msg.senderRole === 'admin'));
    scrollBottom();
    if (msg.senderId !== myUser.id) socket.emit('read', { convId: msg.convId });
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
  socket.on('unread-badge', ({ convId, count }) => {
    if (convId !== activeConvId) setUserBadge(convId, count);
  });
  socket.on('badge-cleared', ({ convId }) => setUserBadge(convId, 0));
  socket.on('partner-badge', ({ convId, userId, count }) => {
    if (convId !== activeConvId) setPartnerBadge(userId, count);
  });
  socket.on('partner-badge-cleared', ({ userId }) => setPartnerBadge(userId, 0));
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

  await loadPartners();
  await loadUsers();
});
