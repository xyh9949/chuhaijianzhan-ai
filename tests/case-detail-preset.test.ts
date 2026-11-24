import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentData, Data } from '@puckeditor/core';
import { createContentColumn } from '../src/lib/content-columns';
import { createContentDesignData } from '../src/lib/content-design-presets';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render } from '@puckeditor/core/rsc';
import { createEmptyDraft } from '../src/server/seed';
import { initialState } from '../src/lib/demo';
import { createSiteConfig } from '../src/lib/site-render-config';
import { resolveSitePage } from '../src/lib/site-routing';
import { collectReferences, validateDraft, validatePageData } from '../src/server/validation';
import { contentBindingErrors, fieldChoices } from '../src/lib/content-binding';
import { richTextPlainText, type RichNode } from '../src/lib/presentation-content';
import { themeNodeCss } from '../src/lib/theme-design';
import type { SiteSnapshot } from '../src/server/types';
import protocol from '../src/lib/protocol.json';
import { compileAiDetailDesign } from '../src/lib/ai-detail-design';

function nodes(data: Pick<Data, 'content'>): ComponentData[] {
  const result: ComponentData[] = [];
  const visit = (items: ComponentData[]) => { for (const item of items) { result.push(item); if (Array.isArray(item.props.content)) visit(item.props.content); } };
  visit(data.content); return result;
}

test('新案例栏目先介绍标题与摘要再展示封面，完整正文仍绑定真实字段', () => {
  const { model, data } = createContentColumn('case', 'detail-red', []), all = nodes(data);
  const summary = model.fields.find(field => field.key === 'summary')!, body = model.fields.find(field => field.key === 'body')!, cover = model.fields.find(field => field.key === 'cover')!;
  const bound = (field: string, target = 'text') => all.findIndex(node => node.props.bindings?.[target]?.field === `field:${field}`);
  assert.equal(all.filter(node => node.type === 'Heading' && node.props.level === 'h1').length, 1);
  assert.ok(bound(summary.id) < bound(cover.id, 'src'), '摘要应在封面之前，先让客户理解当前案例');
  assert.ok(bound(body.id) > bound(cover.id, 'src'));
  assert.equal(all.filter(node => node.props.bindings?.text?.field === `field:${body.id}`).length, 1);
});

function fixture() {
  const content = createEmptyDraft(), preset = createContentColumn('case', 'detail-real', []), fields = preset.model.fields;
  const id = (key: string) => fields.find(field => field.key === key)!.id;
  fields.push({ id: 'actual-area', key: 'area', label: '已提供面积', type: 'number', unit: 'm²', required: false }, { id: 'actual-approved', key: 'approved', label: '已提供状态', type: 'boolean', required: false });
  const rich: RichNode = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Supplied case scope' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Original verified rich story for case B.', marks: [{ type: 'bold' }] }] }, { type: 'image', attrs: { src: '/images/chair.jpg', alt: 'Original supplied body illustration' } }] };
  content.settings.language = 'en'; content.media = initialState.media; content.contentModels = [preset.model];
  content.pages.push({ ...preset.page, status: 'published' });
  content.contentEntries = [
    { id: 'case-a', slug: 'case-a', title: 'Supplied case A', modelId: preset.model.id, status: 'published', updated: '', customFields: { [id('cover')]: '/images/chair.jpg', [id('summary')]: 'Original summary A', [id('body')]: 'Original full story A', [id('country')]: 'Supplied region A' } },
    { id: 'case-b', slug: 'case-b', title: 'Supplied case B', modelId: preset.model.id, status: 'published', updated: '', customFields: { [id('cover')]: '/images/interior.jpg', [id('summary')]: 'Original summary B', [id('body')]: richTextPlainText(rich), [id('country')]: 'Supplied region B', 'actual-area': 0, 'actual-approved': false }, richTextFields: { [id('body')]: rich } },
    { id: 'case-no-cover', slug: 'case-no-cover', title: 'Supplied case without cover', modelId: preset.model.id, status: 'published', updated: '', customFields: { [id('summary')]: 'Supplied concise introduction.', [id('body')]: 'Supplied long story without an image. '.repeat(60) } },
  ];
  // 保存A只作编辑预览样本；真实B网址必须读取B，不能把样本静态复制进模板。
  const data = createContentDesignData({ name: 'Case detail', source: 'entry', model: preset.model, recordId: 'case-a', kind: 'detail', detailKind: 'case' });
  content.editorData[preset.page.id] = data;
  return { content, preset, data, id, rich };
}
function htmlFor(snapshot: SiteSnapshot, slug: string) {
  const resolved = resolveSitePage(snapshot, ['cases', slug]); assert.ok(resolved?.entry);
  return renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...snapshot, pageId: resolved.page.id, previewEntryId: resolved.entry.id, currentPath: `/cases/${slug}` }), data: resolved.data }));
}

