import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentData, Data } from '@puckeditor/core';
import type { AiDetailDesignRequest } from '../src/lib/ai-detail-design-types';
import { AI_DETAIL_DESIGN_INSTRUCTIONS, compileAiDetailDesign, prepareAiDetailDesign } from '../src/lib/ai-detail-design';
import { prepareAiPageEdit, sameAiPageData } from '../src/lib/ai-page-edit';
import { withEditorRootDefaults } from '../src/lib/editor-root-defaults';
import { createEmptyDraft } from '../src/server/seed';
import { validateDraft } from '../src/server/validation';

function fixture(kind: 'product' | 'entry' = 'product') {
  const content = createEmptyDraft(), modelId = kind === 'product' ? 'goods' : 'cases';
  content.contentModels = [
    { id: 'goods', name: 'Goods', target: 'product', description: '', updated: '', fields: [{ id: 'finish', key: 'finish', label: 'Finish', type: 'text', required: false }] },
    { id: 'cases', name: 'Cases', target: 'content', description: '', updated: '', fields: [{ id: 'body', key: 'body', label: 'Case story', type: 'textarea', required: false }, { id: 'cover', key: 'cover', label: 'Cover', type: 'image', required: false }] },
  ];
  content.products = [{ id: 'actual-product', name: 'PRIVATE_PRODUCT_NAME', sku: 'P1', category: 'Project', description: 'PRIVATE_PRODUCT_DESCRIPTION', material: 'Steel', image: '/images/chair.jpg', status: 'published', modelId: 'goods', customFields: { finish: 'PRIVATE_FINISH' } }];
  content.contentEntries = [{ id: 'actual-case', title: 'PRIVATE_CASE_TITLE', modelId: 'cases', status: 'published', updated: '', customFields: { body: 'PRIVATE_STORY', cover: '/images/interior.jpg' } }];
  content.pages.push({ id: 'product-detail', title: 'Product detail', slug: '/products/:slug', type: 'product-detail', status: 'draft', updated: '' }, { id: 'case-detail', title: 'Case detail', slug: '/cases/:slug', type: '普通页面', contentModelId: 'cases', status: 'draft', updated: '' });
  content.editorData['product-detail'] = { root: { props: {} }, content: [] };
  content.editorData['case-detail'] = { root: { props: {} }, content: [] };
  const binding = (field: string) => ({ source: kind, mode: 'current', modelId, field });
  const data = { root: { props: { title: 'Original template', showChrome: 'yes' } }, content: [{ type: 'Container', props: { id: 'hero', layout: 'column', columns: 1, mobileColumns: 1, gap: 24, padding: 32, inset: 32, content: [
    { type: 'Heading', props: { id: 'title', text: '', level: 'h1', size: 48, mobileSize: 30, bindings: { text: binding(kind === 'product' ? 'builtin:name' : 'builtin:title') } } },
    { type: 'Image', props: { id: 'photo', src: '', alt: '', height: 320, bindings: { src: binding(kind === 'product' ? 'builtin:image' : 'field:cover') } } },
    { type: 'Text', props: { id: 'body', text: '', size: 17, bindings: { text: binding(kind === 'product' ? 'builtin:description' : 'field:body') } } },
  ] } }, { type: 'Container', props: { id: 'support', layout: 'column', content: [{ type: 'Text', props: { id: 'support-copy', text: 'Confirmed support information.' } }] } }], zones: {} } as Data;
  content.pageTemplates = [{ id: 'detail-layout', name: 'Original detail layout', description: 'Confirmed layout', kind, ...(kind === 'entry' ? { modelId } : {}), sourcePath: kind === 'product' ? '/products/:slug' : '/cases/:slug', code: { css: '.detail{border:0}', js: '', cssEnabled: true, jsEnabled: false }, updated: '2026-11-12', detailRule: { enabled: true, priority: 20, modelId }, data }];
  return content;
}
const request = (extra: Partial<AiDetailDesignRequest> = {}): AiDetailDesignRequest => ({ templateId: 'detail-layout', expectedRevision: 0, instruction: '重新安排详情页的图文结构，让采购客户快速理解重点，手机上阅读清晰。', preserveText: true, ...extra });
const output = (operations: unknown[]) => ({ summary: '按真实动态内容重新安排详情布局，保留原有资料。', intent: { goal: '让采购客户容易阅读详情', decisions: ['重排图文，保留单列手机阅读'], preserve: ['真实产品与案例资料'], assumptions: [] }, operations, warnings: [] });
function find(data: Data, id: string): ComponentData {
  let result: ComponentData | undefined;
  const walk = (value: unknown) => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) { value.forEach(walk); return; } const node = value as ComponentData; if (node.props?.id === id) result = node; Object.values(value).forEach(walk); };
  walk(data); assert.ok(result, `missing ${id}`); return result;
}

