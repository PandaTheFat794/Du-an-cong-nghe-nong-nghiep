document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const userRole = document.getElementById('userRole')?.dataset.role || 'user';
  const currentConvId = 1;
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const messagesArea = document.getElementById('messagesArea');

  function sendMessage() {
    const content = msgInput.value.trim();
    if (!content) return;
    const sessionId = localStorage.getItem('sessionId');
    socket.emit('message', { convId: currentConvId, sessionId, content });
    msgInput.value = '';
  }

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  socket.on('message', (msg) => {
    const div = document.createElement('div');
    div.className = `message ${msg.senderRole === 'user' ? 'user' : 'admin'}`;
    div.innerHTML = `<div class="message-time">${new Date(msg.created_at).toLocaleTimeString()}</div>${msg.content}`;
    messagesArea.appendChild(div);
    messagesArea.scrollTop = messagesArea.scrollHeight;
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