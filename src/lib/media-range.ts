/** 单一字节范围用于视频拖动进度；不接受多段或越界范围，避免隐式放大响应。 */
export function mediaByteRange(header: string, length: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !Number.isSafeInteger(length) || length < 1 || !match[1] && !match[2]) return;
  let start: number, end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) return; start = Math.max(0, length - suffix); end = length - 1; }
  else { start = Number(match[1]); if (match[2] && !Number.isSafeInteger(Number(match[2]))) return; end = match[2] ? Math.min(Number(match[2]), length - 1) : length - 1; }
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < length && end >= start ? { start, end } : undefined;
}
