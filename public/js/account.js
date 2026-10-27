// Panel "Tài khoản": đổi mật khẩu (mọi role) + tự xóa tài khoản (chỉ khách hàng).
// Trang nào có <body data-account-controls="<id khối header>"> sẽ tự được gắn nút.
document.addEventListener('DOMContentLoaded', async () => {
  const hostId = document.body.dataset.accountControls;
  if (!hostId) return;
  const controls = document.getElementById(hostId);
  if (!controls) return;

  const { data } = await api('/me');
  if (!data || !data.success) return;
  const me = data.user;

  const btn = document.createElement('button');
  btn.className = 'chat-btn';
  btn.type = 'button';
  btn.textContent = 'Tài khoản';

  const panel = document.createElement('div');
  panel.className = 'account-panel';
  panel.hidden = true;

  panel.innerHTML = `
    <form id="pwForm">
      <label class="panel-title">Đổi mật khẩu</label>
      <input class="form-field" type="password" id="pwCurrent" placeholder="Mật khẩu hiện tại" aria-label="Mật khẩu hiện tại" autocomplete="current-password" required>
      <input class="form-field" type="password" id="pwNew" placeholder="Mật khẩu mới (tối thiểu 6 ký tự)" aria-label="Mật khẩu mới" autocomplete="new-password" minlength="6" required>
      <button class="btn-primary" type="submit">Đổi mật khẩu</button>
      <div class="panel-msg" id="pwMsg"></div>
    </form>
    ${me.role === 'user' ? '<button class="btn-danger" id="deleteAccountBtn" type="button">Xóa tài khoản của tôi</button>' : ''}
  `;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
  });

  panel.querySelector('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = panel.querySelector('#pwMsg');
    const { status, data: res } = await api('/me/password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: panel.querySelector('#pwCurrent').value,
        new_password: panel.querySelector('#pwNew').value,
      }),
    });
    msg.textContent = (res && res.error) || (status === 200 ? 'Đã đổi mật khẩu.' : 'Không đổi được mật khẩu');
    if (status === 200) {
      e.target.reset();
      toast('Đã đổi mật khẩu tài khoản.', 'success');
    }
  });

  const delBtn = panel.querySelector('#deleteAccountBtn');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm('Xóa tài khoản sẽ mất toàn bộ lịch sử tư vấn. Bạn chắc chắn?')) return;
      const { data: res } = await api('/me', { method: 'DELETE' });
      if (res && res.success) {
        clearSession();
        window.location.href = '/';
      } else {
        toast((res && res.error) || 'Không xóa được tài khoản', 'error');
      }
    });
  }

  controls.append(btn, panel);
});
