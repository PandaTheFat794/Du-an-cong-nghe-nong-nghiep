// Kiến thức nông nghiệp cho bot chuyên gia (fallback rule-based khi không có LLM API key).
// Mỗi mục: id, chủ đề, từ khóa (mảng con = cụm từ, ưu tiên điểm cao hơn) và câu trả lời thực tế.
module.exports = [
  {
    id: 'dao-on',
    topic: 'Bệnh đạo ôn lá',
    keywords: [
      ['dao on', 'dom hinh thoi', 'dot nau tren la', 'chay la lua'],
      ['dao-on', 'dinh on', 'bien vang'],
    ],
    reply: 'Triệu chứng bạn mô tả rất giống bệnh đạo ôn lá (chấm nâu nhỏ → đốm hình thoi, viền nâu, tâm trắng xám, nặng thì cháy lá). Xử lý:\n1. Rút cạn nước 3–4 ngày cho khô ruộng, không để ruộng ngập.\n2. Ngưng ngay phân đạm, không bón thúc trong lúc bệnh.\n3. Phun thuốc chứa Tricyclazole (Beam, Fuji-one) hoặc Isoprothiolane vào sáng sớm khi lá ráo sương.\n4. Phun lại sau 7 ngày nếu còn vết bệnh mới.\nĐạo ôn lây rất nhanh khi ẩm độ cao + nhiều sương, nên xử lý sớm và ghi nhật ký theo dõi nhé.',
  },
  {
    id: 'bac-la',
    topic: 'Bệnh bạc lá',
    keywords: [
      ['bac la', 'chay bac', 'vet bac o mep la'],
      ['bac-la'],
    ],
    reply: 'Bệnh bạc lá (vi khuẩn Xanthomonas) thường xuất hiện sau mưa gió lớn: vết bạc trắng từ mép lá lan dần vào trong.\n1. Rút nước, không bón đạm thêm khi bệnh đang phát.\n2. Phun thuốc chứa Kasugamycin (Kasumin) hoặc Streptomycin (Starner) theo liều khuyến cáo.\n3. Vệ sinh dụng cụ, tránh lây lan qua nước ruộng.\n4. Vụ sau chọn giống kháng bạc lá, gieo sạ thưa hợp lý.',
  },
  {
    id: 'kho-van',
    topic: 'Bệnh khô vằn',
    keywords: [
      ['kho van', 'dom van khong deu', 'vet benh o be goc'],
      ['kho-van'],
    ],
    reply: 'Khô vằn (đốm vằn không đều ở bẹ lá gần gốc) phát mạnh khi ruộng rậm, ẩm thấp.\n1. Rút nước phơi ruộng, giảm mật độ rậm rạp.\n2. Phun Validacin (Validamycin) hoặc Hexaconazole (Anvil) đúng liều.\n3. Bón cân đối, tránh thừa đạm — đạm nhiều là nguyên nhân hàng đầu.\n4. Dọn tàn dư rơm rạ sau thu hoạch để giảm nguồn bệnh.',
  },
  {
    id: 'ray-nau',
    topic: 'Rầy nâu',
    keywords: [
      ['ray nau', 'ray lua', 'lua bi ray'],
      ['ray'],
    ],
    reply: 'Rầy nâu chích hút nhựa cây, làm lúa vàng và chết chòm ("cháy rầy"), còn truyền virus lùn xoắn lá.\n1. Giữ mực nước 3–5cm, không để ruộng khô quá lâu.\n2. Dùng thuốc Pymetrozine (Chess) hoặc Buprofezin (Applaud) theo đúng liều.\n3. Không phun định kỳ vô tội vạ — chỉ phun khi mật độ vượt ngưỡng (khoảng 3 con/tép).\n4. Bảo vệ thiên địch: nhện, bọ xít mù xanh.',
  },
  {
    id: 'sau-cuon-la',
    topic: 'Sâu cuốn lá',
    keywords: [
      ['sau cuon la', 'la bi cuon'],
      ['sau', 'cuon la'],
    ],
    reply: 'Sâu cuốn lá nhỏ (sâu non cuốn lá thành tổ, ăn nhu mô để lại vệt trắng).\n1. Thăm đồng 3–5 ngày/lần, đếm sâu — chỉ phun khi mật độ cao.\n2. Ưu tiên thuốc sinh học BT (Bacillus thuringiensis) hoặc Abamectin.\n3. Bón phân cân đối, không thừa đạm để lúa cứng cây, ít hấp dẫn sâu.\n4. Thả bảo vệ thiên địch (ong ký sinh, bọ rùa).',
  },
  {
    id: 'oc-buou-vang',
    topic: 'Ốc bươu vàng',
    keywords: [
      ['oc buou vang', 'oc an lua'],
      ['oc'],
    ],
    reply: 'Ốc bươu vàng phá mạnh lúa non (gieo sạ đến ~20 ngày).\n1. Thu gom ốc và ổ trứng bằng tay vào sáng sớm — hiệu quả và rẻ nhất.\n2. Cắm cọc cho ốc đẻ trứng rồi thu gom.\n3. Giữ mực nước nông (3–5cm), nước sâu ốc phá mạnh hơn.\n4. Nếu mật độ quá cao dùng thuốc chứa Niclosamide, rải đúng liều ở nơi ốc tập trung.',
  },
  {
    id: 'vang-la',
    topic: 'Lúa vàng lá (ngộ độc phèn/ngập/thiếu dinh dưỡng)',
    keywords: [
      ['vang la', 'la bi vang', 'lua bi vang'],
      ['vang'],
    ],
    reply: 'Lúa vàng lá có nhiều nguyên nhân, cần phân biệt:\n- Ngộ độc phèn (đất phèn, nước đỏ váng): rút nước thay nước 2–3 lần, bón vôi 300–500kg/ha + lân.\n- Ngập úng kéo dài: tháo nước ngay, phun phân bón lá kích rễ.\n- Thiếu đạm: vàng từ lá già phía dưới, cần bón thúc đúng kỳ.\n- Thiếu kali: vàng cháy mép lá già.\nGửi ảnh lá + cho biết giai đoạn lúa và loại phân đã bón để chẩn đoán chính xác hơn nhé.',
  },
  {
    id: 'phan-bon',
    topic: 'Bón phân (đạm/NPK)',
    keywords: [
      ['bon phan', 'phan dam', 'npk', 'phan npk', 'urê', 'ure', 'dap'],
      ['dam', 'phan', 'npk'],
    ],
    reply: 'Nguyên tắc bón phân cho lúa: "đúng loại, đúng liều, đúng lúc, đúng cách".\n1. Bón lót trước khi sạ: lân + phân hữu cơ.\n2. Bón thúc đẻ nhánh (7–10 ngày sau sạ): đạm — nhưng chia nhỏ, đừng bón dồn.\n3. Bón đón đòng (trước trỗ ~20 ngày): kali + ít đạm.\n4. Tránh bón đạm khi trời âm u, mưa nhiều — dễ đạo ôn, sâu bệnh.\nLiều tham khảo đạm: 80–120kg N/ha tùy giống; nếu không chắc, gửi thông tin ruộng để tính cụ thể.',
  },
  {
    id: 'nuoc-tuoi',
    topic: 'Quản lý nước ruộng',
    keywords: [
      ['muc nuoc', 'nuoc tuoi', 'giu nuoc', 'rut nuoc', 'quan ly nuoc'],
      ['nuoc'],
    ],
    reply: 'Quản lý nước theo giai đoạn lúa:\n1. Sạ – 20 ngày: giữ ẩm, nước nông 3–5cm, rút cạn 1–2 ngày giữa giai đoạn để lúa cứng rễ.\n2. Đẻ nhánh: nước nông, để khô mặt ruộng 2–3 ngày giúp đẻ nhánh khỏe.\n3. Làm đòng – trỗ: giữ nước 5–7cm liên tục, không để hạn.\n4. Trước thu hoạch 7–10 ngày: rút cạn để lúa chín đều, dễ gặt.\nNước sâu + ẩm kéo dài là điều kiện phát sinh đạo ôn, khô vằn — chú ý nhé.',
  },
  {
    id: 'thuoc-bvtv',
    topic: 'Dùng thuốc BVTV an toàn',
    keywords: [
      ['thuoc tru sau', 'thuoc bvtv', 'phun thuoc', 'thuoc diệt', 'thuoc diet', 'thuoc gi'],
      ['thuoc'],
    ],
    reply: 'Dùng thuốc BVTV phải theo nguyên tắc "4 đúng": đúng thuốc, đúng lúc, đúng liều, đúng cách.\n1. Chỉ phun khi tới ngưỡng gây hại — phun định kỳ vô tội vạ vừa tốn kém vừa giết thiên địch.\n2. Phun sáng sớm hoặc chiều mát, tránh trời mưa (mưa sau phun < 4h phải phun lại).\n3. Đọc kỹ nhãn, mặc bảo hộ, đảm bảo thời gian cách ly trước thu hoạch.\n4. Ưu tiên thuốc sinh học khi có thể.\nCho mình biết loại sâu/bệnh cụ thể để tư vấn đúng hoạt chất nhé.',
  },
  {
    id: 'gioi-thieu',
    topic: 'Chào hỏi',
    keywords: [['chao', 'xin chao', 'hello', 'hi', 'alo']],
    reply: 'Chào bạn! Mình là Trợ lý AI chuyên về nông nghiệp 🌱 Mình có thể tư vấn nhanh về:\n• Bệnh hại lúa (đạo ôn, bạc lá, khô vằn, rầy nâu...)\n• Bón phân và quản lý nước\n• Dùng thuốc BVTV an toàn\nBạn gặp vấn đề gì ở ruộng/cây trồng thì mô tả giúp mình nhé!',
  },
  {
    id: 'cam-on',
    topic: 'Cảm ơn',
    keywords: [['cam on', 'thanks', 'thank you']],
    reply: 'Không có gì ạ! Chúc bạn vụ mùa bội thu. Nếu cần thêm, cứ nhắn mình — và nhớ cập nhật nhật ký canh tác để admin và kỹ thuật viên theo dõi sát hơn nhé 🌾',
  },
];

// Câu trả lời chung khi không khớp chủ đề nào — vẫn hữu ích và dẫn dắt tiếp
module.exports.fallback = 'Mình chưa rõ vấn đề bạn đang gặp. Bạn có thể mô tả thêm: cây gì, giai đoạn nào, triệu chứng ra sao (vàng lá, đốm nâu, sâu...)?\nMình tư vấn tốt nhất các chủ đề: bệnh hại lúa, bón phân, quản lý nước và dùng thuốc BVTV an toàn. Bạn cũng có thể ghi vào Nhật ký canh tác để admin/kỹ thuật viên nắm tình hình nhé!';
