document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  fetch('/api/admin/users')
    .then(r => r.json())
    .then(users => {
      const list = document.getElementById('adminUserList');
      list.innerHTML = '';
      users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'user-item';
        div.innerHTML = `
          <div class="user-info">
            <div class="user-name">${u.display_name}</div>
            <div class="user-last-msg">${u.last_message || 'Chưa có tin nhắn'}</div>
          </div>
          <span class="user-unread" id="unread-${u.id}">${u.unread_count || 0}</span>
        `;
        list.appendChild(div);
      });
    });

  document.querySelectorAll('.user-item').forEach(item => {
    item.addEventListener('click', () => {
      const sessionId = localStorage.getItem('sessionId');
      socket.emit('join', { convId: 1, sessionId });
    });
  });

  document.getElementById('connectPartnerBtn').addEventListener('click', () => {
    const sessionId = localStorage.getItem('sessionId');
    socket.emit('connect-partner', { convId: 1, sessionId });
  });

  socket.on('message', (msg) => {
    const div = document.createElement('div');
    div.className = `message ${msg.senderRole === 'user' ? 'user' : 'admin'}`;
    div.innerHTML = `<div class="message-time">${new Date(msg.created_at).toLocaleTimeString()}</div>${msg.content}`;
    document.getElementById('messagesArea').appendChild(div);
    document.getElementById('messagesArea').scrollTop = document.getElementById('messagesArea').scrollHeight;
  });

  socket.on('unread-badge', (data) => {
    const badge = document.getElementById(`unread-${data.convId}`);
    if (badge) badge.textContent = data.count;
  });

  socket.on('badge-cleared', () => {
    const badge = document.querySelector('.user-unread.active');
    if (badge) badge.remove();
  });
});