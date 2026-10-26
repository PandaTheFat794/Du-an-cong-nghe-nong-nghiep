// Trang Partner: theo dõi nhật ký canh tác của khách + trò chuyện 3 bên (user–admin–partner)
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

  let selectedConvId = null;
  let selectedUserId = null;
  let activeView = 'process';
  let pendingFile = null;
  let processTimer = null;
  let socket = null;

  const pager = createHistoryPager(
    messagesEl,
    document.getElementById('loadMoreBtn'),
    (msg) => messageEl(msg, msg.senderId === myUser.id)
  );
  const typingView = createTypingView(messagesEl, scrollBottom);
  const pendingSends = new Map();

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setView(view) {
    activeView = view === 'chat' ? 'chat' : 'process';
    for (const btn of tabButtons) {
      const active = btn.dataset.view === activeView;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    processPane.hidden = activeView !== 'process';
    chatPane.hidden = activeView !== 'chat';
    if (activeView === 'chat') scrollBottom();
    else loadProcess();
  }
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }
  document.getElementById('refreshProcessBtn').addEventListener('click', () => {
    processTimeline.dataset.ready = '';
    loadProcess();
  });

  async function loadProcess() {
    if (!selectedUserId) return;
    const requestedUserId = selectedUserId;
    if (!processTimeline.dataset.ready) {
      processTimeline.innerHTML = '<div class="process-loading">Đang tải nhật ký canh tác...</div>';
    }
    const { data } = await api(`/process?userId=${requestedUserId}`);
    if (requestedUserId !== selectedUserId) return;
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

  async function openConversation(convId, userId, userName, itemEl) {
    selectedConvId = convId;
    selectedUserId = userId;
    document.querySelectorAll('.partner-item').forEach((el) => el.classList.remove('active'));
    if (itemEl) itemEl.classList.add('active');
    chatTitle.textContent = userName;
    chatMeta.textContent = 'Theo dõi quá trình canh tác và trao đổi trực tiếp';
    noPartnerMsg.hidden = true;
    tabs.hidden = false;
    processPane.hidden = activeView !== 'process';
    chatPane.hidden = activeView !== 'chat';
    typingView.hide();
    pendingSends.clear();

    if (socket) socket.emit('join', { convId });
    await Promise.all([loadProcess(), pager.open(convId)]);
    if (activeView === 'chat') scrollBottom();
  }

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

  // ===== Danh sách khách được gán =====
  const { data } = await api('/partner/conversations');
  let firstItem = null;
  if (data && data.success && data.conversations.length) {
    for (const c of data.conversations) {
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
      item.addEventListener('click', () => openConversation(c.conversation_id, c.user_id, c.user_name, item));
      listEl.appendChild(item);
      if (!firstItem) firstItem = { item, conv: c };
    }
    // Mở sẵn khách đầu tiên để màn hình không trống
    await openConversation(firstItem.conv.conversation_id, firstItem.conv.user_id, firstItem.conv.user_name, firstItem.item);
  }

  // ===== Socket =====
  socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  const typing = createTypingSender(socket, () => selectedConvId);
  wireConnectionIndicator(socket, document.getElementById('connDot'));

  socket.on('connect', () => {
    if (selectedConvId) socket.emit('join', { convId: selectedConvId });
  });
  socket.on('message', (msg) => {
    if (msg.convId !== selectedConvId) return;
    const pending = msg.clientId && pendingSends.get(msg.clientId);
    if (pending) {
      pending.el.remove();
      pendingSends.delete(msg.clientId);
    }
    typingView.hide();
    messagesEl.appendChild(messageEl(msg, msg.senderId === myUser.id));
    scrollBottom();
    updateItemCounts(selectedUserId, 0, 1);
  });
  socket.on('typing', (d) => {
    if (d.convId !== selectedConvId || d.userId === myUser.id) return;
    if (d.isTyping) typingView.show();
    else typingView.hide();
  });
  socket.on('process-updated', (d) => {
    if (d.userId !== selectedUserId) {
      updateItemCounts(d.userId, d.action === 'created' ? 1 : -1, 0);
      return;
    }
    updateItemCounts(d.userId, d.action === 'created' ? 1 : -1, 0);
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
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
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
    if (!selectedConvId) return;
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

    socket.emit('message', { convId: selectedConvId, ...draft, clientId });
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
});
