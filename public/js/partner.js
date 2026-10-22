document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const sessionId = localStorage.getItem('sessionId');

  // Partner chỉ đọc lịch sử, không gửi tin nhắn
  // Hiển thị lịch sử chat (chỉ đọc) trong .partner-messages
  // Mặc định hiện tin nhắn "chưa có khách" cho đến khi có dữ liệu

  document.getElementById('noPartnerMsg').style.display = 'block';
});