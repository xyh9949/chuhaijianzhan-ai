export interface AiRangeChoice { id: string; label: string; description: string; parentId?: string; kind?: string; unavailableReason?: string; }
/** 客户端只整理服务器单位身份；不推导props，不把细项全选自动提升成整组。 */
export function normalizeAiRangeChoices(units: AiRangeChoice[], ids: string[]) {
  const byId = new Map(units.map(unit => [unit.id, unit])), selected = new Set(ids);
  for (const id of ids) { let parent = byId.get(id)?.parentId, depth = 0; while (parent && depth++ < 20) { if (selected.has(parent)) { selected.delete(id); break; } parent = byId.get(parent)?.parentId; } }
  return [...new Set(ids)].filter(id => selected.has(id));
}
/** 点选内部项明确取消其整体范围；其余未点选内部变化不会被隐式带入。 */
export function toggleAiRangeChoice(units: AiRangeChoice[], ids: string[], id: string, checked: boolean) {
  const byId = new Map(units.map(unit => [unit.id, unit])), selected = new Set(ids), ancestors = new Set<string>();
  let parent = byId.get(id)?.parentId, depth = 0; while (parent && depth++ < 20) { ancestors.add(parent); parent = byId.get(parent)?.parentId; }
  for (const unit of units) { let owner = unit.parentId, count = 0; while (owner && count++ < 20) { if (owner === id) { selected.delete(unit.id); break; } owner = byId.get(owner)?.parentId; } }
  selected.delete(id); if (checked) { ancestors.forEach(owner => selected.delete(owner)); selected.add(id); }
  return normalizeAiRangeChoices(units, [...selected]);
}
