// Trang chat của User: nói chuyện trực tiếp với Admin (realtime qua socket)
document.addEventListener('DOMContentLoaded', async () => {
  const messagesArea = document.getElementById('messagesArea');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const socketStatus = document.getElementById('socketStatus');

  // 1. Lấy danh tính + conversation hiện tại
  const me = await api('/me');
  if (!me.data || !me.data.success) {
    window.location.href = '/';
    return;
  }
  const myUser = me.data.user;
  const convId = me.data.conversation_id;
  wireLogout('logoutBtn');

  // 2. Lịch sử tin nhắn (REST)
  const history = await api(`/conversations/${convId}/messages`);
  if (history.data && history.data.success) {
    for (const msg of history.data.messages) {
      messagesArea.appendChild(messageEl(msg, msg.senderRole === 'user'));
    }
    if (history.data.conversation.partner_name) {
      const chip = document.getElementById('partnerChip');
      chip.textContent = `Đồng hành: ${history.data.conversation.partner_name}`;
      chip.hidden = false;
    }
    scrollBottom();
  }

  function scrollBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }
  function flashStatus(text) {
    socketStatus.textContent = text;
    socketStatus.hidden = false;
    setTimeout(() => { socketStatus.hidden = true; }, 4000);
  }

  // 3. Socket realtime (xác thực bằng sessionId thật từ login)
  const socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  socket.on('connect', () => socket.emit('join', { convId }));
  socket.on('message', (msg) => {
    messagesArea.appendChild(messageEl(msg, msg.senderId === myUser.id));
    scrollBottom();
  });
  socket.on('error', (e) => flashStatus(e.message));

  // 4. Gửi tin (kèm file đã upload nếu có)
  let pendingFile = null;
  wireAttachButton('attachBtn', 'attachInput', 'attachChip', (res) => { pendingFile = res; });

  function sendMessage() {
    const content = msgInput.value.trim();
    if (!content && !pendingFile) return;
    socket.emit('message', { convId, content, attachment: pendingFile });
    msgInput.value = '';
    pendingFile = null;
    document.getElementById('attachChip').textContent = '';
  }
  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
});
