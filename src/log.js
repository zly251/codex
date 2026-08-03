// 服务端实时操作日志（内存环形缓冲，供前端轮询展示）
const MAX = 200;
let seq = 0;
const buffer = [];

export function add(msg) {
  seq += 1;
  const entry = { id: seq, t: new Date().toISOString(), msg: String(msg || "") };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  try { console.log("[log] " + entry.msg); } catch (e) {}
  return entry;
}

export function list(limit = 50) {
  return buffer.slice(-limit);
}

export function clear() {
  buffer.length = 0;
}