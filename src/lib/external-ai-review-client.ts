import type { AiWritingTarget } from './ai-writing-types';

const key = 'form-studio:open-content-editor';
export type ExternalContentEditorRequest = { actorId: string; target: AiWritingTarget };

/** 只传已保存记录的定位信息；不把候选或编辑区副本写进另一个表单。 */
export function queueExternalContentEditor(actorId: string, target: AiWritingTarget) {
  sessionStorage.setItem(key, JSON.stringify({ actorId, target } satisfies ExternalContentEditorRequest));
}
export function readExternalContentEditor(actorId: string): ExternalContentEditorRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null') as ExternalContentEditorRequest | null;
    return value?.actorId === actorId && ['product', 'entry'].includes(value.target?.kind) && typeof value.target.id === 'string' && value.target.id.length <= 160 ? value : null;
  } catch { return null; }
}
export function clearExternalContentEditor(actorId: string) {
  try { if (readExternalContentEditor(actorId)) sessionStorage.removeItem(key); } catch { /* 编辑器已打开，不因入口清理失败重置表单。 */ }
}
