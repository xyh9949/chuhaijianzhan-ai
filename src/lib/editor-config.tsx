'use client';
import {extensionEditorComponents} from '../extensions/editor';
import {LOCAL_EXTENSIONS} from '../extensions/registry';
import { formReferenceField, formWideFieldsField } from '@/components/FormManager';
import { richTextField } from '@/components/editor/RichTextField';
import {panelEditorFields} from '@/components/editor/PanelFields';
import {panelSlotsField} from './free-panel-render';
import { collectionField, videoField } from '@/components/editor/PresentationFields';
import { ICON_NAMES, textToRichText,convertToFreePanels,initialPanelProps } from './presentation-content';
import { presetField, tokenField, stateField } from '@/components/editor/ThemeFields';
import {localeMenusField} from '@/components/editor/LocaleMenusField';
import { queryField } from '@/components/editor/QueryField';
import { linkTargetField } from '@/components/editor/LinkTargetField';
import { EDITOR_ROOT_DEFAULT_PROPS } from './editor-root-defaults';
import { COMPONENT_TRANSLATABLE_LABELS } from './component-translatable-labels';
import { componentLabelsField } from '@/components/editor/ComponentLabelsField';
import { ProductDetailColorField } from '@/components/editor/ProductDetailColorField';
import { comparisonTableFields, comparisonTableRenderFields } from '@/components/editor/ComparisonTableFields';
import { imageComparisonFields } from '@/components/editor/ImageComparisonFields';
import { projectTimelineFields } from '@/components/editor/ProjectTimelineFields';
import { comparisonTableDefaults } from './comparison-table';
import { imageComparisonDefaults } from './image-comparison';
import { projectTimelineDefaults } from './project-timeline';
import { TRADE_COMPONENT_LABELS } from './component-contract';

import React from 'react';
import { Switch, Form, Input, InputNumber, Select } from 'antd';
import type { Config, Field } from '@puckeditor/core';
import type { StudioState } from './types';
import { getSharedBlockUsage } from './shared-blocks';
import { createSiteConfig } from './site-render-config';
import { groupedEditorFields, imageAssetField, responsiveDesignField } from '@/components/editor/DesignFields';
import { bindingContextField, contentListSourceField, contentLoopSourceField, dynamicBindingField } from '@/components/editor/BindingFields';
import './site.css';
export { createPageData, getPageKind, getPageData } from './page-data';

const textField = (label: string, multiline = false): Field => ({
  type: 'custom', label,
  render: ({ value, onChange, id }) => <Form.Item className="editor-property" label={label} htmlFor={id} layout="vertical">{multiline
    ? <Input.TextArea id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} autoSize={{ minRows: 3, maxRows: 7 }} />
    : <Input id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />}</Form.Item>,
});
const numberField = (label: string, min = 0, max = 240): Field => ({
  type: 'custom', label,
  render: ({ value, onChange, id }) => <Form.Item className="editor-property" label={label} htmlFor={id} layout="vertical"><InputNumber id={id} value={Number(value ?? 0)} min={min} max={max} style={{ width: '100%' }} onChange={(v) => v !== null && onChange(v)} /></Form.Item>,
});
const selectField = (label: string, options: { label: string; value: string | number | boolean }[]): Field => ({
  type: 'custom', label,
  render: ({ value, onChange, id }) => <Form.Item className="editor-property" label={label} htmlFor={id} layout="vertical"><Select id={id} value={value} options={options} onChange={(next) => onChange(next)} style={{ width: '100%' }} /></Form.Item>,
});

