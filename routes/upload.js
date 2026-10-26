const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../auth');

const router = express.Router();

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

// POST /api/upload (multipart/form-data, field "file") → { url, name }
router.post('/upload', requireAuth, (req, res) => {
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

    res.status(201).json({
      success: true,
      url: `/uploads/${req.file.filename}`,
      name: path.basename(req.file.originalname),
    });
  });
});

module.exports = router;