test('案例详情有效保存，双记录网址绑定、完整富文、原图及0/false均保留', () => {
  const { content, data, id, rich } = fixture(), original = JSON.stringify(content);
  assert.doesNotThrow(() => validateDraft(content));
  const snapshot = { ...content, schemaVersion: protocol.snapshot } as SiteSnapshot, html = htmlFor(snapshot, 'case-b');
  assert.match(html, /Supplied case B/); assert.doesNotMatch(html, /Supplied case A|Original summary A|Original full story A/);
  assert.match(html, /Original summary B/); assert.match(html, /<strong>Original verified rich story for case B\.<\/strong>/);
  assert.match(html, /Original supplied body illustration/); assert.match(html, /0 m²/); assert.match(html, />No<\/p>/);
  assert.ok(html.indexOf('Original summary B') < html.indexOf('src="/images/interior.jpg"'));
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.deepEqual(content.contentEntries![1].richTextFields![id('body')], rich);
  assert.equal(JSON.stringify(content), original); assert.equal(nodes(data).filter(node => node.props.bindings?.text?.field === `field:${id('body')}`).length, 1);
});

test('无封面案例不输出破图占位，长文完整且没有捏造的案例章节', () => {
  const { content } = fixture(), html = htmlFor({ ...content, schemaVersion: protocol.snapshot } as SiteSnapshot, 'case-no-cover');
  assert.doesNotMatch(html, /<img\b/); assert.match(html, /Supplied case without cover/);
  assert.equal((html.match(/Supplied long story without an image\./g) || []).length, 60);
  assert.doesNotMatch(html, /Original summary A|Challenge and solution|Project results/);
});

