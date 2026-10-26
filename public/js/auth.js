// Trang đăng nhập / đăng ký
document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  const errorBox = document.getElementById('authError');

  // Đã đăng nhập thì vào thẳng trang của role
  api('/me').then(({ data }) => {
    if (data && data.success) window.location.href = homeFor(data.user.role);
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function switchTab(showRegister) {
    tabLogin.classList.toggle('active', !showRegister);
    tabRegister.classList.toggle('active', showRegister);
    loginForm.hidden = showRegister;
    registerForm.hidden = !showRegister;
    errorBox.hidden = true;
  }
  tabLogin.addEventListener('click', () => switchTab(false));
  tabRegister.addEventListener('click', () => switchTab(true));

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { data } = await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('loginUsername').value.trim(),
        password: document.getElementById('loginPassword').value,
      }),
    });
    if (data && data.success) {
      saveSession(data.sessionId);
      window.location.href = homeFor(data.user.role);
    } else {
      showError((data && data.error) || 'Đăng nhập thất bại');
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { data } = await api('/register', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('regUsername').value.trim(),
        password: document.getElementById('regPassword').value,
        display_name: document.getElementById('regDisplayName').value.trim(),
      }),
    });
    if (data && data.success) {
      switchTab(false);
      alert('Đăng ký thành công! Bạn có thể đăng nhập ngay.');
    } else {
      showError((data && data.error) || 'Đăng ký thất bại');
    }
  });
});
