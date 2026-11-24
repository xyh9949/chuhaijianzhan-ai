import type { Data, InitialHistory } from '@puckeditor/core';
import { sameAiPageData } from './ai-page-edit';

const prefix = 'form-studio:canvas-history:';
const historiesByDocument = new Map<string, { entries: Data[]; index: number }>();
const storageKey = (actorId: string, document: string) => `${prefix}${actorId}:${document}`;

export function matchesCanvasData(first: Data, second: Data) {
  // Puck 重排对象键或补上空 zones 不构成修改。组件及组件内数组的顺序仍参与比较。
  return first === second || sameAiPageData({ ...first, zones: first.zones || {} }, { ...second, zones: second.zones || {} });
}

export function forgetEditorCanvasHistory(actorId: string, document: string) {
  const key = storageKey(actorId, document);
  historiesByDocument.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* 禁用浏览器存储时，当前画布仍可正常使用。 */ }
}

/** 同一标签页切换时保留完整历史，刷新只恢复邻近步骤。选区、设备宽度不随撤销还原。 */
export function rememberEditorCanvasHistory(actorId: string, document: string, entries: Data[], index: number) {
  const start = Math.max(index - 5, 0);
  const checkpoint = { entries: entries.slice(start, index + 3), index: index - start };
  const key = storageKey(actorId, document);
  historiesByDocument.delete(key);
  historiesByDocument.set(key, { entries, index });
  while (historiesByDocument.size > 12) historiesByDocument.delete(historiesByDocument.keys().next().value!);
  try {
    sessionStorage.setItem(key, JSON.stringify(checkpoint));
  } catch {
    // 浏览器空间不足时优先保存相邻一步，尤其是清空前的大页面；同次打开仍能使用内存历史。
    const previous = checkpoint.index > 0 ? checkpoint.index - 1 : checkpoint.index;
    try {
      sessionStorage.setItem(key, JSON.stringify({ entries: checkpoint.entries.slice(previous, previous + 2), index: checkpoint.index - previous }));
    } catch {
      try { sessionStorage.removeItem(key); } catch { /* 存储由浏览器控制。 */ }
    }
  }
}

/** 草稿仍从服务器加载。只有同一账号、标签页和对象的当前内容完全一致时，才恢复历史。 */
export function readEditorCanvasHistory(actorId: string, document: string, data: Data): InitialHistory | undefined {
  const key = storageKey(actorId, document);
  let checkpoint = historiesByDocument.get(key);
  if (!checkpoint) {
    try { checkpoint = JSON.parse(sessionStorage.getItem(key) || 'null') || undefined; } catch { return; }
    if (!checkpoint || !Array.isArray(checkpoint.entries) || checkpoint.entries.length > 8) return;
  }
  if (!Number.isInteger(checkpoint.index) || checkpoint.entries.length < 2) return;
  const current = checkpoint.entries[checkpoint.index];
  if (!checkpoint.entries.every(item => item && typeof item.root === 'object' && item.root !== null && Array.isArray(item.content)) || !current || !matchesCanvasData(current, data)) return;
  const [first, ...rest] = checkpoint.entries.map((entry, index) => ({ state: { data: index === checkpoint.index ? data : entry } }));
  return { histories: [first, ...rest], index: checkpoint.index, appendData: false };
}
