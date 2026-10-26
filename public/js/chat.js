// Trang chat của User: nói chuyện trực tiếp với Admin (realtime qua socket)
document.addEventListener('DOMContentLoaded', async () => {
  const messagesArea = document.getElementById('messagesArea');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');

  // 1. Lấy danh tính + conversation hiện tại
  const me = await api('/me');
  if (!me.data || !me.data.success) {
    window.location.href = '/';
    return;
  }
  const myUser = me.data.user;
  const convId = me.data.conversation_id;
  wireLogout('logoutBtn');

  // Nhật ký canh tác của chính khách hàng (drawer bên phải)
  const processDrawer = createProcessDrawer({ canAdd: true });
  document.getElementById('processBtn').addEventListener('click', () => {
    processDrawer.open(myUser.id, myUser.display_name);
  });
  let processRefreshTimer = null;

  // 2. Lịch sử tin nhắn (REST, phân trang: nút "Tải tin cũ hơn" khi còn)
  const pager = createHistoryPager(
    messagesArea,
    document.getElementById('loadMoreBtn'),
    (msg) => messageEl(msg, msg.senderRole === 'user')
  );
  const history = await pager.open(convId);
  if (history) {
    if (history.conversation.partner_name) {
      const chip = document.getElementById('partnerChip');
      chip.textContent = `Đồng hành: ${history.conversation.partner_name}`;
      chip.hidden = false;
    }
    scrollBottom();
  }

  function scrollBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  // 3. Socket realtime (xác thực bằng sessionId thật từ login)
  const socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  const typing = createTypingSender(socket, () => convId);
  const typingView = createTypingView(messagesArea, scrollBottom);
  wireConnectionIndicator(socket, document.getElementById('connDot'));

  const pendingSends = new Map(); // clientId → bubble "đang gửi" chờ server xác nhận

  socket.on('connect', () => socket.emit('join', { convId }));
  socket.on('message', (msg) => {
    typingView.hide();
    const pending = msg.clientId && pendingSends.get(msg.clientId);
    if (pending) {
      pending.el.remove(); // thay bubble tạm bằng tin thật từ server
      pendingSends.delete(msg.clientId);
    }
    messagesArea.appendChild(messageEl(msg, msg.senderId === myUser.id));
    scrollBottom();
  });
  socket.on('typing', (d) => {
    if (d.convId !== convId || d.userId === myUser.id) return;
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

  // 4. Gửi tin (kèm file đã upload nếu có)
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

    socket.emit('message', { convId, ...draft, clientId });
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
