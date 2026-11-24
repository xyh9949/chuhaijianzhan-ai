import protocol from '../src/lib/protocol.json';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { RichDocument, presentationComponents } from '../src/lib/presentation-components';
import { presentationErrors, presentationMediaErrors, richTextErrors, textToRichText, videoSource } from '../src/lib/presentation-content';
import { comparisonTableDefaults } from '../src/lib/comparison-table';
import { projectTimelineDefaults } from '../src/lib/project-timeline';
import { imageComparisonDefaults } from '../src/lib/image-comparison';
import { collectNativeSiteTranslationFields, writeNativeSiteTranslationFields } from '../src/lib/ai-site-translation';
import { createInitialDraft } from '../src/server/seed';
import { mediaByteRange } from '../src/lib/media-range';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, patchStudio, getStudioEnvelope, readRelease } from '../src/server/studio';
import { publishSite, activateRelease, restoreDraft } from '../src/server/publication';
import { uploadMedia, readMediaFile, deleteMedia } from '../src/server/media';
import { collectReferences, validatePageData } from '../src/server/validation';
import { readPreviewMediaBlob } from '../src/lib/preview-media';
import { createSiteConfig } from '../src/lib/site-render-config';
import { Render } from '@puckeditor/core/rsc';

test('富文本JSON白名单拒绝脚本/事件/危险链接、层级错误与超长，文字始终转义', () => {
  const doc = textToRichText('<script>alert(1)</script>\n\nA real paragraph');
  assert.deepEqual(richTextErrors(doc), []);
  const html = renderToStaticMarkup(React.createElement(RichDocument, { doc }));
  assert.match(html, /&lt;script&gt;/); assert.ok(!html.includes('<script>'));
  assert.ok(richTextErrors({ type: 'doc', content: [{ type: 'script', text: 'alert(1)' }] }).length);
  assert.ok(richTextErrors({ type: 'doc', content: [{ type: 'text', text: 'invalid hierarchy' }] }).length);
  assert.ok(richTextErrors({ type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' } }] }).length);
  for (const href of ['javascript:alert(1)', 'data:text/html,test', '//invalid.example']) assert.ok(richTextErrors({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] }] }] }).length);
  assert.ok(richTextErrors(textToRichText('a'.repeat(60001))).length);
});
test('富文本标题、粗斜体、列表、安全链接以及静态Text显式转换保持文字', () => {
  const doc = { type: 'doc' as const, content: [{ type: 'heading' as const, attrs: { level: 2 }, content: [{ type: 'text' as const, text: 'Title' }] }, { type: 'orderedList' as const, attrs: { start: 2, type: null }, content: [{ type: 'listItem' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Contact', marks: [{ type: 'bold' as const }, { type: 'italic' as const }, { type: 'link' as const, attrs: { href: '/contact', target: '_blank', rel: null, class: null } }] }] }] }] }] };
  assert.deepEqual(richTextErrors(doc), []);
  const html = renderToStaticMarkup(React.createElement(RichDocument, { doc, resolveHref: href => `/preview${href}` }));
  assert.match(html, /<h2>Title/); assert.match(html, /<ol start="2">/); assert.match(html, /<em><strong>Contact/); assert.match(html, /href="\/preview\/contact"/); assert.match(html, /noopener noreferrer/);
  assert.equal(textToRichText('Original text').content![0].content![0].text, 'Original text');
});
test('图库/面板列表按稳定ID校验，发布拒绝空列表/标题，视频只允许指定服务与受控本地地址', () => {
  assert.deepEqual(presentationErrors('Tabs', { items: [] }, false), []); assert.ok(presentationErrors('Tabs', { items: [] }, true).length);
  assert.ok(presentationErrors('Gallery', { images: [{ id: 'a', src: 'https://invalid.example/image.jpg', alt: '' }] }, true).length);
  const panel = { id: 'a', title: 'Title', body: 'Body' };
  assert.ok(presentationErrors('Accordion', { items: [panel, panel] }, true).length);
  assert.equal(videoSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&autoplay=1')?.src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(videoSource('https://vimeo.com/123456')?.src, 'https://player.vimeo.com/video/123456');
  assert.equal(videoSource('/api/media/local')?.kind, 'file');
  for (const v of ['http://youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1', 'javascript:alert(1)', '<iframe src=x>', 'https://name:password@vimeo.com/123']) assert.equal(videoSource(v), undefined);
});
test('公开展示组件SSR保留无JS语义和唯一实例名称，轮播默认不自动播放', () => {
  const config = presentationComponents(v => v);
  const render = (type: string, props: object) => renderToStaticMarkup(React.createElement(config[type].render, { id: 'instance-a', ...props, puck: { isEditing: false } } as never));
  const gallery = render('Gallery', { images: [{ id: 'photo', src: '/images/studio.jpg', alt: 'Studio' }] });
  assert.match(gallery, /popovertarget="instance-a-lightbox-photo"/i); assert.match(gallery, /popover="auto"/); assert.match(gallery, /Close image/);
  const tabs = render('Tabs', { items: [{ id: 'overview', title: 'Overview', body: 'Readable without JavaScript' }] });
  assert.match(tabs, /type="radio"/); assert.match(tabs, /name="instance-a-tabs"/); assert.match(tabs, /Readable without JavaScript/);
  assert.match(render('Accordion', { items: [{ id: 'faq', title: 'Question', body: 'Answer' }] }), /<details><summary>Question<\/summary>/);
  assert.match(render('Carousel', { images: [{ id: 'photo', src: '/images/studio.jpg', alt: 'Studio' }] }), /Next slide/);
  assert.ok(!render('Video', { videoUrl: '/api/media/test', title: 'Factory' }).includes('autoplay'));
});

test('外贸控件在共享渲染中保留可读内容、严格素材引用和翻译位置', () => {
  const draft = createInitialDraft();
  const comparison = { title: 'Compare materials', modelColumns: ['Sample A', 'Sample B'], rows: [{ label: 'Surface', values: ['Finish A', '<Finish B>'] }] };
  const image = { ...imageComparisonDefaults, before: { src: '/images/studio.jpg', alt: 'Studio before changes', label: 'Before work' }, after: { src: '/images/chair.jpg', alt: 'Chair after changes', label: 'After work' } };
  const data = { root: { props: {} }, content: [
    { type: 'ComparisonTable', props: { id: 'spec-table', ...comparison } },
    { type: 'ProjectTimeline', props: { id: 'milestones', ...projectTimelineDefaults } },
    { type: 'ImageComparison', props: { id: 'change-1', ...image } },
    { type: 'ImageComparison', props: { id: 'change-2', ...image } },
  ] };
  validatePageData(data, '外贸展示控件', true);
  const html = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...draft, pageId: 'home' }), data }));
  assert.match(html, /<caption>Compare materials<\/caption>/);
  assert.match(html, /scope="row">Surface<\/th>/);
  assert.match(html, /&lt;Finish B&gt;/);
  assert.match(html, /<ol[^>]+site-project-milestones/);
  assert.match(html, /name="change-1-image-comparison"/);
  assert.match(html, /name="change-2-image-comparison"/);
  // 编辑器在选择控件和打开区块预览时会重复创建配置。拖拽引用必须落在 DOM 上。
  const canvas = createSiteConfig({ ...draft, pageId: 'home', editorCanvas: true });
  for (const node of data.content.slice(0, 3)) {
    const dragRef = () => {};
    const view = canvas.components[node.type].render({ ...node.props, puck: { isEditing: true, dragRef } } as never) as React.ReactElement<{ children: React.ReactElement[] }>;
    assert.equal(typeof view.props.children[0].type, 'string', node.type);
    assert.equal((view.props.children[0].props as { ref: unknown }).ref, dragRef);
  }

  assert.deepEqual(presentationErrors('ImageComparison', imageComparisonDefaults, false), []);
  assert.ok(presentationErrors('ImageComparison', imageComparisonDefaults, true).length);
  assert.ok(presentationErrors('ComparisonTable', { ...comparisonTableDefaults, rows: [{ label: 'Mismatch', values: ['Only one column'] }] }, false).length);
  assert.ok(presentationErrors('ProjectTimeline', { ...projectTimelineDefaults, items: [{ label: '', title: '', description: '' }] }, true).length);
  const invalidMedia = { ...image, after: { ...image.after, src: '/api/media/not-an-image' } };
  const source = { ...draft, editorData: { home: { ...data, content: [{ type: 'ImageComparison', props: { id: 'media-check', ...invalidMedia } }] } } };
  // 新控件的两侧共用公开素材引用收集，归档和删除保护均可发现嵌套 src。
  assert.ok(collectReferences(source).urls.has('/api/media/not-an-image'));
  assert.match(presentationMediaErrors(source).join(' '), /不存在或类型不符/);

  const asset = { kind: 'block' as const, id: 'section', label: 'Section', value: { name: 'Section', data } };
  const fields = collectNativeSiteTranslationFields(asset);
  assert.ok(fields.some(field => field.source === 'Sample A'));
  assert.ok(fields.some(field => field.source === 'Studio before changes'));
  assert.ok(!fields.some(field => field.source === '/images/studio.jpg'));
  const cell = fields.find(field => field.source === 'Finish A')!;
  assert.equal(cell.maxLength, 500);
  const translated = writeNativeSiteTranslationFields(asset.value, [cell], ['Translated finish']) as typeof asset.value;
  assert.deepEqual((translated.data.content[0].props as typeof comparison).rows, [{ label: 'Surface', values: ['Translated finish', '<Finish B>'] }]);
});
test('视频Range覆盖前缀/后缀/开放结尾，拒绝越界、多段和非安全整数', () => {
  assert.deepEqual(mediaByteRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(mediaByteRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(mediaByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(mediaByteRange('bytes=90-999', 100), { start: 90, end: 99 });
  for (const range of ['bytes=100-', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,5-9', 'bytes=9007199254740992-', 'bytes=0-9007199254740992', 'bytes=-', 'invalid']) assert.equal(mediaByteRange(range, 100), undefined);
});
test('预览接受没有Content-Length的真实分块响应，超预算或非法MIME会中止读取', async () => {
  let bytes = 0;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close(); } }), { headers: { 'content-type': 'video/mp4' } });
  const blob = await readPreviewMediaBlob(response, size => { bytes += size; });
  assert.equal(bytes, 4); assert.equal(blob.type, 'video/mp4'); assert.equal(blob.size, 4);
  let cancelled = false;
  const large = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'video/mp4' } });
  let total = 0; await assert.rejects(() => readPreviewMediaBlob(large, size => { total += size; if (total > 5) throw new Error('页面预算'); }), /页面预算/); assert.equal(cancelled, true);
  await assert.rejects(() => readPreviewMediaBlob(new Response('html', { headers: { 'content-type': 'text/html' } }), () => {}), /格式/);
});
test('本地视频真实文件、八组件保存发布/回滚/恢复及媒体引用保护', async () => {
  const previous = process.env.FORM_STUDIO_DATA_DIR, directory = mkdtempSync(join(tmpdir(), 'form-studio-presentation-')); process.env.FORM_STUDIO_DATA_DIR = directory;
  try {
    const actor = { id: 'presentation-admin', name: '组件验收' };
    const form = new FormData(); form.set('file', new File([readFileSync(new URL('./fixtures/short-video.mp4', import.meta.url))], 'short-video.mp4', { type: 'video/mp4' })); form.set('expectedRevision', String(getDraftRecord().revision));
    const upload = await uploadMedia(form); assert.equal(upload.media.kind, 'video'); assert.equal(readMediaFile(upload.media.id).mime, 'video/mp4');
    const bad = new FormData(); bad.set('file', new File(['<script>test</script>'], 'fake.mp4', { type: 'video/mp4' })); bad.set('expectedRevision', String(getDraftRecord().revision)); await assert.rejects(() => uploadMedia(bad), /视频容器签名无效/);
    const draft = getDraftRecord().content;
    const component = (type: string, props: object) => ({ type, props: { id: `component-${type}`, ...props } });
    const data = { root: { props: { title: '展示组件' } }, content: [component('RichText', { doc: textToRichText('真实保存的文字') }), component('Icon', { icon: 'globe', label: 'International' }), component('Divider', { text: 'Details' }), component('Gallery', { images: [{ id: 'photo', src: '/images/studio.jpg', alt: 'Studio' }], ratio: '1/1' }), component('Accordion', { items: [{ id: 'faq', title: 'Question', body: 'Answer' }] }), component('Tabs', { items: [{ id: 'tab', title: 'Overview', body: 'Details' }] }), component('Video', { videoUrl: upload.media.url, title: 'Factory introduction', poster: '/images/studio.jpg' }), component('Carousel', { images: [{ id: 'slide', src: '/images/interior.jpg', alt: 'Interior' }] })] };
    const save = (patch: object) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
    save({ editorData: { ...draft.editorData, home: data } });
    assert.ok(collectReferences(getDraftRecord().content).urls.has(upload.media.url));
    assert.throws(() => deleteMedia(upload.media.id, { expectedRevision: getDraftRecord().revision }), /引用/);
    const selection = () => ({ expectedRevision: getDraftRecord().revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds: ['home'], productIds: [], includeTheme: true, includeSettings: true });
    const first = publishSite(selection(), actor); assert.equal(readRelease(first.releaseId).schemaVersion, protocol.snapshot); assert.ok(readRelease(first.releaseId).media.some(m => m.id === upload.media.id));
    const shared = { id: 'presentation-card', name: '展示卡片', data, updated: '' };
    save({ sharedBlocks: [shared], editorData: { ...getDraftRecord().content.editorData, home: { root: { props: { showChrome: 'no' } }, content: [{ type: 'SharedBlock', props: { id: 'left', blockId: shared.id } }, { type: 'SharedBlock', props: { id: 'right', blockId: shared.id } }] } } });
    const repeated = publishSite({ ...selection(), sharedBlockIds: [shared.id] }, actor); const repeatedSnapshot = readRelease(repeated.releaseId);
    const repeatedHtml = renderToStaticMarkup(React.createElement(Render, { config: createSiteConfig({ ...repeatedSnapshot, pageId: 'home' }), data: repeatedSnapshot.editorData.home as never }));
    const tabNames = [...repeatedHtml.matchAll(/name="([^"]+-tabs)"/g)].map(m => m[1]); assert.equal(new Set(tabNames).size, 2);
    const lightboxIds = [...repeatedHtml.matchAll(/id="([^"]+-lightbox-photo)"/g)].map(m => m[1]); assert.equal(new Set(lightboxIds).size, 2);
    save({ editorData: { ...getDraftRecord().content.editorData, home: { root: { props: {} }, content: [] } } });
    const second = publishSite(selection(), actor); activateRelease(first.releaseId, { expectedActiveReleaseId: second.releaseId }, actor);
    restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: ['home'] }, actor);
    assert.equal((getDraftRecord().content.editorData.home as typeof data).content.length, 8);
    assert.throws(() => save({ editorData: { ...getDraftRecord().content.editorData, home: { ...data, content: [component('Video', { videoUrl: '/images/studio.jpg', title: 'Wrong media' })] } } }), /视频/);
  } finally { getDatabase().close(); if (previous === undefined) delete process.env.FORM_STUDIO_DATA_DIR; else process.env.FORM_STUDIO_DATA_DIR = previous; if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-presentation-`)) rmSync(directory, { recursive: true, force: true }); }
});
