// Trang Partner: xem danh sách khách được gán + toàn bộ lịch sử tư vấn (read-only)
document.addEventListener('DOMContentLoaded', async () => {
  const me = await api('/me');
  if (!me.data || !me.data.success || me.data.user.role !== 'partner') {
    window.location.href = '/';
    return;
  }
  document.getElementById('partnerName').textContent = me.data.user.display_name;
  wireLogout('logoutBtn');

  const listEl = document.getElementById('partnerList');
  const messagesEl = document.getElementById('partnerMessages');
  const noPartnerMsg = document.getElementById('noPartnerMsg');

  let selectedConvId = null;

  const { data } = await api('/partner/conversations');
  if (!data || !data.success || !data.conversations.length) return;
  noPartnerMsg.remove();

  for (const c of data.conversations) {
    const item = document.createElement('div');
    item.className = 'partner-item';
    const label = document.createElement('span');
    label.textContent = `${c.user_name} · ${c.message_count} tin nhắn`;
    item.append(avatarEl(c.user_name, 'user'), label);
    item.addEventListener('click', () => openConversation(c.conversation_id, c.user_name, item));
    listEl.appendChild(item);
  }

  async function openConversation(convId, title, itemEl) {
    selectedConvId = convId;
    document.querySelectorAll('.partner-item').forEach((el) => el.classList.remove('active'));
    itemEl.classList.add('active');
    socket.emit('join', { convId });

    const { data } = await api(`/conversations/${convId}/messages`);
    messagesEl.innerHTML = '';
    if (data && data.success) {
      for (const msg of data.messages) {
        messagesEl.appendChild(messageEl(msg, false, 'partner-message'));
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // Partner được join room để xem tin mới realtime (không gửi được - server chặn)
  const socket = io({ path: '/ws', query: { sessionId: getSessionId() } });
  socket.on('message', (msg) => {
    if (msg.convId !== selectedConvId) return;
    messagesEl.appendChild(messageEl(msg, false, 'partner-message'));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
});
