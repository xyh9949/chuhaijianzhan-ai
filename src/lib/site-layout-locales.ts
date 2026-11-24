import type { SiteLayoutSlot } from './types';

type LocaleSettings = { language?: string; locales?: { code: string; label: string }[] };
/** 隐藏优先；非默认语言使用自己的区块，无映射时保留旧站的基础布局行为。 */
export function effectiveLayoutBlockId(slot: SiteLayoutSlot | undefined, settings: LocaleSettings | undefined, locale: string): string | undefined {
  if (!slot || slot.mode === 'hidden') return undefined;
  if (locale !== (settings?.language || 'en') && slot.localeBlockIds?.[locale]) return slot.localeBlockIds[locale];
  return slot.mode === 'block' && slot.blockId ? slot.blockId : undefined;
}

/** 保留映射也是可恢复的原生引用，删除、发布和分发均须验证，不因暂时隐藏而遗失。 */
export function layoutBlockIds(slot: SiteLayoutSlot | undefined): string[] {
  if (!slot) return [];
  return [...new Set([...(slot.mode === 'block' && slot.blockId ? [slot.blockId] : []), ...Object.values(slot.localeBlockIds || {})].filter(id => typeof id === 'string' && !!id))];
}

/** 只处理真实头尾结构；Navigation节点没有mode，原菜单重定位保持原样。 */
export function rebaseLocaleBlocks<T>(value: T, from: LocaleSettings, to: LocaleSettings): T {
  if (!value || typeof value !== 'object' || !('mode' in value) || from.language === to.language) return value;
  const slot = value as T & SiteLayoutSlot;
  if (!slot.localeBlockIds || slot.mode === 'hidden') return value;
  const variants = { ...slot.localeBlockIds, ...(slot.mode === 'block' && slot.blockId ? { [from.language || 'en']: slot.blockId } : {}) };
  const blockId = variants[to.language || 'en'];
  if (!blockId) return value;
  return { ...slot, mode: 'block', blockId, localeBlockIds: Object.fromEntries(Object.entries(variants).filter(([code]) => code !== (to.language || 'en'))) };
}
