// Client-side helpers for login/logout/register
window.apiBase = '/api';

window.attemptLogin = async function(username, password) {
  const resp = await fetch(`${window.apiBase}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await resp.json();
  if (data.success) {
    localStorage.setItem('sessionId', data.user.id);
    window.location.href = data.user.role === 'admin' ? '/admin' :
                          data.user.role === 'partner' ? '/partner' : '/chat';
  } else {
    alert(data.error || 'Đăng nhập thất bại');
  }
};

window.attemptRegister = async function(username, password, displayName) {
  const resp = await fetch(`${window.apiBase}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, display_name: displayName })
  });
  const data = await resp.json();
  if (data.success) {
    alert('Đăng ký thành công! Bạn có thể đăng nhập ngay.');
  } else {
    alert(data.error || 'Đăng ký thất bại');
  }
};

window.doLogout = async function() {
  await fetch(`${window.apiBase}/logout`, { method: 'POST' });
  localStorage.removeItem('sessionId');
  window.location.href = '/';
};