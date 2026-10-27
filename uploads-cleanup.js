// Job dọn rác public/uploads: xóa file không còn được messages/process_entries
// tham chiếu. Chỉ xóa file cũ hơn minAgeMs để không dính file đang upload dở.
const fs = require('fs');
const path = require('path');

function cleanupUploads(db, uploadsDir, { minAgeMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(uploadsDir);
  } catch {
    return { removed: 0, bytes: 0, skipped: 0 };
  }
  const referenced = db.getReferencedAttachmentNames();
  const cutoff = now - minAgeMs;
  let removed = 0;
  let bytes = 0;
  let skipped = 0;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(uploadsDir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || referenced.has(name) || stat.mtimeMs >= cutoff) continue;
    try {
      fs.unlinkSync(full);
      removed += 1;
      bytes += stat.size;
    } catch {
      skipped += 1;
    }
  }
  return { removed, bytes, skipped };
}

function startUploadsCleanup(db, uploadsDir, {
  intervalHours = 24,
  minAgeHours = 24,
  firstDelayMs = 30 * 1000,
  log = () => {},
} = {}) {
  if (!intervalHours || intervalHours <= 0) return null;
  const run = () => {
    try {
      const result = cleanupUploads(db, uploadsDir, { minAgeMs: minAgeHours * 3600 * 1000 });
      if (result.removed > 0 || result.skipped > 0) {
        log(`🧹 Dọn uploads: xóa ${result.removed} file rác (${(result.bytes / 1024).toFixed(1)} KB)`);
      }
    } catch (err) {
      log(`⚠️ Dọn uploads lỗi: ${err.message}`);
    }
  };
  const first = setTimeout(run, firstDelayMs);
  first.unref();
  const timer = setInterval(run, intervalHours * 3600 * 1000);
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { cleanupUploads, startUploadsCleanup };
