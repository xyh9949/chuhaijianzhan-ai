import { richTextErrors, richTextPlainText, type RichNode } from './presentation-content';
import type { AiTranslationField, AiTranslationTerm, AiTranslationValue } from './ai-translation-types';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (value: unknown) => typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<\s*\/?[a-z][\w:-]*(?:\s[^>]*|\s*\/?)>|<!|<\?|(?:javascript|vbscript)\s*:/i.test(value);
const numberPattern = '[-+]?\\d+(?:[.,]\\d+)*(?:\\s*[×xX]\\s*\\d+(?:[.,]\\d+)*)?(?:\\s*(?:inches|pieces|inch|tons|pcs|lbs|MPa|kW|mm|cm|km|kg|mg|ml|mL|Hz|Pa|bar|°C|°F|℃|℉|ft|lb|oz|in|m|g|L|V|W|%|米|厘米|毫米|公斤|千克|克|升|伏|瓦))?';
const numbers = (value: string) => value.match(new RegExp(numberPattern, 'g')) || [];
// 中文/日文名称常直接连接其他文字，不套用英语单词边界，避免固定品牌漏保护。
const literalPattern = (value: string) => /^[A-Za-z0-9].*[A-Za-z0-9]$|^[A-Za-z0-9]$/.test(value) ? `(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])` : escape(value);
const includesFixed = (value: string, fixed: string[]) => fixed.filter(Boolean).some(item => new RegExp(literalPattern(item), 'iu').test(value));
/** 更长的术语也不能吞掉其内部的固定品牌/型号；原样术语还原实际匹配大小写。 */
export function assertFixedTranslationTerms(terms: AiTranslationTerm[], protectedTerms: string[]) {
  if (terms.some(term => includesFixed(term.source, protectedTerms) && term.source !== term.target)) throw new Error('包含固定品牌或型号的术语只能原样保留，请单独指定其他词的译法');
}

/** 术语只是本次人工确认的翻译约束，不允许借术语表换算数值、型号或注入标签。 */
export function normalizeTranslationTerms(value: unknown): AiTranslationTerm[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('本次术语最多30条');
  const seen = new Set<string>();
  return value.map(raw => {
    if (!object(raw) || Object.keys(raw).some(key => !['source', 'target'].includes(key)) || !plain(raw.source) || !plain(raw.target) || !(raw.source as string).trim() || !(raw.target as string).trim() || (raw.source as string).length > 100 || (raw.target as string).length > 100) throw new Error('请填写有效的原术语和目标用词，每项最多100字符');
    const source = (raw.source as string).trim(), target = (raw.target as string).trim();
    if (seen.has(source.toLocaleLowerCase()) || JSON.stringify(numbers(source)) !== JSON.stringify(numbers(target))) throw new Error('术语不可重复，也不能更改数字或单位');
    seen.add(source.toLocaleLowerCase()); return { source, target };
  });
}

export interface TranslationSlot { id: string; text: string; }
type Slot = TranslationSlot & { path: number[]; replacements: { anchor: string; value: string }[]; original: string; };
export interface TranslationTask { fields: AiTranslationField[]; slots: Slot[]; }

/** 只向模型发送文字槽位；图片、链接和富文本骨架留在本机，不能被模型增删或改写。 */
export function buildTranslationTask(fields: AiTranslationField[], terms: AiTranslationTerm[], protectedTerms: string[], nonce: string): TranslationTask {
  assertFixedTranslationTerms(terms, protectedTerms);
  const slots: Slot[] = []; let characters = 0;
  const values = [...terms.map(item => item.source), ...protectedTerms.filter(Boolean)].sort((a, b) => b.length - a.length);
  const protectedPattern = values.map(literalPattern);
  const pattern = new RegExp([...protectedPattern, numberPattern].join('|'), 'giu');
  const slot = (text: string, path: number[], fieldIndex: number) => {
    if (!text.trim()) return;
    if (!plain(text) || text.includes(`FS${nonce}`)) throw new Error('待翻译正文包含不支持的文本格式');
    characters += text.length;
    const replacements: Slot['replacements'] = [], id = `f${fieldIndex}s${slots.length}`;
    const masked = text.replace(pattern, match => {
      const term = terms.find(item => item.source.toLocaleLowerCase() === match.toLocaleLowerCase()), anchor = `⟦FS${nonce}_${slots.length}_${replacements.length}⟧`;
      replacements.push({ anchor, value: term && !includesFixed(term.source, protectedTerms) ? term.target : match }); return anchor;
    });
    slots.push({ id, path, text: masked, replacements, original: text });
  };
  fields.forEach((field, index) => {
    if (typeof field.source === 'string') slot(field.source, [index], index);
    else if (field.source) {
      if (richTextErrors(field.source).length) throw new Error('待翻译图文格式无效');
      const walk = (node: RichNode, path: number[]) => { if (node.type === 'text') slot(node.text!, [index, ...path], index); node.content?.forEach((child, childIndex) => walk(child, [...path, childIndex])); };
      walk(field.source, []);
    }
  });
  if (!slots.length) throw new Error('所选字段没有需要翻译的文字');
  if (slots.length > 400 || characters > 24000) throw new Error('一次翻译最多24000字符和400段文字，请减少所选字段；不会截断或自动多次收费');
  return { fields: structuredClone(fields), slots };
}

/** 输出必须逐槽覆盖；锚点数量和数字单位核对后再还原，任何错误都拒绝整份建议。 */
export function compileTranslationTask(task: TranslationTask, value: unknown): (string | RichNode)[] {
  if (!object(value) || Object.keys(value).some(key => key !== 'translations') || !Array.isArray(value.translations) || value.translations.length !== task.slots.length) throw new Error('翻译结果没有完整覆盖所选文字');
  const output = new Map<string, string>();
  for (const raw of value.translations) {
    if (!object(raw) || Object.keys(raw).some(key => !['id', 'text'].includes(key)) || typeof raw.id !== 'string' || output.has(raw.id) || !task.slots.some(slot => slot.id === raw.id) || !plain(raw.text) || !(raw.text as string).trim() || (raw.text as string).length > 60000) throw new Error('翻译结果文字标识或格式无效');
    output.set(raw.id, raw.text as string);
  }
  const values: AiTranslationValue[] = task.fields.map(field => structuredClone(field.source));
  for (const slot of task.slots) {
    let text = output.get(slot.id)!;
    const actual = text.match(/⟦FS[^⟧]*⟧/g) || [], expected = slot.replacements.map(item => item.anchor);
    if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error('翻译改动了受保护的品牌、术语、数字或单位，请重新核对');
    for (const replacement of slot.replacements) text = text.replace(replacement.anchor, replacement.value);
    const intended = slot.replacements.reduce((result, item) => result.replace(item.anchor, item.value), slot.text);
    if (JSON.stringify(numbers(text).sort()) !== JSON.stringify(numbers(intended).sort())) throw new Error('翻译增加或改动了数字/单位，当前内容保持');
    if (slot.path.length === 1) values[slot.path[0]] = text;
    else { let node = values[slot.path[0]] as RichNode; for (const index of slot.path.slice(1)) node = node.content![index]; node.text = text; }
  }
  return values.map((value, index) => {
    const field = task.fields[index];
    if (!value || typeof value === 'string' && value.length > field.maxLength || typeof value === 'object' && (richTextErrors(value).length || richTextPlainText(value).length > field.maxLength)) throw new Error(`${field.label}翻译后超过格式或长度限制`);
    return value;
  });
}
