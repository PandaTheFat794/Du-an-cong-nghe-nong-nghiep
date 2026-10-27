// Cache câu trả lời LLM của bot theo câu hỏi đã chuẩn hóa (LRU + TTL).
// Mục đích: câu hỏi lặp lại không gọi API lại → tiết kiệm token.
const CACHE_MAX = 200;
const CACHE_TTL_MS = 24 * 3600 * 1000;

const cache = new Map(); // key -> { text, used, at }

function get(key, now = Date.now()) {
  if (!cache.has(key)) return null;
  const entry = cache.get(key);
  if (now - entry.at >= CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Đẩy lên cuối Map để LRU (Map giữ thứ tự chèn)
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function set(key, value, now = Date.now()) {
  cache.delete(key);
  cache.set(key, { ...value, at: now });
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

function clear() {
  cache.clear();
}

module.exports = { get, set, clear };
