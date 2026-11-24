'use client';
import type { ContentEntry, Product, StudioState } from './types';
import type { AiWritingReceiptInput, AiWritingSaveAttempt, AiWritingTarget } from './ai-writing-types';
import { request, RequestError, type StudioEnvelope } from './studio-client';

export type WritingRecord = Product | ContentEntry;
export type PendingWritingSave = { id: string; target: AiWritingTarget; record: WritingRecord };
export class WritingSaveUncertainError extends Error {
  constructor(public pending: PendingWritingSave) { super('尚未收到保存确认，当前输入已保留。请先核对保存结果，不要重复提交。'); }
}
/** 一次保存只发一次；完成标记与撤销字段分开，即使没有可撤字段也能核实本次操作。 */
export async function saveWritingDraft(env: StudioEnvelope, patch: Partial<StudioState>, receipts: AiWritingReceiptInput[], target: AiWritingTarget, record: WritingRecord) {
  const pending: PendingWritingSave = { id: `aws-${crypto.randomUUID()}`, target, record: structuredClone(record) };
  try {
    const value = await request<StudioEnvelope & { writingWarnings?: string[]; writingSaveAttempt?: AiWritingSaveAttempt }>('/api/ai/writing/save', { method: 'POST', body: JSON.stringify({ expectedRevision: env.revision, patch, receipts, saveAttemptId: pending.id }) });
    if (!value.state || typeof value.revision !== 'number' || value.writingSaveAttempt?.id !== pending.id) throw new Error('保存确认不完整');
    return value;
  } catch (cause) {
    if (cause instanceof RequestError && cause.status >= 400 && cause.status < 500) throw cause;
    throw new WritingSaveUncertainError(pending);
  }
}
const labels: Record<string, string> = { name:'产品名称', title:'标题', sku:'型号', category:'分类', description:'产品介绍', detailContent:'产品图文详情', material:'材质', image:'封面图片', images:'产品图片', customFields:'栏目资料', richTextFields:'正文排版', seoTitle:'搜索标题', seoDescription:'搜索介绍', seoImage:'分享图片', locale:'语言', slug:'网址', status:'内容状态', modelId:'所属栏目', termIds:'分类标签', specifications:'产品参数', sortOrder:'显示顺序', noindex:'搜索可见性', translationGroupId:'语言版本', translationState:'翻译状态' };
/** 只归一化原表单的缺省空值，不忽略有效参数/正文/图片；更新时间由服务器维护，不参与内容比较。 */
function normalized(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.length ? value.map(item => normalized(item)) : undefined;
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([name,item]) => [name, normalized(item)] as const).filter(([,item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}
export function writingRecordDifferences(local: WritingRecord, server?: WritingRecord) {
  if (!server) return [{ key:'record', label:'整条内容', local:'当前输入仍在编辑区', server:'服务器中未找到此内容' }];
  const comparable=(record:WritingRecord)=>{const value={...record} as Record<string,unknown>;delete value.updated;if(value.noindex===false)delete value.noindex;if(value.sortOrder===0)delete value.sortOrder;for(const key of ['name','sku','category','material','description','title','slug','seoTitle','seoDescription'])if(typeof value[key]==='string')value[key]=(value[key] as string).trim();return normalized(value) as Record<string,unknown>;};
  const left=comparable(local),right=comparable(server);
  return [...new Set([...Object.keys(left),...Object.keys(right)])].filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key])).map(key => ({ key, label:labels[key] || '其他资料', local:left[key], server:right[key] }));
}
export function writingTargetRecord(env: StudioEnvelope, target: AiWritingTarget): WritingRecord | undefined {
  return target.kind === 'product' ? env.state.products.find(item => item.id === target.id) : env.state.contentEntries?.find(item => item.id === target.id);
}
