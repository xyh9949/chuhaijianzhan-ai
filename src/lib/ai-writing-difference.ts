export type WritingDifferencePart = { kind: 'same' | 'added' | 'removed'; text: string };
export type WritingTextDifference = { parts: WritingDifferencePart[]; changed: boolean; simplified: boolean };

/** 仅比较可见文字，不解析HTML或猜测富文本结构；长文限制运算量，避免比较页阻塞。 */
export function writingTextDifference(before: string, after: string): WritingTextDifference {
  if (before === after) return { parts: before ? [{ kind: 'same', text: before }] : [], changed: false, simplified: false };
  const parts: WritingDifferencePart[] = [];
  const add = (kind: WritingDifferencePart['kind'], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text; else parts.push({ kind, text });
  };
  // 先去除相同头尾；按Unicode字符切分，中文和emoji不会截断成无效字符。
  const left = Array.from(before), right = Array.from(after);
  let prefix = 0, suffix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
  const oldText = left.slice(prefix, left.length - suffix).join(''), newText = right.slice(prefix, right.length - suffix).join('');
  const tokens = (text: string) => text.match(/\s+|[\p{Script=Han}]|[\p{L}\p{N}_]+|[^\s]/gu) || [];
  const a = tokens(oldText), b = tokens(newText);
  const simplified = a.length > 800 || b.length > 800 || a.length * b.length > 80_000;
  add('same', left.slice(0, prefix).join(''));
  if (simplified) {
    // 大范围重写只高亮连续替换区，保留全部文字；不伪装成逐词精确比较。
    add('removed', oldText); add('added', newText);
  } else {
    const width = b.length + 1, lengths = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] = a[i] === b[j] ? 1 + lengths[(i + 1) * width + j + 1] : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { add('same', a[i++]); j++; }
      else if (i < a.length && (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) add('removed', a[i++]);
      else add('added', b[j++]);
    }
  }
  add('same', suffix ? left.slice(-suffix).join('') : '');
  return { parts, changed: true, simplified };
}
