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
  const partnerSelect = document.getElementById('partnerSelect');
  const connectPartnerBtn = document.getElementById('connectPartnerBtn');

  let selectedConvId = null;
  let partners = [];
  let pendingFile = null;
  let usersReloadTimer = null;

  function scrollBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  // ===== Sidebar =====
  async function loadUsers() {
    const { data } = await api('/admin/users');
    if (!data || !data.success) return;
    const list = document.getElementById('adminUserList');
    list.innerHTML = '';
    if (!data.users.length) {
      const empty = document.createElement('div');
      empty.className = 'no-partner';
      empty.textContent = 'Chưa có khách hàng nào';
      list.appendChild(empty);
    }
    for (const u of data.users) {
      const item = document.createElement('div');
      item.className = 'user-item' + (u.conversation_id === selectedConvId ? ' active' : '');
      item.dataset.convId = u.conversation_id;
      item.dataset.convTitle = u.display_name;

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
      info.append(avatarEl(u.display_name, 'user'), meta);

      const badge = document.createElement('span');
      badge.className = 'user-unread';
      badge.id = `unread-${u.conversation_id}`;
      badge.textContent = u.unread_count;
      badge.hidden = !u.unread_count;

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
      actions.append(badge, del);

      item.append(info, actions);
      item.addEventListener('click', () => selectConversation(u.conversation_id, u.display_name));
      list.appendChild(item);
    }
  }

  async function deleteUser(u, itemEl) {
    if (!confirm(`Xóa tài khoản "${u.display_name}" (${u.username})? Toàn bộ lịch sử chat sẽ mất.`)) return;
    const { data } = await api(`/admin/users/${u.id}`, { method: 'DELETE' });
    if (data && data.success) {
      itemEl.remove();
      if (u.conversation_id === selectedConvId) resetChatArea();
      toast(`Đã xóa tài khoản ${u.display_name}`, 'success');
    } else {
      toast((data && data.error) || 'Không xóa được tài khoản', 'error');
    }
  }

  function resetChatArea() {
    selectedConvId = null;
    typingView.hide();
    pendingSends.clear();
    chatTitle.textContent = 'Chọn một khách hàng để tư vấn';
    [msgInput, sendBtn, attachBtn].forEach((el) => { el.disabled = true; });
    partnerSelect.hidden = true;
    connectPartnerBtn.hidden = true;
    messagesArea.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'no-partner';
    hint.textContent = 'Chưa chọn cuộc trò chuyện';
    messagesArea.appendChild(hint);
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
    typingView.hide(); // bong bóng "đang gõ" của conversation cũ
    pendingSends.clear(); // bubble tạm của conv cũ sẽ bị innerHTML xoá bên dưới
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
      toast('Đã kết nối Partner cho khách hàng này.', 'success');
      selectConversation(selectedConvId, chatTitle.textContent);
    } else {
      toast((data && data.error) || 'Không gán được Partner', 'error');
    }
  });

  // ===== Socket =====
  const socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  const typing = createTypingSender(socket, () => selectedConvId);
  const typingView = createTypingView(messagesArea, scrollBottom);
  const pendingSends = new Map(); // clientId → bubble "đang gửi" chờ server xác nhận
  wireConnectionIndicator(socket, document.getElementById('connDot'));

  socket.on('message', (msg) => {
    const pending = msg.clientId && pendingSends.get(msg.clientId);
    if (pending) {
      pending.el.remove();
      pendingSends.delete(msg.clientId);
    }
    if (msg.convId !== selectedConvId) return;
    typingView.hide();
    messagesArea.appendChild(messageEl(msg, msg.senderRole === 'admin'));
    scrollBottom();
  });
  socket.on('typing', (d) => {
    if (d.convId !== selectedConvId || d.userId === myUser.id) return;
    if (d.isTyping) typingView.show();
    else typingView.hide();
  });
  socket.on('user-message', () => {
    clearTimeout(usersReloadTimer);
    usersReloadTimer = setTimeout(loadUsers, 400); // debounce khi khách gửi dồn dập
  }); // tin mới từ khách → refresh sidebar
  socket.on('unread-badge', ({ convId, count }) => {
    if (convId !== selectedConvId) setBadge(convId, count);
  });
  socket.on('badge-cleared', ({ convId }) => setBadge(convId, 0));
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

  await loadPartners();
  await loadUsers();
});
