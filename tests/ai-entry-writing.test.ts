import assert from 'node:assert/strict';
import test from 'node:test';
import { appendRichWriting, entryAiFields, entryAiPresent, entryAiValue, mergeEntryAiReceipt, richWritingNeedsAppend, setEntryAiValues } from '../src/lib/ai-entry-writing';
import { richTextPlainText, textToRichText, type RichNode } from '../src/lib/presentation-content';
import type { ContentEntry, ContentModel } from '../src/lib/types';
import type { AiWritingReceiptInput } from '../src/lib/ai-writing-types';

const model: ContentModel = { id: 'model-news', name: '新闻', target: 'content', description: '', updated: '', fields: [
  { id: 'cover', key: 'cover', label: '封面', type: 'image', required: false },
  { id: 'excerpt', key: 'summary', label: '摘要', type: 'textarea', required: false },
  { id: 'body', key: 'body', label: '正文', type: 'textarea', required: false },
  { id: 'customer', key: 'customer', label: '内部客户备注', type: 'text', required: false },
] };
const entry = (): ContentEntry => ({ id: 'entry-one', modelId: model.id, title: '原题', status: 'draft', updated: '', locale: 'en', slug: 'original', customFields: { cover: '/images/sofa.jpg', body: '人工未保存正文', excerpt: '原摘要', customer: '不会发送的专用资料' } });

test('文章AI只开放识别出的正文摘要和搜索文字，旧纯文不因打开生成排版副本', () => {
  const current = entry(), before = structuredClone(current), fields = entryAiFields(current, model);
  assert.deepEqual(fields.map(field => field.key), ['title', 'customFields:body', 'customFields:excerpt', 'seoTitle', 'seoDescription']);
  assert.equal(fields.find(field => field.key === 'customFields:body')?.before, '人工未保存正文');
  assert.equal(fields.find(field => field.key === 'customFields:body')?.kind, 'richtext');
  assert.equal(entryAiPresent(current, 'seoTitle'), false);
  assert.deepEqual(current, before);
});

test('文章富文本采用成对更新文字镜像，其他排版和封面分类资料不变', () => {
  const current = { ...entry(), richTextFields: { excerpt: textToRichText('原摘要') } };
  const document: RichNode = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '采购问题' }] }, ...textToRichText('根据已确认资料写作。').content!] };
  const next = setEntryAiValues(current, [{ key: 'customFields:body', kind: 'richtext', value: document }]);
  assert.equal(next.customFields.body, richTextPlainText(document));
  assert.deepEqual(next.richTextFields?.body, document);
  assert.deepEqual(next.richTextFields?.excerpt, current.richTextFields.excerpt);
  assert.equal(next.customFields.cover, current.customFields.cover);
  assert.equal(next.customFields.customer, current.customFields.customer);
  assert.equal(next.locale, 'en'); assert.equal(next.slug, 'original'); assert.equal(next.title, '原题');
  assert.equal((current as ContentEntry).richTextFields?.body, undefined);
});

test('旧纯文的实际before可以撤回为原字符串，并只移除该正文的新增排版', () => {
  const original = entry(), before = entryAiValue(original, 'customFields:body', 'richtext');
  const applied = setEntryAiValues(original, [{ key: 'customFields:body', kind: 'richtext', value: textToRichText('AI正文') }]);
  const next = setEntryAiValues(applied, [{ key: 'customFields:body', kind: 'richtext', value: before, present: true }]);
  assert.equal(next.customFields.body, '人工未保存正文');
  assert.equal(next.richTextFields?.body, undefined);
  assert.deepEqual(next.customFields, original.customFields);
});

test('图文正文采取追加并逐字保留原图片与链接节点，文本正文允许常规替换', () => {
  const before: RichNode = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '已审核链接', marks: [{ type: 'link', attrs: { href: '/about' } }] }] },
    { type: 'image', attrs: { src: '/images/sofa.jpg', alt: '原图', caption: '原说明', width: 75, align: 'left' } },
  ] };
  assert.equal(richWritingNeedsAppend(before), true);
  assert.equal(richWritingNeedsAppend(textToRichText('普通正文')), false);
  const after = textToRichText('新增资料段落'), result = appendRichWriting(before, after);
  assert.deepEqual(result.content?.slice(0, before.content!.length), before.content);
  assert.deepEqual(result.content?.slice(before.content!.length), after.content);
  assert.deepEqual(before.content?.[1].attrs, { src: '/images/sofa.jpg', alt: '原图', caption: '原说明', width: 75, align: 'left' });
});

test('缺省字段撤回只删除本次字段，原字段和其他SEO保持', () => {
  const current = { ...entry(), seoDescription: '原搜索介绍', richTextFields: { body: textToRichText('原正文'), excerpt: textToRichText('原摘要') } };
  const next = setEntryAiValues(current, [{ key: 'seoTitle', kind: 'text', value: '新增搜索标题' }, { key: 'customFields:body', kind: 'richtext', value: null, present: false }]);
  assert.equal(next.customFields.body, undefined); assert.equal(next.richTextFields?.body, undefined);
  assert.deepEqual(next.richTextFields?.excerpt, current.richTextFields.excerpt);
  const reverted = setEntryAiValues(next, [{ key: 'seoTitle', kind: 'text', value: null, present: false }]);
  assert.equal(Object.hasOwn(reverted, 'seoTitle'), false); assert.equal(reverted.seoDescription, '原搜索介绍');
});

test('不允许字段、原型键、危险富文本及追加超限均拒绝且不污染输入', () => {
  const current = entry(), before = structuredClone(current);
  assert.throws(() => setEntryAiValues(current, [{ key: 'slug', kind: 'text', value: 'stolen' }]), /未允许/);
  assert.throws(() => setEntryAiValues(current, [{ key: 'customFields:__proto__', kind: 'text', value: 'x' }]), /填写项/);
  assert.throws(() => setEntryAiValues(current, [{ key: 'customFields:body', kind: 'richtext', value: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] } }]), /链接/);
  assert.throws(() => appendRichWriting(textToRichText('x'.repeat(40000)), textToRichText('y'.repeat(30000))), /60000/);
  assert.deepEqual(current, before);
});

test('第二次AI接管重叠字段时裁剪完整回执，原数组仍可用于逐次撤回恢复', () => {
  const first: AiWritingReceiptInput = { proposalId: 'awp-first', selectedKeys: ['title', 'seoTitle'], before: { title: '人工标题', seoTitle: null }, after: { title: '第一标题', seoTitle: '第一搜索标题' }, beforePresent: { title: true, seoTitle: false } };
  const second: AiWritingReceiptInput = { proposalId: 'awp-second', selectedKeys: ['title'], before: { title: '第一标题' }, after: { title: '第二标题' }, beforePresent: { title: true } };
  const previous = [first], result = mergeEntryAiReceipt(previous, second);
  assert.deepEqual(result[0], { proposalId: 'awp-first', selectedKeys: ['seoTitle'], before: { seoTitle: null }, after: { seoTitle: '第一搜索标题' }, beforePresent: { seoTitle: false } });
  assert.deepEqual(result[1], second);
  assert.deepEqual(previous, [first]);
  assert.deepEqual(first.selectedKeys, ['title', 'seoTitle']);
});
