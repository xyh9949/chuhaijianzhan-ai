import type { AiWritingFact, AiWritingProfile } from './ai-writing-types';
import type { AiWritingSourceState } from './ai-writing-reuse-types';

/** 有引用却未读到状态时先核对；人工事实不会被假装为仍有原件可查。 */
export function briefReuseSourceGate(fact: AiWritingFact, state?: AiWritingSourceState): { blocked: boolean; message: string } {
  if (!fact.sourceRef) return { blocked: false, message: '' };
  if (!state) return { blocked: true, message: '暂时无法判断原来源状态，请读取最新资料后再选择；摘录仍保留。' };
  return { blocked: state.status === 'changed', message: state.status === 'unavailable' ? '原来源已失效或当前账号不可回查；这里只保留已确认摘录，请核对后使用。' : state.message };
}

/** 采用时重查确认、适用范围和来源，旧窗口曾选中过不构成继续采用的依据。 */
export function briefReuseSelectionError(profile: AiWritingProfile, selected: string[], states?: Record<string, AiWritingSourceState>): string {
  for (const id of selected) {
    const fact = profile.facts.find(item => item.id === id);
    if (!fact || !fact.confirmed || fact.scope !== 'company') return '所选资料已删除、取消确认或变更适用范围，请读取最新资料并重新核对；当前选择保持。';
    const gate = briefReuseSourceGate(fact, states?.[id]);
    if (gate.blocked) return `${fact.label}：${gate.message}`;
  }
  return '';
}
