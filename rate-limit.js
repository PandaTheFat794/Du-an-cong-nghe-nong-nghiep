// Giới hạn request trong bộ nhớ (đủ cho single-process; không dùng dependency ngoài).
// Cửa sổ trượt theo từng khóa (mặc định IP, hoặc userId nếu keyFn trả về id).
function createRateLimiter({ windowMs, max, message, keyFn }) {
  const hits = new Map(); // key -> [timestamps]

  setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) {
      const fresh = times.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (recent.length > max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = { createRateLimiter };