// 编辑器只叠加 Ant 字段与导航；网站组件和样式由服务端、预览、画布共同复用。
export function createEditorConfig(state: StudioState, onNavigate?: (kind: string, productId?: string) => void, previewProductId?: string, options: { editingBlockId?: string; editingTemplateId?: string } = {}): Config {
  const template = state.pageTemplates?.find(item => item.id === options.editingTemplateId);
  const bindingDefaults = template && template.kind !== 'page' ? { source: template.kind, modelId: template.kind === 'entry' ? template.modelId : template.detailRule?.modelId } : undefined;
  // 产品模板的样本遵循模型范围；仅影响画布显示，不把样本写入模板或业务记录。
  if (template?.kind === 'product' && !previewProductId) {
    const modelId = template.detailRule?.modelId, savedId = (template.data.root?.props as { bindingContext?: { recordId?: string } } | undefined)?.bindingContext?.recordId;
    previewProductId = state.products.find(item => item.id === savedId && (!modelId || item.modelId === modelId))?.id || state.products.find(item => !modelId || item.modelId === modelId)?.id;
  }
  // 编辑器和登录预览都展示当前草稿产品；映射仅用于展示，不修改存储发布状态。
  const renderConfig = createSiteConfig({ pages: state.pages, media: state.media, products: state.products.map((product) => ({ ...product, status: 'published' })), theme: state.theme, settings: state.settings, editorData: state.editorData, onNavigate, previewProductId, editorCanvas: true, sharedBlocks: state.sharedBlocks, siteLayout: state.siteLayout, forms: state.forms, taxonomies: state.taxonomies, pageId: state.activePageId, editingBlockId: options.editingBlockId, contentModels: state.contentModels, contentEntries: state.contentEntries?.map(entry => ({ ...entry, status: 'published' as const })) });
  const config: Config = {
    ...renderConfig,
    root: { ...renderConfig.root, renderFields: groupedEditorFields, fields: {
        title: textField(options.editingBlockId ? '编辑器中的区块名称' : options.editingTemplateId ? '编辑器中的模板名称' : '编辑器中的页面名称'),
        ...(options.editingBlockId ? {} : {
        brand: textField('品牌名称'),
        showChrome: selectField('全站页眉与页脚', [{ label: '显示', value: 'yes' }, { label: '隐藏（空白画布）', value: 'no' }]),
        headerMode: selectField('当前页面的页眉', [{ label: '跟随全站设置', value: 'inherit' }, { label: '此页隐藏', value: 'hidden' }]),
        footerMode: selectField('当前页面的页脚', [{ label: '跟随全站设置', value: 'inherit' }, { label: '此页隐藏', value: 'hidden' }]),
        }),
        bindingContext: bindingContextField(state, options.editingTemplateId ? 'template' : Boolean(options.editingBlockId), !options.editingBlockId ? state.pages.find(page => page.id === state.activePageId)?.contentModelId : undefined),
        design: responsiveDesignField('Root', state.media, state.theme),
      }, defaultProps: EDITOR_ROOT_DEFAULT_PROPS },
    categories: {
basic: { title: '文字与图片', components: ['Heading', 'Text', 'Image', 'ActionButton', 'Download'] },
layout: { title: '布局与分栏', components: ['Container', 'Spacer'] },
presentation: { title: '图片、视频与互动', components: ['RichText', 'Icon', 'Divider', 'Gallery', 'Accordion', 'Tabs', 'Video', 'Carousel'] },
forms: { title: '询盘表单', components: ['Form'] },
trade: { title: '产品对比与项目展示', components: Object.keys(TRADE_COMPONENT_LABELS) },
content: { title: '产品与其他内容', components: ['CompanyFacts','ProductList', 'ProductDetail', 'ContentList', 'ContentLoop'] },
shared: { title: '导航与公共内容', components: ['SharedBlock', 'Navigation', 'Breadcrumb','LanguageSwitcher'] },
extensions:{title:'业务组件（高级）',components:LOCAL_EXTENSIONS.map(e=>e.type)}
},
    components: {
      ...extensionEditorComponents(renderConfig.components,state),
      ComparisonTable: { ...renderConfig.components.ComparisonTable, label: TRADE_COMPONENT_LABELS.ComparisonTable, renderFields: comparisonTableRenderFields, fields: { ...comparisonTableFields, design: responsiveDesignField('ComparisonTable', state.media, state.theme) }, defaultProps: comparisonTableDefaults },
      ProjectTimeline: { ...renderConfig.components.ProjectTimeline, label: TRADE_COMPONENT_LABELS.ProjectTimeline, renderFields: groupedEditorFields, fields: { ...projectTimelineFields, design: responsiveDesignField('ProjectTimeline', state.media, state.theme) }, defaultProps: projectTimelineDefaults },
      ImageComparison: { ...renderConfig.components.ImageComparison, label: TRADE_COMPONENT_LABELS.ImageComparison, renderFields: groupedEditorFields, fields: { ...imageComparisonFields(state.media), design: responsiveDesignField('ImageComparison', state.media, state.theme) }, defaultProps: imageComparisonDefaults },
      LanguageSwitcher:{...renderConfig.components.LanguageSwitcher,label:'语言切换器',renderFields:groupedEditorFields,fields:{label:textField('语言导航说明'),missing:selectField('缺失翻译',[{value:'hide',label:'隐藏缺译语言'},{value:'disabled',label:'显示不可用语言'}]),design:responsiveDesignField('LanguageSwitcher',state.media,state.theme)},defaultProps:{label:'Languages',missing:'hide'}},
      Download: { ...renderConfig.components.Download, label: 'PDF目录下载', renderFields: groupedEditorFields, fields: { text: textField('下载按钮文字'), fileUrl: selectField('PDF目录素材', state.media.filter(m => m.kind === 'document').map(m => ({ value: m.url, label: m.name }))), design: responsiveDesignField('Download', state.media, state.theme) }, defaultProps: { text: 'Download catalog (PDF)', fileUrl: '' } },
      Form: { ...renderConfig.components.Form, label: '网站询盘表单', renderFields: groupedEditorFields, fields: { formId: formReferenceField(), wideFields: formWideFieldsField(), buttonAlign: selectField('提交按钮对齐', [{ value: 'left', label: '靠左' }, { value: 'center', label: '居中' }, { value: 'right', label: '靠右' }]), design: responsiveDesignField('Form', state.media, state.theme), fieldDesign: responsiveDesignField('FormField', state.media), submitDesign: responsiveDesignField('FormSubmit', state.media) }, defaultProps: { formId: '', buttonAlign: 'left', design: { desktop: { display: 'grid', columns: 1, gap: 24 }, mobile: { columns: 1 } } } },
      RichText: { ...renderConfig.components.RichText, label: '图文内容', renderFields: groupedEditorFields, fields: { doc: richTextField(), design: responsiveDesignField('RichText', state.media, state.theme) }, defaultProps: { doc: textToRichText('Share your story with rich, accessible content.') } },
      Icon: { ...renderConfig.components.Icon, label: '图标', renderFields: groupedEditorFields, fields: { icon: selectField('图标', ICON_NAMES.map(value => ({ value, label: value }))), label: textField('图标说明（装饰图标留空）'), design: responsiveDesignField('Icon', state.media, state.theme) }, defaultProps: { icon: 'check', label: '' } },
      Divider: { ...renderConfig.components.Divider, label: '分隔线', renderFields: groupedEditorFields, fields: { text: textField('分隔说明'), design: responsiveDesignField('Divider', state.media, state.theme) }, defaultProps: { text: '' } },
      Gallery: { ...renderConfig.components.Gallery, label: '图片画廊', renderFields: groupedEditorFields, fields: { images: collectionField(state.media, true, 20), bindings: dynamicBindingField('Gallery', state, bindingDefaults), ratio: selectField('裁切比例', ['original', '1/1', '4/3', '16/9'].map(value => ({ value, label: value }))), fit: selectField('图片显示', [{ value: 'cover', label: '铺满裁切' }, { value: 'contain', label: '完整显示' }]), lightbox: { type: 'custom', label: '灯箱', render: ({ value, onChange }) => <Form.Item label="打开图片灯箱"><Switch checked={value !== false} onChange={v => onChange(v)} /></Form.Item> }, design: responsiveDesignField('Gallery', state.media, state.theme) }, defaultProps: { images: [{ id: 'sample-1', src: '/images/studio.jpg', alt: 'Studio interior', caption: '' }, { id: 'sample-2', src: '/images/chair.jpg', alt: 'Chair', caption: '' }], ratio: '4/3', fit: 'cover', lightbox: true } },
      Accordion: {...renderConfig.components.Accordion,label:'常见问题 / 折叠内容',renderFields:props=>panelEditorFields({...props,media:state.media}),fields:{items:panelSlotsField(50),firstOpen:{type:'custom',label:'首项展开',render:({value,onChange})=><Form.Item label="默认展开第一项"><Switch checked={Boolean(value)} onChange={checked=>onChange(checked)}/></Form.Item>},design:responsiveDesignField('Accordion',state.media,state.theme)},defaultProps:initialPanelProps('Accordion')},
      Tabs: {...renderConfig.components.Tabs,label:'标签页 / 自由内容',renderFields:props=>panelEditorFields({...props,media:state.media}),fields:{items:panelSlotsField(8),design:responsiveDesignField('Tabs',state.media,state.theme)},defaultProps:initialPanelProps('Tabs')},
      Video: { ...renderConfig.components.Video, label: '视频', renderFields: groupedEditorFields, fields: { videoUrl: videoField(state.media), title: textField('视频标题'), poster: imageAssetField('视频封面（本地视频）', state.media), design: responsiveDesignField('Video', state.media, state.theme) }, defaultProps: { videoUrl: '', title: 'Company introduction', poster: '' } },
      Carousel: {...renderConfig.components.Carousel,label:'轮播 / 自由内容',renderFields:props=>panelEditorFields({...props,media:state.media}),fields:{slides:panelSlotsField(10),design:responsiveDesignField('Carousel',state.media,state.theme)},defaultProps:initialPanelProps('Carousel')},
      // 未设置时仅在控件中显示折叠默认值，不补写存量数据，避免打开编辑器产生伪修改。
      Navigation: { ...renderConfig.components.Navigation, label: '导航菜单', renderFields: groupedEditorFields, fields: { localeMenuIds:localeMenusField(state), menuId: selectField('菜单', [{ value: '', label: '请选择菜单' }, ...(state.siteLayout?.menus || []).map(menu => ({ value: menu.id, label: menu.name }))]), label: textField('无障碍名称'), mobileMode: { type: 'custom', label: '手机显示方式', render: ({value,onChange,id}) => <Form.Item className="editor-property" label="手机显示方式" htmlFor={id} layout="vertical"><Select id={id} aria-label="导航手机显示方式" value={value==='inline'?'inline':'collapse'} options={[{value:'collapse',label:'折叠为菜单'},{value:'inline',label:'始终显示链接'}]} onChange={next=>onChange(next)}/></Form.Item> }, design: responsiveDesignField('Navigation', state.media, state.theme) }, defaultProps: { menuId: '', label: 'Website navigation' } },
      Breadcrumb: { ...renderConfig.components.Breadcrumb, label: '面包屑', renderFields: groupedEditorFields, fields: { homeLabel: textField('首页文字'), design: responsiveDesignField('Breadcrumb', state.media, state.theme) }, defaultProps: { homeLabel: 'Home' } },
      SharedBlock: { ...renderConfig.components.SharedBlock,
        label: '同步区块', renderFields: groupedEditorFields,
        // 排除自身及依赖当前块的候选项，阻止用户在下拉框中创建循环引用。
        fields: { blockId: selectField('引用同步区块', [{ label: '请选择区块', value: '' }, ...(state.sharedBlocks || []).filter((block) => block.id !== options.editingBlockId && (!options.editingBlockId || !getSharedBlockUsage(options.editingBlockId, state).blockIds.includes(block.id))).map((block) => ({ label: block.name, value: block.id }))]), design: responsiveDesignField('SharedBlock', state.media, state.theme) },
        defaultProps: { blockId: '' },
      },
      Container: { ...renderConfig.components.Container,
        label: '容器 / 分栏',
        renderFields: groupedEditorFields,
        // 旧属性继续参与渲染；可见样式统一写入 design，避免两套输入互相覆盖。
        fields: { content: { type: 'slot' }, design: responsiveDesignField('Container', state.media, state.theme) },
        defaultProps: { content: [], layout: 'column', columns: 2, mobileColumns: 1, gap: 20, padding: 48, inset: 40, background: '#f7f5f0', image: '', minHeight: 120, align: 'start' },
      },
      CompanyFacts: {...renderConfig.components.CompanyFacts,label:'企业事实与证据',renderFields:groupedEditorFields,fields:{title:textField('资料区标题'),design:responsiveDesignField('CompanyFacts',state.media,state.theme)},defaultProps:{title:'Company information'}},
      Heading: { ...renderConfig.components.Heading,
        label: '标题',
        renderFields: groupedEditorFields,
        fields: { text: textField('标题内容', true), level: selectField('标题级别（不影响文字大小）', ['h1','h2','h3','h4','h5','h6'].map((value,index)=>({value,label:index===0?'一级标题 · 页面主标题':index===1?'二级标题 · 章节标题':`第${index+1}级标题`}))), bindings: dynamicBindingField('Heading', state, bindingDefaults), design: responsiveDesignField('Heading', state.media, state.theme) },
        defaultProps: { text: 'A little room for possibility.', size: 44, mobileSize: 34, color: '#222a25', align: 'left', style: 'serif', spacing: 0 },
      },
      Text: { ...renderConfig.components.Text,
        label: '正文',
        renderFields: groupedEditorFields,
        fields: { text: textField('正文内容', true), bindings: dynamicBindingField('Text', state, bindingDefaults), design: responsiveDesignField('Text', state.media, state.theme) },
        defaultProps: { text: 'Thoughtful design, natural materials and a sense of belonging. Made for the spaces we call home.', size: 15, color: '#657067', align: 'left', maxWidth: 500 },
      },
      Image: { ...renderConfig.components.Image,
        label: '图片',
        renderFields: groupedEditorFields,
        fields: { src: imageAssetField('图片素材', state.media), alt: textField('图片说明'), imageSize: selectField('图片加载尺寸', [{ value: 'auto', label: '按屏幕自动选择' }, { value: 'original', label: '原尺寸' }, ...['320', '768', '1440'].map(value => ({ value, label: `${value}px（原图足够大时）` }))]), bindings: dynamicBindingField('Image', state, bindingDefaults), design: responsiveDesignField('Image', state.media, state.theme) },
        defaultProps: { src: '/images/studio.jpg', alt: 'Morrow studio interior', height: 360, fit: 'cover', radius: 0 },
      },
      ActionButton: { ...renderConfig.components.ActionButton,
        label: '按钮 / 链接',
        renderFields: groupedEditorFields,
        fields: { text: textField('按钮文字'), href: textField('链接地址'), linkTarget: linkTargetField(state), kind: selectField('基础外观', [{ label: '跟随全站主题', value: 'theme' }, { label: '深色', value: 'dark' }, { label: '浅色', value: 'light' }, { label: '线框', value: 'outline' }]), bindings: dynamicBindingField('ActionButton', state, bindingDefaults), design: responsiveDesignField('ActionButton', state.media, state.theme) },
        defaultProps: { text: 'Explore the collection', href: '#collection', kind: 'theme', align: 'left' },
      },
      ProductList: { ...renderConfig.components.ProductList,
        label: '产品集合',
        renderFields: groupedEditorFields,
        fields: { eyebrow: textField('栏目说明'), title: textField('栏目标题'), count: numberField('展示数量', 1, 12), category: textField('分类过滤（留空显示全部）'), design: responsiveDesignField('ProductList', state.media, state.theme) },
        defaultProps: { eyebrow: 'THE CONSIDERED COLLECTION', title: 'Good things, made to stay.', columns: 3, mobileColumns: 1, count: 3, category: '', padding: 64 },
      },
      ProductDetail: { ...renderConfig.components.ProductDetail,
        label: '产品详情 · 动态绑定',
        renderFields: groupedEditorFields,
        fields: { productId: selectField('预览产品（不改变发布状态）', [{ label: '默认首个产品', value: '' }, ...state.products.map((product) => ({ label: product.name, value: product.id }))]), mobileOrder: selectField('手机详情顺序', [
          { label: '产品信息优先', value: 'identity-first' },
          { label: '选型优先 · 图集后看规格', value: 'specifications-first' },
          { label: '概览优先 · 先读介绍再看图', value: 'overview-first' },
          { label: '图片优先（原有方式）', value: 'image-first' },
        ]), cta: textField('联系按钮文字'), linkTarget: linkTargetField(state), ctaColor: { type: 'custom', label: '联系按钮颜色', render: props => <ProductDetailColorField {...props} fallback={state.theme.primary} /> }, showCustomFields: selectField('扩展产品字段', [{ label: '显示已填写的自定义字段', value: 'yes' }, { label: '隐藏（自行绑定独立元素）', value: 'no' }]), design: responsiveDesignField('ProductDetail', state.media, state.theme) },
        defaultProps: { productId: '', layout: 'split', imageHeight: 550, padding: 64, cta: 'Enquire about this piece' },
      },
      ContentList: { ...renderConfig.components.ContentList,
        label: '案例等内容列表', renderFields: groupedEditorFields,
        fields: { title: textField('列表栏目标题'), source: contentListSourceField(state), count: numberField('最多显示记录', 1, 12), emptyText: textField('没有内容时的提示'), design: responsiveDesignField('ContentList', state.media, state.theme) },
        defaultProps: { source: 'product', modelId: '', title: 'Explore our collection', count: 6, columns: 3, mobileColumns: 1, titleField: 'builtin:name', descriptionField: 'builtin:description', imageField: 'builtin:image', linkField: 'builtin:url', emptyText: 'No content is available yet.', padding: 48 },
      },
      ContentLoop: { ...renderConfig.components.ContentLoop,
        label: '自定义卡片列表', renderFields: groupedEditorFields,
        fields: { eyebrow: textField('栏目说明'), title: textField('列表栏目标题'), query: queryField(state), source: contentLoopSourceField(state, options.editingBlockId), count: numberField('最多显示记录', 1, 50), emptyText: textField('没有内容时的提示'), design: responsiveDesignField('ContentLoop', state.media, state.theme) },
        defaultProps: { source: 'entry', modelId: '', itemBlockId: '', title: '', count: 6, columns: 3, mobileColumns: 1, gap: 24, padding: 48, emptyText: 'No content is available yet.' },
      },
      Spacer: { ...renderConfig.components.Spacer,
        label: '留白 / 分隔',
        renderFields: groupedEditorFields,
        fields: { line: selectField('分隔线', [{ label: '不显示', value: 'no' }, { label: '显示', value: 'yes' }]), design: responsiveDesignField('Spacer', state.media, state.theme) },
        defaultProps: { height: 40, line: 'no' },
      },
    },
  };
  // Puck 渲染会合并 defaultProps；模式不能放在默认值里，否则旧面板会被静默改成新版。
  for(const type of ['Tabs','Accordion','Carousel'])config.components[type].resolveData=(data,{trigger})=>trigger==='insert'?{props:{...data.props,...convertToFreePanels(type,data.props)}}:{};
  for (const [type,component] of Object.entries(config.components)) {
    if(COMPONENT_TRANSLATABLE_LABELS[type])component.fields={...component.fields,labels:componentLabelsField(type)};
    component.fields = { ...component.fields, anchor: textField('锚点别名'), nodeLabel: textField('图层名称'), locked: { type: 'custom', label: '编辑保护', render: ({ value, onChange }) => <Form.Item label="锁定移动和删除"><Switch checked={Boolean(value)} onChange={checked => onChange(checked)} /></Form.Item> }, stylePresetId: presetField(state.theme), tokenBindings: tokenField(state.theme), stateStyles: stateField() };
    // 锁定是画布误操作保护，服务端角色权限仍独立验证；保留属性入口可解锁。
    component.resolvePermissions = data => ({ drag: !data.props.locked, delete: !data.props.locked, duplicate: !data.props.locked });
  }
  return config;
}
