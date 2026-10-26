// Trang Admin: sidebar khách hàng (badge unread) + khung chat + gán Partner
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
  const socketStatus = document.getElementById('socketStatus');
  const partnerSelect = document.getElementById('partnerSelect');
  const connectPartnerBtn = document.getElementById('connectPartnerBtn');

  let selectedConvId = null;
  let partners = [];
  let pendingFile = null;

  function flashStatus(text) {
    socketStatus.textContent = text;
    socketStatus.hidden = false;
    setTimeout(() => { socketStatus.hidden = true; }, 4000);
  }
  function scrollBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  // ===== Sidebar =====
  async function loadUsers() {
    const { data } = await api('/admin/users');
    if (!data || !data.success) return;
    const list = document.getElementById('adminUserList');
    list.innerHTML = '';
    for (const u of data.users) {
      const item = document.createElement('div');
      item.className = 'user-item' + (u.conversation_id === selectedConvId ? ' active' : '');
      item.dataset.convId = u.conversation_id;
      item.dataset.convTitle = u.display_name;

      const info = document.createElement('div');
      info.className = 'user-info';
      const name = document.createElement('div');
      name.className = 'user-name';
      name.textContent = u.display_name;
      const last = document.createElement('div');
      last.className = 'user-last-msg';
      last.textContent = u.last_message;
      info.append(name, last);

      const badge = document.createElement('span');
      badge.className = 'user-unread';
      badge.id = `unread-${u.conversation_id}`;
      badge.textContent = u.unread_count;
      badge.hidden = !u.unread_count;

      item.append(info, badge);
      item.addEventListener('click', () => selectConversation(u.conversation_id, u.display_name));
      list.appendChild(item);
    }
  }

  function setBadge(convId, count) {
    const badge = document.getElementById(`unread-${convId}`);
    if (badge) {
      badge.textContent = count;
      badge.hidden = !count;
    }
  }

  // ===== Chọn cuộc trò chuyện =====
  async function selectConversation(convId, title) {
    selectedConvId = convId;
    document.querySelectorAll('.user-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.convId) === convId);
    });
    chatTitle.textContent = title;

    [msgInput, sendBtn, attachBtn].forEach((el) => { el.disabled = false; });
    partnerSelect.hidden = false;
    connectPartnerBtn.hidden = false;

    socket.emit('join', { convId });

    const { data } = await api(`/conversations/${convId}/messages`);
    messagesArea.innerHTML = '';
    if (data && data.success) {
      for (const msg of data.messages) {
        messagesArea.appendChild(messageEl(msg, msg.senderRole === 'admin'));
      }
      scrollBottom();
      renderPartnerControl(data.conversation.partner_id, data.conversation.partner_name);
    }

    // Admin mở chat → đánh dấu đã đọc (server bắn badge-cleared về room admins)
    socket.emit('read', { convId });
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
      opt.textContent = `Đang gán: ${assignedName}`;
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
    if (!selectedConvId || !partnerSelect.value) return;
    const { data } = await api(`/admin/conversations/${selectedConvId}/connect`, {
      method: 'POST',
      body: JSON.stringify({ partner_id: Number(partnerSelect.value) }),
    });
    if (data && data.success) {
      flashStatus('Đã kết nối Partner cho khách hàng này.');
      selectConversation(selectedConvId, chatTitle.textContent);
    } else {
      flashStatus((data && data.error) || 'Không gán được Partner');
    }
  });

  // ===== Socket =====
  const socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  socket.on('message', (msg) => {
    if (msg.convId !== selectedConvId) return;
    messagesArea.appendChild(messageEl(msg, msg.senderRole === 'admin'));
    scrollBottom();
  });
  socket.on('user-message', () => loadUsers()); // tin mới từ khách → refresh sidebar
  socket.on('unread-badge', ({ convId, count }) => {
    if (convId !== selectedConvId) setBadge(convId, count);
  });
  socket.on('badge-cleared', ({ convId }) => setBadge(convId, 0));
  socket.on('error', (e) => flashStatus(e.message));

  // ===== Gửi tin + đính kèm =====
  wireAttachButton('attachBtn', 'attachInput', 'attachChip', (res) => { pendingFile = res; });

  function sendMessage() {
    const content = msgInput.value.trim();
    if (!content && !pendingFile) return;
    socket.emit('message', { convId: selectedConvId, content, attachment: pendingFile });
    msgInput.value = '';
    pendingFile = null;
    document.getElementById('attachChip').textContent = '';
  }
  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  await loadPartners();
  await loadUsers();
});