test('案例图库随真实记录输出整组图片和顺序，空值省略，字段与发布引用可校验', () => {
  const { content, data, id } = fixture();
  const galleryField = id('gallery');
  content.contentEntries![0].customFields[galleryField] = ['/images/interior.jpg'];
  content.contentEntries![1].customFields[galleryField] = ['/images/sofa.jpg', '/images/studio.jpg'];
  const snapshot = { ...content, schemaVersion: protocol.snapshot } as SiteSnapshot;
  const gallery = nodes(data).find(node => node.type === 'Gallery')!;
  assert.deepEqual(gallery.props.images, [], '模板没有写死预览记录的素材');
  assert.equal(gallery.props.bindings.images.field, `field:${galleryField}`);
  assert.deepEqual(fieldChoices('entry', content.contentModels![0], 'images').map(field => field.value), [`field:${galleryField}`]);
  assert.doesNotThrow(() => validatePageData(data, 'Case gallery', true));
  assert.deepEqual(contentBindingErrors(snapshot, true), []);
  const before = JSON.stringify(content);
  const html = htmlFor(snapshot, 'case-b');
  assert.equal((html.match(/class="ant-btn[^"]* site-gallery-open/g) || []).length + (html.match(/class="site-gallery-open/g) || []).length, 2);
  assert.match(html, /src="\/images\/sofa\.jpg"/);
  assert.match(html, /src="\/images\/studio\.jpg"/);
  assert.ok(html.indexOf('src="/images/sofa.jpg"') < html.indexOf('src="/images/studio.jpg"'));
  assert.match(htmlFor(snapshot, 'case-a'), /class="[^"]*site-gallery[^"]*"/);
  assert.doesNotMatch(htmlFor(snapshot, 'case-a'), /src="\/images\/sofa\.jpg"/);
  assert.doesNotMatch(htmlFor(snapshot, 'case-no-cover'), /site-gallery/);
  assert.ok(collectReferences(snapshot).urls.has('/images/sofa.jpg'));
  assert.equal(JSON.stringify(content), before);
});

test('新案例继承实时主题与标题字体，不冻结配色，手机只留一层20px', () => {
  const { content, data } = fixture(), all = nodes(data), heading = all.find(node => node.type === 'Heading')!;
  for (const node of all.filter(node => ['Heading', 'Text'].includes(node.type))) { assert.equal(node.props.color, undefined); assert.equal(node.props.design.desktop.color, 'inherit'); assert.equal(node.props.text, ''); }
  assert.doesNotMatch(JSON.stringify(data), /#222a25|#657084|#ffffff/);
  assert.equal(data.content[0].props.design.mobile.paddingLeft, 20);
  for (const node of all.filter(node => node.type === 'Container').slice(1)) assert.equal(node.props.design.mobile.paddingLeft, 0);
  const body = all.find(node => node.props.nodeLabel === '案例完整正文')!; assert.equal(body.props.design.desktop.maxWidth, 780);
  content.theme = { ...content.theme, text: '#eef2f7', background: '#101820', headingFont: 'Georgia' };
  const html = htmlFor({ ...content, schemaVersion: protocol.snapshot } as SiteSnapshot, 'case-b');
  assert.match(html, /--editor-site-text:#eef2f7/); assert.match(html, /--editor-site-bg:#101820/); assert.match(html, /font-family:Georgia/);
  assert.doesNotMatch(themeNodeCss(content.theme, heading.props.id, { design: heading.props.design }, 'Heading'), /font-family:inherit!important/);
  assert.doesNotThrow(() => validateDraft(content));
});

test('推荐案例起点明确启用，卡片/产品/新闻团队与旧通用模板保持原入口', () => {
  const { preset } = fixture();
  const legacy = createContentDesignData({ name: 'Legacy', source: 'entry', model: preset.model, kind: 'detail' });
  assert.equal(legacy.content[0].props.content[0].type, 'Image');
  const card = createContentDesignData({ name: 'Card', source: 'entry', model: preset.model, kind: 'card', detailKind: 'case' });
  assert.equal(card.content[0].props.content[0].type, 'Image'); assert.ok(card.content[0].props.content.some((node: ComponentData) => node.type === 'ActionButton'));
  for (const kind of ['news', 'team'] as const) assert.equal(createContentColumn(kind, 'legacy', []).data.content[0].type, 'Heading');
  assert.throws(() => createContentDesignData({ name: 'Invalid', source: 'product', model: preset.model, kind: 'detail', detailKind: 'case' }), /内容栏目/);
});

test('新案例起点可用既有AI原生命令重组图文简报，动态富文和锁定保护不退化', () => {
  const { content, data, id } = fixture(), all = nodes(data), identity = all.find(node => node.props.nodeLabel === '案例标题与真实简介')!, facts = all.find(node => node.props.nodeLabel === '已填写的案例资料')!, cover = all.find(node => node.props.bindings?.src?.field === `field:${id('cover')}`)!, outer = data.content[0];
  content.pageTemplates = [{ id: 'case-layout', name: 'Case layout', description: '', kind: 'entry', modelId: content.contentModels![0].id, data, updated: '' }];
  const request = { templateId: 'case-layout', expectedRevision: 0, instruction: '桌面封面与真实资料并列，手机保持标题简介优先，完整正文保留。', preserveText: true };
  const compiled = compileAiDetailDesign(content, request, { summary: '将封面与真实资料安排为原生简报，保留动态正文。', warnings: [], operations: [
    { kind: 'insert', parentId: outer.props.id, index: 1, node: { tempId: 'new-case-brief', type: 'Container', design: { desktop: { columns: 3, gap: 32 }, mobile: { columns: 1, gap: 24 } } } },
    { kind: 'move', id: cover.props.id, parentId: 'new-case-brief', index: 0 },
    { kind: 'move', id: facts.props.id, parentId: 'new-case-brief', index: 1 },
    { kind: 'design', id: cover.props.id, design: { desktop: { columnSpan: 2 }, mobile: { columnSpan: 1 } } },
  ] }, 'case-preset-design');
  assert.doesNotThrow(() => validateDraft(compiled.candidate));
  assert.deepEqual(compiled.candidate.contentEntries, content.contentEntries); assert.deepEqual(compiled.candidate.contentModels, content.contentModels);
  const boundBody = nodes(compiled.data).find(node => node.props.bindings?.text?.field === `field:${id('body')}`)!;
  assert.deepEqual(boundBody.props.bindings, nodes(data).find(node => node.props.bindings?.text?.field === `field:${id('body')}`)!.props.bindings);
  assert.equal(nodes(compiled.data).filter(node => node.type === 'Heading' && node.props.level === 'h1').length, 1);
  identity.props.locked = true;
  assert.throws(() => compileAiDetailDesign(content, request, { summary: '改祖先间距', warnings: [], operations: [{ kind: 'design', id: outer.props.id, design: { mobile: { paddingTop: 10 } } }] }, 'case-lock'), /锁定/);
});