test('详情上下文区分产品与案例来源，仅发兼容动态字段，不外发记录值或伪装卡片', () => {
  for (const kind of ['product', 'entry'] as const) {
    const source = fixture(kind), prepared = prepareAiDetailDesign(source, request({ recordId: kind === 'product' ? 'actual-product' : 'actual-case' })), context = prepared.context as unknown as Record<string, unknown>, encoded = JSON.stringify(context);
    assert.deepEqual(context.dynamicBindingContext, { source: kind, purpose: 'detail', modelId: kind === 'product' ? 'goods' : 'cases' });
    assert.ok(context.currentRecordFields); assert.equal(context.currentProductFields, undefined);
    assert.doesNotMatch(encoded, /PRIVATE_|actual-product|actual-case|\/images\//);
    assert.match(encoded, kind === 'product' ? /field:finish/ : /field:body/);
    assert.equal(prepared.scope.kind, kind); assert.equal(prepared.scope.nodeCount, 6);
    assert.ok(prepared.working.pages.some(page => page.id === prepared.pageId)); assert.equal(source.pages.some(page => page.id === prepared.pageId), false);
  }
  assert.match(AI_DETAIL_DESIGN_INSTRUCTIONS, /DETAIL TEMPLATE/);
});

test('产品模板真实重排、图文容器与扩展字段可继续拖拽，只改目标data和原生新增块', () => {
  const source = fixture(), original = structuredClone(source), compiled = compileAiDetailDesign(source, request(), output([
    { kind: 'insert', parentId: 'hero', index: 0, node: { tempId: 'new-copy', type: 'Container' } },
    { kind: 'move', id: 'title', parentId: 'new-copy', index: 0 }, { kind: 'move', id: 'body', parentId: 'new-copy', index: 1 },
    { kind: 'insert', parentId: 'new-copy', index: 2, node: { tempId: 'new-finish', type: 'Text', bindings: { text: 'field:finish' } } },
    { kind: 'layout', id: 'hero', layout: 'grid', columns: 2, gap: 40 },
    { kind: 'design', id: 'photo', design: { desktop: { objectFit: 'contain', height: 480 }, mobile: { height: 260, width: '100%', columnSpan: 1 } } },
  ]), 'aitd-native');
  assert.deepEqual(source, original); assert.deepEqual(compiled.candidate.pages, original.pages); assert.deepEqual(compiled.candidate.editorData, original.editorData); assert.deepEqual(compiled.candidate.products, original.products); assert.deepEqual(compiled.candidate.contentEntries, original.contentEntries);
  const { data: _beforeData, ...beforeMetadata } = original.pageTemplates![0], { data: _afterData, ...afterMetadata } = compiled.candidate.pageTemplates![0];
  assert.deepEqual(afterMetadata, beforeMetadata); assert.equal(find(compiled.data, 'hero').props.layout, 'grid'); assert.equal(find(compiled.data, 'hero').props.design.mobile.columns, 1);
  assert.deepEqual(find(compiled.data, 'aie-aitd-native-2').props.bindings.text, { source: 'product', mode: 'current', modelId: 'goods', field: 'field:finish' });
  assert.deepEqual(find(compiled.data, 'title').props.bindings, find(original.pageTemplates![0].data, 'title').props.bindings);
  assert.equal(sameAiPageData(compiled.data, withEditorRootDefaults(compiled.data)), true); assert.deepEqual(compiled.data.zones, {});
  assert.doesNotThrow(() => validateDraft(compiled.candidate));
});

test('案例标题、正文、封面和详情链接绑定当前entry，富文本字段仍保留原生动态来源', () => {
  const source = fixture('entry'), compiled = compileAiDetailDesign(source, request(), output([
    { kind: 'insert', parentId: 'hero', index: 3, node: { tempId: 'new-title', type: 'Heading', level: 'h2', bindings: { text: 'builtin:title' } } },
    { kind: 'insert', parentId: 'hero', index: 4, node: { tempId: 'new-cover', type: 'Image', bindings: { src: 'field:cover', alt: 'builtin:title' } } },
    { kind: 'insert', parentId: 'hero', index: 5, node: { tempId: 'new-more', type: 'ActionButton', bindings: { text: 'builtin:title', href: 'builtin:url' } } },
  ]), 'aitd-entry');
  assert.deepEqual(find(compiled.data, 'body').props.bindings.text, { source: 'entry', mode: 'current', modelId: 'cases', field: 'field:body' });
  assert.equal(find(compiled.data, 'aie-aitd-entry-2').props.bindings.src.source, 'entry'); assert.equal(find(compiled.data, 'aie-aitd-entry-3').props.bindings.href.field, 'builtin:url');
  assert.doesNotMatch(JSON.stringify(compiled.data), /PRIVATE_|recordId/); assert.doesNotThrow(() => validateDraft(compiled.candidate));
  for (const op of [{ kind: 'bind', id: 'photo', target: 'src', field: 'builtin:title' }, { kind: 'bind', id: 'body', target: 'text', field: 'builtin:description' }, { kind: 'bind', id: 'title', target: 'text', field: 'field:missing' }, { kind: 'bind', id: 'title', target: 'text', field: 'builtin:title', source: 'product', recordId: 'actual-product' }]) assert.throws(() => compileAiDetailDesign(source, request({ preserveText: false }), output([op]), 'aitd-invalid'));
});

test('泛用产品模板不按预览样本擅自开放模型字段；缺失或跨类型模型在生成前拒绝', () => {
  const source = fixture(); delete source.pageTemplates![0].detailRule!.modelId;
  const context = JSON.stringify(prepareAiDetailDesign(source, request({ recordId: 'actual-product' })).context);
  assert.match(context, /builtin:name/); assert.doesNotMatch(context, /field:finish/);
  assert.throws(() => compileAiDetailDesign(source, request(), output([{ kind: 'insert', parentId: 'hero', index: 0, node: { tempId: 'new-finish', type: 'Text', bindings: { text: 'field:finish' } } }]), 'aitd-generic'), /字段不存在|不兼容/);
  for (const modelId of ['missing', 'cases']) { const invalid = fixture(); invalid.pageTemplates![0].detailRule!.modelId = modelId; assert.throws(() => prepareAiDetailDesign(invalid, request()), /模型/); }
  const entry = fixture('entry'); delete entry.pageTemplates![0].modelId; assert.throws(() => prepareAiDetailDesign(entry, request()), /模型/);
});

test('详情中的相关产品卡片独立克隆，entry外层来源不会污染卡片产品来源，H1检查保留', () => {
  const source = fixture('entry'), data = source.pageTemplates![0].data;
  data.content.push({ type: 'ProductList', props: { id: 'related-products', title: 'Related products', count: 3, columns: 3, mobileColumns: 1, category: 'Project' } });
  const encoded = JSON.stringify(prepareAiDetailDesign(source, request()).context); assert.match(encoded, /productCard/);
  const compiled = compileAiDetailDesign(source, request(), output([{ kind: 'productCard', id: 'related-products', operations: [{ kind: 'design', id: 'card-related-products-title', design: { mobile: { fontSize: 20 } } }] }]), 'aitd-related');
  assert.equal(compiled.sharedBlocks.length, 1); assert.equal(find(compiled.data, 'related-products').type, 'ContentLoop');
  assert.equal(find(compiled.sharedBlocks[0].data, 'card-related-products-title').props.bindings.text.source, 'product');
  assert.equal(find(compiled.data, 'title').props.bindings.text.source, 'entry'); assert.equal(source.sharedBlocks, undefined); assert.doesNotThrow(() => validateDraft(compiled.candidate));
  const noHeading = fixture(); find(noHeading.pageTemplates![0].data, 'title').props.level = 'h2';
  const warning = compileAiDetailDesign(noHeading, request(), output([{ kind: 'design', id: 'photo', design: { mobile: { height: 230 } } }]), 'aitd-h1'); assert.match(warning.warnings.join(), /0个一级标题/);
});

test('手机范围只写mobile样式；锁定树、范围外、保留内容来源和任意模板元数据不可绕过', () => {
  const source = fixture('entry'), compiled = compileAiDetailDesign(source, request({ targetId: 'hero', viewport: 'mobile' }), output([{ kind: 'design', id: 'title', design: { mobile: { fontSize: 26, lineHeight: 1.3 } } }]), 'aitd-mobile');
  assert.deepEqual(find(compiled.data, 'title').props.design, { mobile: { fontSize: 26, lineHeight: 1.3 } }); assert.deepEqual(find(compiled.data, 'support'), find(source.pageTemplates![0].data, 'support'));
  for (const op of [{ kind: 'layout', id: 'hero', layout: 'grid', columns: 2 }, { kind: 'design', id: 'title', design: { desktop: { fontSize: 26 } } }, { kind: 'bind', id: 'title', target: 'text', field: 'builtin:title' }]) assert.throws(() => compileAiDetailDesign(source, request({ viewport: 'mobile' }), output([op]), 'aitd-invalid'), /设备|断点/);
  assert.throws(() => compileAiDetailDesign(source, request({ targetId: 'hero' }), output([{ kind: 'design', id: 'support-copy', design: { mobile: { fontSize: 20 } } }]), 'aitd-scope'), /范围/);
  find(source.pageTemplates![0].data, 'title').props.locked = true;
  assert.throws(() => compileAiDetailDesign(source, request(), output([{ kind: 'layout', id: 'hero', layout: 'grid', columns: 2 }]), 'aitd-lock'), /锁定/);
  const fixed = fixture('entry'); find(fixed.pageTemplates![0].data, 'title').props.bindings.text.mode = 'fixed'; find(fixed.pageTemplates![0].data, 'title').props.bindings.text.recordId = 'actual-case';
  assert.throws(() => compileAiDetailDesign(fixed, request(), output([{ kind: 'bind', id: 'title', target: 'text', field: 'builtin:title' }]), 'aitd-fixed'), /保留文字/);
  for (const extra of [{ template: {} }, { data: {} }, { detailRule: { enabled: false } }, { targetId: 0 }, { viewport: 'phone' }]) assert.throws(() => prepareAiDetailDesign(fixture(), { ...request(), ...extra }));
  const page = fixture(); page.pageTemplates![0].kind = 'page'; assert.throws(() => prepareAiDetailDesign(page, request()), /详情模板/);
});

test('旧产品卡片上下文兼容currentProductFields，普通页面不能自行申请详情绑定', () => {
  const source = fixture(), pageId = 'card-test'; source.pages.push({ ...source.pages[0], id: pageId, title: 'Card', slug: '/card' }); source.editorData[pageId] = source.pageTemplates![0].data;
  const native = { pageId, expectedRevision: 0, instruction: '调整卡片排版', mode: 'mixed', preserveText: true, lockedIds: [] };
  const context = prepareAiPageEdit(source, native, { modelId: 'goods' }).context as unknown as Record<string, unknown>;
  assert.ok(context.currentProductFields); assert.equal(context.currentRecordFields, undefined); assert.equal(context.dynamicBindingContext, undefined);
});

test('案例详情能把旧首图升级为同一记录的完整图库，原封面与动态正文保持', () => {
  const source=fixture('entry'), template=source.pageTemplates![0];
  source.contentModels![1].fields.push({id:'site-photos',key:'site-photos',label:'Project gallery',type:'gallery',required:false});
  source.contentEntries![0].customFields!['site-photos']=['/images/chair.jpg','/images/studio.jpg'];
  const old={type:'Image',props:{id:'old-gallery',src:'',alt:'',fit:'contain',design:{mobile:{width:'100%'}},bindings:{src:{source:'entry',mode:'current',modelId:'cases',field:'field:site-photos'},alt:{source:'entry',mode:'current',modelId:'cases',field:'builtin:title'}}}};
  find(template.data,'hero').props.content.push(old);
  const prepared=prepareAiDetailDesign(source,request());
  assert.deepEqual(prepared.context.galleryFields?.map(field=>field.field),['field:site-photos']);
  assert.equal(prepared.context.nodes.find(node=>node.id==='old-gallery')?.expandableGalleryField,'field:site-photos');
  assert.doesNotMatch(JSON.stringify(prepared.context.galleryFields),/\/images\/|PRIVATE_/);

  const result=compileAiDetailDesign(source,request(),output([{kind:'expandGallery',id:'old-gallery'}]),'full-gallery');
  const data=result.candidate.pageTemplates![0].data, expanded=find(data,'old-gallery');
  assert.equal(expanded.type,'Gallery');
  assert.deepEqual(expanded.props.bindings.images,old.props.bindings.src);
  assert.deepEqual(expanded.props.design,old.props.design);
  assert.deepEqual(expanded.props.images,[]);
  assert.deepEqual(find(data,'photo'),find(template.data,'photo'));
  assert.deepEqual(find(data,'body'),find(template.data,'body'));

  const insert=(field:string)=>({kind:'insert',parentId:'hero',index:1,node:{type:'Gallery',tempId:'new-gallery',bindings:{images:field}}});
  for(const field of ['field:cover','field:other','builtin:images']) assert.throws(()=>compileAiDetailDesign(source,request(),output([insert(field)]),'invalid'),/字段不存在或与组件用途不兼容/);
  assert.throws(()=>compileAiDetailDesign(source,request({targetId:'support'}),output([{kind:'expandGallery',id:'old-gallery'}]),'invalid'),/范围之外/);
  old.props.alt='Authored image description';
  assert.throws(()=>compileAiDetailDesign(source,request(),output([{kind:'expandGallery',id:'old-gallery'}]),'invalid'),/自定义说明/);
});
