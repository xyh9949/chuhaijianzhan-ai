import type { ComponentData, Data } from '@puckeditor/core';
import type { ContentModel, FieldBinding } from './types';
import { fieldChoices } from './content-binding';
import type { DesignValues } from './responsive-style';

/** 预设只是可拖拽的起点；每个节点仍独立绑定当前记录，客户可自由增删布局。 */
export function createContentDesignData({ name, source, model, recordId, kind, hasDetailRoute = true, detailKind }: { name: string; source: 'product' | 'entry'; model?: ContentModel; recordId?: string; kind: 'card' | 'detail'; hasDetailRoute?: boolean; detailKind?: 'case' }): Data {
  // 仅明确的新案例起点采用新布局；旧页面、卡片及其他模板工厂默认保持原样。
  if (kind === 'detail' && detailKind === 'case') {
    if (source !== 'entry' || !model || model.target !== 'content') throw Error('案例详情需要已有的内容栏目');
    return caseDetailData(name, model, recordId);
  }
  const node = (type: string, props: Record<string, unknown>): ComponentData => ({ type, props: { id: `node-${crypto.randomUUID()}`, ...props } });
  const binding = (field: string): FieldBinding => ({ source, mode: 'current', ...(model ? { modelId: model.id } : {}), field });
  const imageField = source === 'product' ? 'builtin:image' : model?.fields.find(field => field.type === 'image' || field.type === 'gallery')?.id;
  const descriptionField = source === 'product' ? 'builtin:description' : (model?.fields.find(field => field.type === 'textarea') || model?.fields.find(field => field.type === 'text'))?.id;
  const isCard = kind === 'card';
  const content: ComponentData[] = [];
  if (imageField) content.push(node('Image', { src: '', alt: '', height: isCard ? 220 : 440, fit: 'cover', radius: isCard ? 8 : 0, bindings: { src: binding(imageField.startsWith('builtin:') ? imageField : `field:${imageField}`), alt: binding(source === 'product' ? 'builtin:name' : 'builtin:title') } }));
  content.push(node('Heading', { text: 'Content title', size: isCard ? 24 : 44, mobileSize: isCard ? 22 : 32, color: '#222a25', align: 'left', style: 'sans', spacing: 0, bindings: { text: binding(source === 'product' ? 'builtin:name' : 'builtin:title') } }));
  if (descriptionField) content.push(node('Text', { text: '', size: 16, color: '#657084', align: 'left', maxWidth: 760, bindings: { text: binding(descriptionField.startsWith('builtin:') ? descriptionField : `field:${descriptionField}`) } }));
  if (isCard && hasDetailRoute) content.push(node('ActionButton', { text: 'View details', href: '', kind: 'outline', align: 'left', bindings: { href: binding('builtin:url') } }));
  const root = { props: { title: name, showChrome: isCard ? 'no' : 'yes', ...(recordId ? { bindingContext: { source, recordId, ...(model ? { modelId: model.id } : {}) } } : {}) } };
  return { root, content: [node('Container', { content, layout: 'column', columns: 1, mobileColumns: 1, gap: isCard ? 16 : 24, padding: isCard ? 20 : 64, inset: isCard ? 20 : 40, background: '#ffffff', image: '', minHeight: 0, align: 'start', design: { desktop: { borderWidth: isCard ? 1 : 0, borderColor: '#e5e9ef', borderRadius: isCard ? 10 : 0 }, mobile: { paddingTop: isCard ? 16 : 32, paddingBottom: isCard ? 16 : 32, paddingLeft: isCard ? 16 : 24, paddingRight: isCard ? 16 : 24 } } })] };
}

