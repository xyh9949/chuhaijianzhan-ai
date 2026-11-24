import type { ContentEntry, ContentModel } from './types';
import type { AiWritingField, AiWritingReceiptInput, AiWritingValue } from './ai-writing-types';
import { entryWritingFields } from './content-writing';
import { richTextErrors, richTextPlainText, type RichNode } from './presentation-content';

/** 只开放文章已有文字项，正文沿用原富文本与纯文字镜像，不触碰封面/分类/语言等资料。 */
export function entryAiFields(entry: ContentEntry, model: ContentModel): AiWritingField[] {
  const { body, excerpt } = entryWritingFields(model);
  return [
    { key: 'title', label: '标题', kind: 'text' as const, maxLength: 200, before: entry.title },
    ...(body ? [{ key: `customFields:${body.id}`, label: body.label, kind: 'richtext' as const, maxLength: 30000, before: entryAiValue(entry, `customFields:${body.id}`, 'richtext') }] : []),
    ...(excerpt ? [{ key: `customFields:${excerpt.id}`, label: excerpt.label, kind: entry.richTextFields?.[excerpt.id] ? 'richtext' as const : 'text' as const, maxLength: 30000, before: entryAiValue(entry, `customFields:${excerpt.id}`, entry.richTextFields?.[excerpt.id] ? 'richtext' : 'text') }] : []),
    { key: 'seoTitle', label: '搜索标题', kind: 'text' as const, maxLength: 200, before: entry.seoTitle ?? null },
    { key: 'seoDescription', label: '搜索介绍', kind: 'text' as const, maxLength: 500, before: entry.seoDescription ?? null },
  ];
}

export function entryAiValue(entry: ContentEntry, key: string, kind: AiWritingField['kind']): AiWritingValue {
  if (key.startsWith('customFields:')) {
    const id = key.slice(13);
    // 旧纯文本保持字符串，回执撤销时才能恢复“尚无排版副本”的原始形状。
    if (kind === 'richtext' && entry.richTextFields?.[id]) return entry.richTextFields[id];
    const value = entry.customFields[id];
    return typeof value === 'string' ? value : null;
  }
  return key === 'title' ? entry.title : key === 'seoTitle' ? entry.seoTitle ?? null : key === 'seoDescription' ? entry.seoDescription ?? null : null;
}

export function entryAiPresent(entry: ContentEntry, key: string): boolean {
  return key.startsWith('customFields:') ? Object.hasOwn(entry.customFields, key.slice(13)) && entry.customFields[key.slice(13)] !== undefined : Object.hasOwn(entry, key) && entry[key as 'title' | 'seoTitle' | 'seoDescription'] !== undefined;
}

/** AI填入与撤回都仅修改已核对的字段；富文本必须先完整校验，再同步文字投影。 */
export function setEntryAiValues(entry: ContentEntry, changes: { key: string; kind: AiWritingField['kind']; value: AiWritingValue; present?: boolean }[]): ContentEntry {
  const next = structuredClone(entry);
  for (const change of changes) {
    const { key, kind, value } = change;
    if (key.startsWith('customFields:')) {
      const id = key.slice(13);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('正文填写项已变化，请重新打开AI写作');
      if (change.present === false || value === null) {
        delete next.customFields[id];
        if (next.richTextFields) delete next.richTextFields[id];
      } else if (kind === 'richtext') {
        if (typeof value === 'string') {
          next.customFields[id] = value;
          if (next.richTextFields) delete next.richTextFields[id];
        } else {
          const problems = richTextErrors(value);
          if (problems.length) throw new Error(problems.join('；'));
          next.customFields[id] = richTextPlainText(value);
          next.richTextFields = { ...next.richTextFields, [id]: structuredClone(value) };
        }
      } else {
        if (typeof value !== 'string') throw new Error('AI文字格式无效，原内容已保留');
        next.customFields[id] = value;
        if (next.richTextFields) delete next.richTextFields[id];
      }
    } else if (key === 'title' || key === 'seoTitle' || key === 'seoDescription') {
      if (change.present === false || value === null) {
        if (key === 'title') next.title = ''; else delete next[key];
      } else {
        if (typeof value !== 'string') throw new Error('AI文字格式无效，原内容已保留');
        next[key] = value;
      }
    } else throw new Error('AI试图修改未允许的填写项，原内容已保留');
  }
  return next;
}

/** 有插图或文字链接的旧正文默认追加，完整保留原文及素材；用户仍可在编辑区自行重排。 */
export function richWritingNeedsAppend(doc: RichNode): boolean {
  return doc.type === 'image' || !!doc.marks?.some(mark => mark.type === 'link') || !!doc.content?.some(richWritingNeedsAppend);
}

export function appendRichWriting(before: RichNode, after: RichNode): RichNode {
  const next: RichNode = { type: 'doc', content: [...structuredClone(before.content || []), ...structuredClone(after.content || [])] };
  const problems = richTextErrors(next);
  if (problems.length) throw new Error(problems.join('；'));
  return next;
}

/** 后一次AI只接管重叠字段；旧回执的键和值一起裁剪，仍可保存未被覆盖的其它建议。 */
export function mergeEntryAiReceipt(previous: AiWritingReceiptInput[], next: AiWritingReceiptInput): AiWritingReceiptInput[] {
  const selected = new Set(next.selectedKeys);
  const keep = (values: Record<string, AiWritingValue>, keys: string[]) => Object.fromEntries(keys.map(key => [key, structuredClone(values[key])]));
  return [...previous.filter(item => item.proposalId !== next.proposalId).map(item => {
    const keys = item.selectedKeys.filter(key => !selected.has(key));
    return { proposalId: item.proposalId, selectedKeys: keys, before: keep(item.before, keys), after: keep(item.after, keys), ...(item.beforePresent ? { beforePresent: Object.fromEntries(keys.map(key => [key, item.beforePresent![key]])) } : {}) };
  }).filter(item => item.selectedKeys.length), next];
}
