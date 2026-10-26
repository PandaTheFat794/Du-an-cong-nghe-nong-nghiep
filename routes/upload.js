const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../auth');
const { createRateLimiter } = require('../rate-limit');

const router = express.Router();

const uploadLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyFn: (req) => req.user.id,
  message: 'Bạn tải file quá nhiều lần, vui lòng thử lại sau.',
});

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx']);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Sinh tên mới hoàn toàn → không cho phép path traversal qua originalname
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// Kiểm tra chữ ký file (magic bytes) khớp với phần mở rộng → chặn file giả mạo
function hasValidSignature(buf, ext) {
  const starts = (offset, bytes) => bytes.every((b, i) => buf[offset + i] === b);
  switch (ext) {
    case '.jpg':
    case '.jpeg': return starts(0, [0xff, 0xd8, 0xff]);
    case '.png': return starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case '.gif': return starts(0, [0x47, 0x49, 0x46, 0x38]);
    case '.webp': return starts(0, [0x52, 0x49, 0x46, 0x46]) && buf.subarray(8, 12).toString('ascii') === 'WEBP';
    case '.pdf': return starts(0, [0x25, 0x50, 0x44, 0x46]);
    case '.doc': return starts(0, [0xd0, 0xcf, 0x11, 0xe0]);
    case '.docx': return starts(0, [0x50, 0x4b, 0x03, 0x04]);
    default: return false;
  }
}

// POST /api/upload (multipart/form-data, field "file") → { url, name }
router.post('/upload', requireAuth, uploadLimiter, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File vượt quá dung lượng cho phép (5MB)'
        : 'Không thể xử lý file';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Không nhận được file' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Chỉ chấp nhận ảnh (jpg/png/gif/webp) hoặc tài liệu (pdf/doc/docx)' });
    }

    let header = Buffer.alloc(12);
    try {
      const fd = fs.openSync(req.file.path, 'r');
      const read = fs.readSync(fd, header, 0, 12, 0);
      fs.closeSync(fd);
      header = header.subarray(0, read);
    } catch {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Không đọc được file' });
    }
    if (!hasValidSignature(header, ext)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Nội dung file không khớp định dạng khai báo' });
    }

    res.status(201).json({
      success: true,
      url: `/uploads/${req.file.filename}`,
      name: path.basename(req.file.originalname),
    });
  });
});

module.exports = router;
