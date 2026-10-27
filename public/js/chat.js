// Trang chat của User: 2 luồng riêng tư — với Admin (chuyên gia) và với Partner (nếu được gán)
document.addEventListener('DOMContentLoaded', async () => {
  const messagesArea = document.getElementById('messagesArea');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const chatTitle = document.getElementById('chatTitle');
  const threadTabs = document.getElementById('threadTabs');
  const tabButtons = [...threadTabs.querySelectorAll('.view-tab')];
  const tabsByThread = new Map(tabButtons.map((btn) => [btn.dataset.thread, btn]));

  // 1. Lấy danh tính + các thread riêng tư hiện tại
  const me = await api('/me');
  if (!me.data || !me.data.success) {
    window.location.href = '/';
    return;
  }
  const myUser = me.data.user;
  const partner = me.data.partner; // { id, display_name, conversation_id } | null
  const threads = {
    admin: { convId: me.data.conversation_id, title: 'Chuyên gia tư vấn', placeholder: 'Nhắn cho chuyên gia...' },
  };
  if (partner) {
    threads.partner = {
      convId: partner.conversation_id,
      title: partner.display_name,
      placeholder: `Nhắn cho ${partner.display_name}...`,
    };
    const partnerTab = tabsByThread.get('partner');
    partnerTab.textContent = partner.display_name;
    partnerTab.title = `Cuộc trò chuyện riêng với ${partner.display_name}`;
    partnerTab.hidden = false;
    threadTabs.hidden = false;
  }
  wireLogout('logoutBtn');

  let activeThread = null;
  let activeConvId = null;
  let voice = null; // bộ ghi âm tin nhắn thoại

  // Nhật ký canh tác của chính khách hàng (drawer bên phải)
  const processDrawer = createProcessDrawer({ canAdd: true });
  document.getElementById('processBtn').addEventListener('click', () => {
    processDrawer.open(myUser.id, myUser.display_name);
  });
  let processRefreshTimer = null;

  // 2. Lịch sử tin nhắn (REST, phân trang: nút "Tải tin cũ hơn" khi còn)
  let seenWatermark = 0; // mốc "bên kia đã đọc" của thread đang mở (nhãn Đã xem)
  const pager = createHistoryPager(
    messagesArea,
    document.getElementById('loadMoreBtn'),
    (msg) => messageEl(msg, msg.senderId === myUser.id),
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

  function scrollBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function updateTabState() {
    for (const btn of tabButtons) {
      const active = btn.dataset.thread === activeThread;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    }
  }

  function markThreadNew(threadKey) {
    const tab = tabsByThread.get(threadKey);
    if (tab && threadKey !== activeThread) tab.classList.add('has-new');
  }

  async function openThread(threadKey) {
    const thread = threads[threadKey];
    if (!thread) return;
    activeThread = threadKey;
    activeConvId = thread.convId;
    updateTabState();
    tabsByThread.get(threadKey).classList.remove('has-new');
    unreadTitle.clear(threadKey);
    chatTitle.textContent = thread.title;
    msgInput.placeholder = thread.placeholder;
    typingView.hide();
    pendingSends.clear();
    botStreams.clear();
    voice?.cancel();
    pager.reset();
    chatSearch.reset();

    socket.emit('join', { convId: thread.convId });
    const data = await pager.open(thread.convId);
    if (activeConvId === thread.convId) {
      // Bên kia của cả 2 thread (admin/partner) ghi mốc đọc vào admin_last_read_id
      seenWatermark = data && data.conversation ? data.conversation.admin_last_read_id || 0 : 0;
      applySeenStatus(messagesArea, seenWatermark, myUser.role);
      scrollBottom();
      socket.emit('read', { convId: thread.convId });
    }
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => openThread(btn.dataset.thread));
  }
  wireTablist('threadTabs', (btn) => openThread(btn.dataset.thread));

  const socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  const typing = createTypingSender(socket, () => activeConvId);
  const typingView = createTypingView(messagesArea, scrollBottom);
  const pendingSends = new Map(); // clientId → bubble "đang gửi" chờ server xác nhận
  const botStreams = new Map(); // clientId → bubble bot đang trả lời (stream)
  wireConnectionIndicator(socket, document.getElementById('connDot'));

  // Vào cả 2 phòng để nhận tin realtime từ luồng còn lại (kèm chấm báo tin mới)
  socket.on('connect', () => {
    for (const thread of Object.values(threads)) socket.emit('join', { convId: thread.convId });
  });
  socket.on('message', (msg) => {
    const pending = msg.clientId && pendingSends.get(msg.clientId);
    if (pending) {
      pending.el.remove(); // thay bubble tạm bằng tin thật từ server
      pendingSends.delete(msg.clientId);
    }
    const stream = msg.clientId && botStreams.get(msg.clientId);
    if (stream) {
      stream.el.remove(); // bot đã trả lời xong → thay bubble stream bằng tin thật
      botStreams.delete(msg.clientId);
    }
    if (msg.convId !== activeConvId) {
      if (msg.senderId === myUser.id) return;
      const threadKey = Object.keys(threads).find((key) => threads[key].convId === msg.convId);
      if (threadKey) {
        markThreadNew(threadKey);
        unreadTitle.bump(threadKey);
        playPing();
        toast(`Tin nhắn mới từ ${msg.senderName}`, 'info');
      }
      return;
    }
    typingView.hide();
    messagesArea.appendChild(messageEl(msg, msg.senderId === myUser.id));
    scrollBottom();
    // Đang mở thread → xem được ngay, báo server để bên kia thấy "Đã xem"
    if (msg.senderId !== myUser.id) socket.emit('read', { convId: msg.convId });
  });
  // Bên kia (admin/partner) đã đọc thread đang mở → hiện "Đã xem" cho tin của mình
  socket.on('read-by', (d) => {
    if (d.convId !== activeConvId || d.userSide) return;
    applySeenStatus(messagesArea, d.seenUpTo, myUser.role);
  });
  // Bot chuyên gia đang trả lời: hiện bubble stream từng cụm chữ
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
  socket.on('process-updated', (d) => {
    if (d.userId !== myUser.id || !processDrawer.isOpenFor(myUser.id)) return;
    clearTimeout(processRefreshTimer);
    processRefreshTimer = setTimeout(() => processDrawer.refresh(), 200);
  });
  socket.on('error', (e) => {
    toast(e.message, 'error');
    failAllPending();
  });

  // 4. Gửi tin (kèm file đã upload nếu có) vào đúng thread đang mở
  let pendingFile = null;
  const attachChip = document.getElementById('attachChip');
  wireAttachButton('attachBtn', 'attachInput', 'attachChip', (res) => { pendingFile = res; });

  // Trả tin chưa gửi được về ô nhập để người dùng không mất nội dung
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

  await openThread('admin');
});
