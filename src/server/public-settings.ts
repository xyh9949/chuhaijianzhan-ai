import type { PublicSettings } from './types';

/** 发布快照和差异诊断共用公开字段。待核对事实不应进入快照，也不应被计为待发布。 */
export function publicSettings(settings: PublicSettings): PublicSettings {
  const { name, description, email, language, locales, publicUrl } = settings;
  let discovery: PublicSettings['discovery'];
  if (settings.discovery) {
    const { facts, ...rest } = structuredClone(settings.discovery);
    const reviewed = facts?.filter(fact => fact.status === 'reviewed');
    const projected = { ...rest, ...(reviewed?.length ? { facts: reviewed } : {}) };
    // 历史快照的空事实列表与没有事实等价，避免仅新增私人事实时误报变更。
    if (Object.keys(projected).length) discovery = projected;
  }
  return { name, description, email, language, ...(locales ? { locales } : {}), ...(discovery ? { discovery } : {}), ...(publicUrl ? { publicUrl } : {}) };
}
