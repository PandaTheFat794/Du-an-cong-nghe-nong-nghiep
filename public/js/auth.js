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
    tabLogin.setAttribute('aria-selected', String(!showRegister));
    tabRegister.setAttribute('aria-selected', String(showRegister));
    tabLogin.tabIndex = showRegister ? -1 : 0;
    tabRegister.tabIndex = showRegister ? 0 : -1;
    loginForm.hidden = showRegister;
    registerForm.hidden = !showRegister;
    errorBox.hidden = true;
  }
  tabLogin.addEventListener('click', () => switchTab(false));
  tabRegister.addEventListener('click', () => switchTab(true));
  wireTablist('authTabs', (btn) => switchTab(btn === tabRegister));

  // Vào nhanh 1 trong 3 tài khoản seed (demo) — vẫn đi qua /api/login như form thường
  const quickButtons = [...document.querySelectorAll('.quick-account')];
  for (const btn of quickButtons) {
    btn.addEventListener('click', async () => {
      errorBox.hidden = true;
      quickButtons.forEach((b) => { b.disabled = true; });
      const { data } = await api('/login', {
        method: 'POST',
        body: JSON.stringify({
          username: btn.dataset.quickUser,
          password: btn.dataset.quickPass,
        }),
      });
      if (data && data.success) {
        saveSession(data.sessionId);
        window.location.href = homeFor(data.user.role);
      } else {
        quickButtons.forEach((b) => { b.disabled = false; });
        showError((data && data.error) || 'Đăng nhập nhanh thất bại');
      }
    });
  }

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
      registerForm.reset();
      switchTab(false);
      toast('Đăng ký thành công! Bạn có thể đăng nhập ngay.', 'success');
    } else {
      showError((data && data.error) || 'Đăng ký thất bại');
    }
  });
});