/** 所有事实仍是当前entry字段；空字段不生成假标签，富文正文由既有Text动态渲染器保留。 */
function caseDetailData(name: string, model: ContentModel, recordId?: string): Data {
  const node = (type: string, props: Record<string, unknown>): ComponentData => ({ type, props: { id: `node-${crypto.randomUUID()}`, ...props } });
  const binding = (field: string): FieldBinding => ({ source: 'entry', mode: 'current', modelId: model.id, field });
  const box = (content: ComponentData[], label: string, desktop: DesignValues = {}, mobile: DesignValues = {}) => node('Container', { content, nodeLabel: label, layout: 'column', columns: 1, mobileColumns: 1, gap: 24, padding: 0, inset: 0, background: 'transparent', image: '', minHeight: 0, align: 'start', design: { desktop: { columns: 1, alignItems: 'start', paddingLeft: 0, paddingRight: 0, color: 'inherit', ...desktop }, tablet: { columns: 1, paddingLeft: 0, paddingRight: 0 }, mobile: { columns: 1, columnSpan: 1, paddingLeft: 0, paddingRight: 0, gap: 20, ...mobile } } });
  const text = (field: string, label: string, size = 17) => node('Text', { text: '', nodeLabel: label, size, align: 'left', maxWidth: 780, bindings: { text: binding(field) }, design: { desktop: { color: 'inherit', fontFamily: 'inherit', fontSize: size, lineHeight: 1.85, maxWidth: '100%' }, mobile: { color: 'inherit', fontSize: Math.min(size, 17), lineHeight: 1.8 } } });
  const textFields = new Set(fieldChoices('entry', model, 'text').map(field => field.value));
  const summary = model.fields.find(field => field.key === 'summary' && ['text', 'textarea'].includes(field.type));
  const images = model.fields.filter(field => ['image', 'gallery'].includes(field.type));
  const cover = images.find(field => field.key === 'cover') || images.find(field => field.type === 'image');
  const longFields = model.fields.filter(field => field.type === 'textarea' && field.id !== summary?.id);
  const facts = model.fields.filter(field => !['image', 'gallery', 'textarea'].includes(field.type) && field.id !== summary?.id).flatMap(field => {
    const key = field.type === 'relation' ? `related:${field.id}:title` : `field:${field.id}`;
    return textFields.has(key) ? [text(key, field.label, 15)] : [];
  });
  const heading = node('Heading', { text: '', nodeLabel: '案例标题', level: 'h1', size: 52, mobileSize: 32, align: 'left', style: 'sans', spacing: 0, bindings: { text: binding('builtin:title') }, design: { desktop: { color: 'inherit', maxWidth: 980, lineHeight: 1.15, letterSpacing: -0.6 }, mobile: { fontSize: 32, lineHeight: 1.2, letterSpacing: -0.3 } } });
  const identity = box([heading, ...(summary ? [text(`field:${summary.id}`, '案例摘要', 19)] : []), ...(facts.length ? [box(facts, '已填写的案例资料', { gap: 12 }, { gap: 10 })] : [])], '案例标题与真实简介', { gap: 24 }, { gap: 20 });
  const visual = (field: typeof images[number]) => field.type === 'gallery'
    // 封面保留原位置；项目图片集按记录原顺序成为独立可拖拽画廊。
    ? node('Gallery', { images: [], nodeLabel: field.label, ratio: '4/3', fit: 'contain', lightbox: true, bindings: { images: binding(`field:${field.id}`) } })
    : node('Image', { src: '', alt: '', nodeLabel: field.label, height: 520, fit: 'contain', radius: 0, bindings: { src: binding(`field:${field.id}`), alt: binding('builtin:title') }, design: { desktop: { width: '100%', height: 'auto', maxHeight: 620, objectFit: 'contain' }, mobile: { height: 'auto', maxHeight: 380, objectFit: 'contain' } } });
  const body = longFields.length ? box(longFields.map(field => text(`field:${field.id}`, field.label)), '案例完整正文', { maxWidth: 780, width: '100%', marginLeft: 'auto', marginRight: 'auto', gap: 32 }) : undefined;
  const content = [identity, ...(cover ? [visual(cover)] : []), ...(body ? [body] : []), ...images.filter(field => field.id !== cover?.id).map(visual)];
  const root = { props: { title: name, showChrome: 'yes', ...(recordId ? { bindingContext: { source: 'entry', recordId, modelId: model.id } } : {}) } };
  return { root, content: [box(content, '案例详情', { paddingTop: 56, paddingBottom: 64, paddingLeft: 48, paddingRight: 48, gap: 40 }, { paddingTop: 32, paddingBottom: 40, paddingLeft: 20, paddingRight: 20, gap: 28 })] };
}
