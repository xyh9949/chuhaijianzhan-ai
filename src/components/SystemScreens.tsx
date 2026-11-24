"use client";
import MoreSettings from './MoreSettings';
import OperationsStatus from './OperationsStatus';
import DiscoveryManager from './DiscoveryManager';
import ExtensionManager from './ExtensionManager';
import LocalizationManager from './LocalizationManager';
import { localRecoveries, readLocalRecovery, requestLocalLeave } from '@/lib/local-recovery';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import { readFreshStudio } from '@/lib/refresh-studio';
import { useLocalDraftGuard } from './useLocalDraftGuard';
import SitePackagePanel from './SitePackagePanel';
import PageTemplateLibrary from './PageTemplateLibrary';
import AiSiteBuilder from './AiSiteBuilder';
import { planEditorRecoveryScope } from './AiBuildPlanEditor';
import AiServiceSettings from './AiServiceSettings';
import MailSettings from './MailSettings';
import LaunchCheck from './LaunchCheck';
import { InquiryNotificationSettings } from './InquiryOperations';

import { useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, ColorPicker, ConfigProvider,
  Descriptions, Divider, Flex, Form, Grid, Image, Input, InputNumber,
  Modal, Radio, Row, Segmented, Select, Space, Tabs,
  Tag, Tooltip, Typography, message,
} from 'antd';
import {
  AppstoreOutlined, ArrowRightOutlined,
  CheckOutlined, CloudDownloadOutlined, DesktopOutlined,
  DownloadOutlined, EyeOutlined, GlobalOutlined,
  InfoCircleOutlined, LayoutOutlined, LinkOutlined, MailOutlined, MobileOutlined,
  ReloadOutlined, SafetyCertificateOutlined, SettingOutlined,
  SkinOutlined, TeamOutlined,
} from '@ant-design/icons';
import type { PageItem, ScreenProps, SiteSettings, SiteTheme } from '../lib/types';
import { createPageData } from '../lib/page-data';
import { formatDate } from '../lib/date-format';
import './system.css';
import MemberManager from './MemberManager';

const { Title, Text, Paragraph } = Typography;
const settingsTabKeys = ['general', 'ai', 'mail', 'launch', 'discovery', 'inquiry-notifications', 'language', 'members', 'backup', 'domain', 'extensions'];

function ScreenHeading({ eyebrow, title, description, actions }: {
  eyebrow: string; title: string; description: string; actions?: React.ReactNode;
}) {
  return <Flex className="sys-heading" justify="space-between" align="flex-end" gap={20} wrap>
    <div><Text className="sys-eyebrow">{eyebrow}</Text><Title level={2}>{title}</Title><Paragraph>{description}</Paragraph></div>
    {actions}
  </Flex>;
}

/** 页面资产、同步区块和整站分发按独立语义呈现，避免复制被误认为同步。 */
export function TemplatesScreen(props: ScreenProps) {
  const runtime=useStudioRuntime();const [resourceTab,setResourceTab]=useState(()=>{try{if(new URL(location.href).searchParams.has('externalTemplate')||sessionStorage.getItem('form-studio:template-library-open'))return 'library';}catch{/* 无会话存储时使用默认资源页。 */}const intent=props.journey?.intent;if(intent)return intent.action==='examples'?'packages':'ai';const saved=localRecoveries(runtime.actor.id).find(r=>r.screen==='templates');return saved?(['ai-site-builder','ai-source-import',planEditorRecoveryScope].includes(saved.scope)?'ai':saved.scope==='site-package'?'packages':'library'):'ai';});
  const [recoverPlanInput,setRecoverPlanInput]=useState(false);
  useEffect(()=>{try{sessionStorage.removeItem('form-studio:template-library-open');}catch{/* 仅清理导航提示。 */}},[]);
  const handledIntent=useRef('');
  useEffect(()=>{const resume=(e:Event)=>{const scope=(e as CustomEvent<{scope?:string}>).detail?.scope;if(scope===planEditorRecoveryScope){setResourceTab('ai');setRecoverPlanInput(true);}else if(scope==='ai-site-builder'||scope==='ai-source-import')setResourceTab('ai');else if(scope==='site-package')setResourceTab('packages');else if(scope?.startsWith('template-')||scope==='ai-detail-design'||scope==='detail-template-rule')setResourceTab('library');};window.addEventListener('form-studio:recover-local',resume);return()=>window.removeEventListener('form-studio:recover-local',resume);},[]);
  // 案例意图由此消费，AI意图留给已挂载的建站组件；切换前沿用未保存保护。
  useEffect(()=>{const intent=props.journey?.intent;if(!intent||handledIntent.current===intent.id)return;handledIntent.current=intent.id;const tab=intent.action==='examples'?'packages':'ai';const open=()=>{setResourceTab(tab);if(intent.action==='examples')props.journey?.consumeIntent(intent.id);};if(tab===resourceTab)open();else requestLocalLeave(open,'site-journey-resource');},[props.journey,resourceTab]);
  // 离开AI页签先处理输入，再卸载向导，避免隐藏向导继续拦截其他资源的操作。
  return <section className="sys-screen"><ScreenHeading eyebrow="设计资源" title="模板与区块" description="用自己的 AI 规划并搭建网站，也可选用现成案例，生成后继续自由编辑。" /><Tabs activeKey={resourceTab} onChange={key => requestLocalLeave(() => setResourceTab(key), 'template-resource-tab')} items={[{ key: 'ai', label: 'AI快速建站', children: resourceTab === 'ai' ? <AiSiteBuilder {...props} recoverPlanInput={recoverPlanInput} onRecoveryHandled={() => setRecoverPlanInput(false)} /> : null }, { key: 'packages', label: '整站案例', children: <SitePackagePanel /> }, { key: 'examples', label: '单页与区块', children: <TemplateExamples {...props} /> }, { key: 'library', label: '我的页面模板', children: <PageTemplateLibrary {...props} /> }]} /></section>;
}

type TemplateKind = 'page' | 'block' | 'kit';
type PageKind = 'home' | 'blank' | 'about' | 'products' | 'contact';
interface TemplateCard {
  id: string; title: string; subtitle: string; category: TemplateKind; badge: string;
  image: string; accent: string; layout: 'split' | 'full' | 'grid' | 'story'; pageKind: PageKind;
}

const TEMPLATE_CARDS: TemplateCard[] = [
  { id: 'atelier', title: 'Atelier · 设计师系列', subtitle: '留白与大图，让产品成为主角', category: 'page', badge: '首页', image: '/images/interior.jpg', accent: '#e9e5dc', layout: 'split', pageKind: 'home' },
  { id: 'catalogue', title: '精选产品目录', subtitle: '清晰分类，适合丰富的产品系列', category: 'page', badge: '产品列表', image: '/images/sofa.jpg', accent: '#e4ebe5', layout: 'grid', pageKind: 'products' },
  { id: 'story', title: '品牌与工厂故事', subtitle: '用真实空间和细节建立信任', category: 'page', badge: '关于我们', image: '/images/studio.jpg', accent: '#eee7dc', layout: 'story', pageKind: 'about' },
  { id: 'hero', title: '沉浸式首屏', subtitle: '全宽视觉、清楚的标题与行动入口', category: 'block', badge: '区块示例', image: '/images/interior.jpg', accent: '#dce3df', layout: 'full', pageKind: 'home' },
  { id: 'contact', title: '一起开始新的项目', subtitle: '轻盈的联系方式与合作邀请', category: 'block', badge: '联系区块', image: '/images/chair.jpg', accent: '#efe9df', layout: 'split', pageKind: 'contact' },
  { id: 'studio', title: 'Studio · 三页设计示例', subtitle: '复制首页、品牌故事与联系页；不含整站模型与素材包', category: 'kit', badge: '3 个页面', image: '/images/studio.jpg', accent: '#e1e6e0', layout: 'full', pageKind: 'home' },
];

function TemplateArtwork({ template, large = false }: { template: TemplateCard; large?: boolean }) {
  return <div className={`sys-template-art sys-art-${template.layout}${large ? ' is-large' : ''}`} style={{ background: template.accent }}>
    <div className="sys-art-nav"><strong>FORM / STUDIO</strong><span>About&nbsp;&nbsp; Collection&nbsp;&nbsp; Contact</span></div>
    {template.layout === 'grid' ? <>
      <div className="sys-art-grid-heading"><span>Objects for living.</span><small>A considered collection</small></div>
      <div className="sys-art-grid-images">{['/images/sofa.jpg', '/images/chair.jpg', '/images/interior.jpg'].map((src, index) => <div key={src}><img src={src} alt="产品目录模板示例" /><span>{['LOUNGE SERIES', 'THE EVERYDAY CHAIR', 'LIVING COLLECTION'][index]}</span></div>)}</div>
    </> : <div className="sys-art-body">
      <img src={template.image} alt={`${template.title}的示例效果`} />
      <div className="sys-art-copy"><small>{template.category === 'block' ? 'A NEW PERSPECTIVE' : 'THOUGHTFULLY MADE'}</small><span>{template.layout === 'story' ? <>Made with care.<br />Built to last.</> : template.id === 'contact' ? <>Good things<br />start here.</> : <>Spaces for<br />a slower life.</>}</span><i>Discover the collection <ArrowRightOutlined /></i></div>
    </div>}
    <div className="sys-art-foot"><span>DESIGN FOR EVERYDAY LIVING</span><span>01 — 06</span></div>
  </div>;
}

function TemplateExamples({ state, update, navigate }: ScreenProps) {
  const [filter, setFilter] = useState('all');
  const [preview, setPreview] = useState<TemplateCard | null>(null);
  const [applying, setApplying] = useState<TemplateCard | null>(null);
  const [pageTitle, setPageTitle] = useState('');
  const [api, holder] = message.useMessage();
  const [saving, setSaving] = useState(false); const savingRef = useRef(false); const creationStamp = useRef('');
  const visible = TEMPLATE_CARDS.filter((item) => filter === 'all' || item.category === filter);

  function beginApply(template: TemplateCard) {
    if (savingRef.current) return;
    creationStamp.current = crypto.randomUUID();
    setPageTitle(template.category === 'kit' ? 'Studio' : template.title.split(' · ')[0]);
    setApplying(template);
  }

  async function applyTemplate() {
    if (!applying || !pageTitle.trim() || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
    const stamp = creationStamp.current;
    const kinds: PageKind[] = applying.category === 'kit' ? ['home', 'about', 'contact'] : [applying.pageKind];
    // 新增草稿保留原站点；失败重试沿用固定 ID，避免乐观列表中出现重复页面。
    const pages: PageItem[] = kinds.map((kind, index) => ({
      id: `template-${stamp}-${index}`, title: kinds.length > 1 ? `${pageTitle} · ${{ home: '首页', about: '品牌故事', contact: '联系我们', blank: '空白页', products: '产品' }[kind]}` : pageTitle.trim(),
      slug: `/${applying.id}-${stamp}${index ? `-${kind}` : ''}`, status: 'draft', type: '自定义页面', updated: '刚刚',
    }));
    const editorData = { ...state.editorData };
    pages.forEach((page, index) => {
      const data = createPageData(kinds[index]);
      editorData[page.id] = {
        ...data,
        root: { ...data.root, props: { ...data.root?.props, title: page.title, ...(applying.category === 'block' ? { showChrome: 'no' } : {}) } },
        // 区块示例只插入首个可编辑区块，不把整页模板冒充成共享区块。
        content: applying.category === 'block' ? data.content.slice(0, 1) : data.content,
      };
    });
    await update({ pages: [...state.pages.filter((page) => !pages.some((created) => created.id === page.id)), ...pages], editorData, activePageId: pages[0].id });
    setApplying(null); setPreview(null);
    api.success(`已创建 ${pages.length} 个草稿页面`);
    navigate('editor');
    } catch (error) { api.error(error instanceof Error ? error.message : '创建未完成，名称与模板选择已保留'); }
    finally { savingRef.current = false; setSaving(false); }
  }

  return <div className="sys-screen">{holder}
    <Flex justify="space-between" align="center" gap={12} wrap style={{marginBottom:16}}><Text type="secondary">选择一个设计，创建可独立编辑的页面。</Text><Button icon={<SkinOutlined />} onClick={()=>navigate('theme')}>调整网站外观</Button></Flex>
    <Card className="sys-template-intro" variant="borderless"><Flex justify="space-between" align="center" gap={24}><div><Title level={4}>复用结构，保留编辑自由</Title><Paragraph>应用模板会创建新的可编辑草稿。这里的区块示例会复制到独立页面；需要全站同步的内容请到“全站设计 → 同步区块”维护。</Paragraph></div><div className="sys-template-intro-icon"><LayoutOutlined /></div></Flex></Card>
    <Flex className="sys-section-toolbar" justify="space-between" align="center" gap={16} wrap><Segmented value={filter} onChange={(value) => setFilter(String(value))} options={[{ label: '全部模板', value: 'all' }, { label: '页面', value: 'page' }, { label: '区块示例', value: 'block' }, { label: '旧版多页示例', value: 'kit' }]} /><Text type="secondary">可预览 · 可编辑 · 不覆盖已有页面</Text></Flex>
    <Row gutter={[20, 24]}>{visible.map((template) => <Col xs={24} md={12} xl={8} key={template.id}>
      <Card className="sys-template-card" cover={<div className="sys-template-cover" onClick={() => setPreview(template)} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && setPreview(template)} aria-label={`预览${template.title}`}><TemplateArtwork template={template} /><div className="sys-template-hover"><Button icon={<EyeOutlined />} onClick={(event) => { event.stopPropagation(); setPreview(template); }}>预览模板</Button></div></div>}>
        <Flex justify="space-between" align="start" gap={8}><div><Title level={5}>{template.title}</Title><Paragraph type="secondary">{template.subtitle}</Paragraph></div><Tag>{template.badge}</Tag></Flex>
        <Flex justify="space-between" align="center"><Space size={5}><span className="sys-color-dot" style={{ background: template.accent }} /><span className="sys-color-dot" style={{ background: '#293f33' }} /><Text className="sys-caption">响应式设计</Text></Space><Button type="text" className="sys-text-action" onClick={() => beginApply(template)}>使用模板 <ArrowRightOutlined /></Button></Flex>
      </Card>
    </Col>)}</Row>
    <Modal open={!!preview} onCancel={() => setPreview(null)} title={preview?.title} width={850} footer={<Space><Button onClick={() => setPreview(null)}>关闭预览</Button><Button type="primary" onClick={() => preview && beginApply(preview)}>从这个模板开始 <ArrowRightOutlined /></Button></Space>}>
      {preview && <><TemplateArtwork template={preview} large /><Paragraph className="sys-modal-note">{preview.subtitle}。图片与品牌为模板示例；应用后将创建独立草稿，不影响现有页面。</Paragraph></>}
    </Modal>
    <Modal open={!!applying} onCancel={() => { if (!savingRef.current) setApplying(null); }} closable={!saving} maskClosable={!saving} cancelButtonProps={{ disabled: saving }} confirmLoading={saving} title={applying?.category === 'kit' ? '创建网站套件草稿' : '使用这个设计'} okText="创建并打开编辑器" onOk={applyTemplate} okButtonProps={{ disabled: !pageTitle.trim() }}>
      <Paragraph>将在当前工作区中新建{applying?.category === 'kit' ? '首页、品牌故事、联系页三个' : '一个'}草稿。{applying?.category === 'block' ? '区块将放入新的示例页面，方便继续编辑。' : '已有页面不会被覆盖。'}</Paragraph>
      <Form disabled={saving || undefined} layout="vertical"><Form.Item label={applying?.category === 'kit' ? '套件名称前缀' : '页面名称'} required><Input value={pageTitle} onChange={(event) => setPageTitle(event.target.value)} maxLength={60} /></Form.Item></Form>
      <Alert type="info" showIcon title="模板创建为草稿，需要另行发布后才对访客可见。" />
    </Modal>
  </div>;
}

interface ThemeExtras { contentWidth: number; buttonStyle: 'solid' | 'outline'; buttonSize: 'small' | 'middle' | 'large'; }
const DEFAULT_EXTRAS: ThemeExtras = { contentWidth: 1200, buttonStyle: 'solid', buttonSize: 'middle' };

type ThemeDraft = Pick<SiteTheme, 'primary' | 'background' | 'text' | 'font' | 'radius'>;
type ThemeRecovery = { base: number; draft: ThemeDraft; extras: ThemeExtras };
type BasicSettingsValues = Required<Pick<SiteSettings, 'name' | 'description' | 'publicUrl' | 'email' | 'domain' | 'language' | 'timezone'>>;
type BasicSettingsRecovery = { base: number; values: BasicSettingsValues; tab: string };
const basicSettingsKeys = ['name', 'description', 'publicUrl', 'email', 'domain', 'language', 'timezone'] as const;
const themeValues = (theme: SiteTheme): ThemeDraft => ({ primary: theme.primary, background: theme.background, text: theme.text, font: theme.font, radius: theme.radius });
const themeExtras = (state: ScreenProps['state']): ThemeExtras => ({ ...DEFAULT_EXTRAS, ...(state.editorData.__themeControls as Partial<ThemeExtras> || {}) });
const basicSettingsValues = (settings: SiteSettings): BasicSettingsValues => ({ name: settings.name, description: settings.description, publicUrl: settings.publicUrl || '', email: settings.email, domain: settings.domain, language: settings.language, timezone: settings.timezone });
// 恢复区只接受当前界面的手工字段；不从浏览器缓存恢复整站配置或自动提交。
function validThemeRecovery(value: unknown): value is ThemeRecovery {
  const item = value as ThemeRecovery;
  return !!item && Number.isSafeInteger(item.base) && item.base >= 0 && !!item.draft && ['primary', 'background', 'text', 'font'].every(key => typeof item.draft[key as keyof ThemeDraft] === 'string' && (item.draft[key as keyof ThemeDraft] as string).length <= 200) && Number.isFinite(item.draft.radius) && item.draft.radius >= 0 && item.draft.radius <= 32 && !!item.extras && Number.isFinite(item.extras.contentWidth) && item.extras.contentWidth >= 960 && item.extras.contentWidth <= 1600 && ['solid', 'outline'].includes(item.extras.buttonStyle) && ['small', 'middle', 'large'].includes(item.extras.buttonSize);
}
function validBasicSettingsRecovery(value: unknown): value is BasicSettingsRecovery {
  const item = value as BasicSettingsRecovery;
  return !!item && Number.isSafeInteger(item.base) && item.base >= 0 && !!item.values && basicSettingsKeys.every(key => typeof item.values[key] === 'string' && item.values[key].length <= 2048) && ['general', 'domain', 'language'].includes(item.tab);
}
const FONT_OPTIONS = [{ label: '现代无衬线 · Inter / 系统回退', value: 'Inter' }, { label: '系统字体 · System', value: 'system' }, { label: '优雅衬线 · Georgia', value: 'Georgia' }];
function fontFamily(font: string) { return font === 'Georgia' ? 'Georgia, "Times New Roman", serif' : font === 'system' ? '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' : 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'; }

export function ThemeScreen({ state }: ScreenProps) {
  const runtime = useStudioRuntime();
  const readRecovery = () => readLocalRecovery<ThemeRecovery>(runtime.actor.id, 'site-theme', validThemeRecovery);
  const [recovered] = useState(readRecovery);
  const [draft, setDraft] = useState<SiteTheme>({ ...state.theme, ...recovered?.snapshot.draft });
  const [extras, setExtras] = useState<ThemeExtras>(recovered?.snapshot.extras || themeExtras(state));
  const [viewport, setViewport] = useState('desktop');
  const [api, holder] = message.useMessage();
  const [saving, setSaving] = useState(false); const savingRef = useRef(false);
  const [themeError, setThemeError] = useState(recovered ? '已恢复未保存的外观调整，请核对后再保存。' : '');
  const baseRef = useRef(recovered?.snapshot.base ?? runtime.envelope.revision);
  const baseline = useRef(JSON.stringify({ draft: themeValues(state.theme), extras: themeExtras(state) }));
  const currentValues = { draft: themeValues(draft), extras }, dirty = JSON.stringify(currentValues) !== baseline.current;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const savedValues = JSON.stringify({ draft: themeValues(state.theme), extras: themeExtras(state) });
  // 干净表单跟随其他分区保存后的版本；有未保存调整时保留本地值和原修订号。
  useEffect(() => { if (!dirtyRef.current) { baseline.current = savedValues; baseRef.current = runtime.getEnvelope().revision; setDraft(state.theme); setExtras(themeExtras(state)); } }, [savedValues, runtime.envelope.revision]);
  function discardTheme() { const current = runtime.getEnvelope(); baseline.current = JSON.stringify({ draft: themeValues(current.state.theme), extras: themeExtras(current.state) }); baseRef.current = current.revision; setDraft(current.state.theme); setExtras(themeExtras(current.state)); setThemeError(''); }
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: 'site-theme', screen: 'theme', title: '网站外观', dirty, busy: saving, snapshot: { base: baseRef.current, ...currentValues }, save: saveTheme, discard: discardTheme });
  useEffect(() => { const restore = (event: Event) => { if ((event as CustomEvent).detail?.scope !== 'site-theme') return; const saved = readRecovery(); if (!saved) return; baseRef.current = saved.snapshot.base; setDraft({ ...runtime.getEnvelope().state.theme, ...saved.snapshot.draft }); setExtras(saved.snapshot.extras); setThemeError('已恢复未保存的外观调整，请核对后再保存。'); }; window.addEventListener('form-studio:recover-local', restore); return () => window.removeEventListener('form-studio:recover-local', restore); }, []);
  const patchTheme = (patch: Partial<SiteTheme>) => setDraft((current) => ({ ...current, ...patch }));
  async function saveTheme() {
    if (savingRef.current) return false; savingRef.current = true; setSaving(true); setThemeError('');
    try {
      if (runtime.getEnvelope().revision !== baseRef.current) throw new RequestError(409, '工作区已变化，调整仍保留；请读取最新工作区并核对后再保存。');
      // 恢复稿沿用原修订号；排队期间版本变化也不得覆盖别处已保存的资料。
      await runtime.mutate(env => { if (env.revision !== baseRef.current) throw new RequestError(409, '工作区已变化，调整仍保留；请读取最新工作区并核对后再保存。'); return request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { theme: { ...env.state.theme, ...themeValues(draft) }, editorData: { ...env.state.editorData, __themeControls: extras } } }) }); });
      baseline.current = JSON.stringify(currentValues); baseRef.current = runtime.getEnvelope().revision; guard.clear(); api.success('主题草稿已保存，可在草稿预览中查看'); return true;
    } catch (error) { const text = error instanceof Error ? error.message : '主题保存失败，当前调整已保留'; setThemeError(text); api.error(text); return false; }
    finally { savingRef.current = false; setSaving(false); }
  }
  return <div className="sys-screen">{holder}{guard.dialog}
    <ScreenHeading eyebrow="设计资源" title="网站外观" description="设置客户网站的颜色、字体与组件细节；不会改变管理后台风格。" actions={<Space><Button disabled={saving || undefined} icon={<ReloadOutlined />} onClick={() => { discardTheme(); guard.clear(); }}>放弃本次调整</Button><Button type="primary" loading={saving} icon={<CheckOutlined />} onClick={saveTheme}>保存外观</Button></Space>} />
    {themeError && <Alert className="sys-inline-alert" type="warning" showIcon title={themeError} action={<Button disabled={saving} onClick={async () => { try { const env = await readFreshStudio(runtime); baseRef.current = env.revision; baseline.current = JSON.stringify({ draft: themeValues(env.state.theme), extras: themeExtras(env.state) }); setThemeError('已读取最新工作区，当前调整仍保留；核对后再保存。'); } catch (error) { setThemeError((error as Error).message); } }}>读取最新工作区</Button>} />}
    <Row gutter={[24, 24]}><Col xs={24} xl={8}>
      <Card className="sys-panel" title={<Space><SkinOutlined /> 品牌基础</Space>}>
        <div className="sys-field-heading"><Text strong>颜色</Text><Text type="secondary">整个网站的视觉基调</Text></div>
        {([{ key: 'primary', label: '品牌主色', help: '按钮、链接和品牌元素' }, { key: 'background', label: '页面背景', help: '网站的基础画布颜色' }, { key: 'text', label: '正文颜色', help: '标题与主要文字' }] as const).map((field) => <Flex key={field.key} className="sys-color-field" justify="space-between" align="center"><div><Text>{field.label}</Text><Text className="sys-field-help">{field.help}</Text></div><ColorPicker disabled={saving || undefined} value={draft[field.key]} showText onChangeComplete={(color) => patchTheme({ [field.key]: color.toHexString() })} /></Flex>)}
        <div className="sys-palette-row">{[{ primary: '#25634E', background: '#FAFAF6', text: '#202823' }, { primary: '#866645', background: '#F9F5EF', text: '#302B26' }, { primary: '#334C65', background: '#F6F8FA', text: '#202A36' }, { primary: '#303030', background: '#FFFFFF', text: '#202020' }].map((palette) => <Tooltip key={palette.primary} title="应用配色"><Button disabled={saving || undefined} className="sys-palette-button" onClick={() => patchTheme(palette)} aria-label={`应用${palette.primary}配色`}><span style={{ background: palette.primary }} /><span style={{ background: palette.background }} /><span style={{ background: palette.text }} /></Button></Tooltip>)}</div>
        <Divider />
        <Form disabled={saving || undefined} layout="vertical"><Form.Item label="字体家族"><Select value={draft.font} options={FONT_OPTIONS} onChange={(font) => patchTheme({ font })} /></Form.Item><Form.Item label={<Flex justify="space-between" style={{ width: '100%' }}><span>元素圆角</span><Text type="secondary">px</Text></Flex>}><InputNumber min={0} max={32} step={2} value={draft.radius} onChange={(radius) => patchTheme({ radius: radius ?? 0 })} style={{ width: '100%' }} /></Form.Item><Form.Item label="内容最大宽度"><Space.Compact block><InputNumber min={960} max={1600} step={40} value={extras.contentWidth} onChange={(value) => setExtras((current) => ({ ...current, contentWidth: value ?? 1200 }))} style={{ width: '100%' }} /><Input readOnly tabIndex={-1} value="px" aria-label="宽度单位：像素" style={{ width: 52, textAlign: 'center', color: 'var(--muted)', background: 'var(--bg)' }} /></Space.Compact></Form.Item></Form>
      </Card>
      <Card className="sys-panel sys-spaced-panel" title="按钮与细节"><Form disabled={saving || undefined} layout="vertical"><Form.Item label="主要按钮样式"><Radio.Group value={extras.buttonStyle} onChange={(event) => setExtras((current) => ({ ...current, buttonStyle: event.target.value }))} optionType="button" options={[{ label: '实心', value: 'solid' }, { label: '描边', value: 'outline' }]} /></Form.Item><Form.Item label="按钮尺寸"><Segmented block value={extras.buttonSize} onChange={(value) => setExtras((current) => ({ ...current, buttonSize: value as ThemeExtras['buttonSize'] }))} options={[{ label: '紧凑', value: 'small' }, { label: '标准', value: 'middle' }, { label: '宽松', value: 'large' }]} /></Form.Item></Form><Text className="sys-field-help">主题调整会影响继承全站样式的组件，单独设置的元素仍保留自己的样式。</Text></Card>
    </Col><Col xs={24} xl={16}>
      <Card className="sys-theme-preview-shell" title={<Space><EyeOutlined /> 实时效果</Space>} extra={<Segmented value={viewport} onChange={(value) => setViewport(String(value))} options={[{ value: 'desktop', icon: <DesktopOutlined /> }, { value: 'mobile', icon: <MobileOutlined /> }]} />}>
        <div className={`sys-theme-canvas ${viewport === 'mobile' ? 'is-mobile' : ''}`}>
          {/* 网站样式预览单独建立主题，避免继承后台的字体、圆角和组件配置。 */}
          <ConfigProvider theme={{ inherit: false, token: { colorPrimary: draft.primary, colorText: draft.text, borderRadius: draft.radius, fontFamily: fontFamily(draft.font) } }}>
            <div className="sys-site-preview" style={{ background: draft.background, color: draft.text, fontFamily: fontFamily(draft.font), maxWidth: viewport === 'desktop' ? `${Math.min(100, extras.contentWidth / 16)}%` : undefined }}>
              <div className="sys-site-nav"><Text strong>{state.settings.name || 'FORM & FIELD'}</Text><Space size={16}><Text>Collection</Text><Text>Our story</Text><Button size="small" type="text" icon={<ArrowRightOutlined />} onClick={() => api.info('这里展示主题效果，完整页面可在网站预览中查看。')} /></Space></div>
              <div className="sys-site-hero"><div><Text className="sys-site-kicker" style={{ color: draft.primary }}>MADE FOR YOUR EVERYDAY</Text><Title level={2} style={{ color: draft.text, fontFamily: fontFamily(draft.font) }}>Considered design.<br />Lasting comfort.</Title><Paragraph style={{ color: draft.text, opacity: .68 }}>Thoughtful furniture for spaces that feel like home. Discover a collection made to live with.</Paragraph><Button type={extras.buttonStyle === 'solid' ? 'primary' : 'default'} size={extras.buttonSize} style={extras.buttonStyle === 'outline' ? { color: draft.primary, borderColor: draft.primary } : undefined} onClick={() => api.info('这是主题中的按钮样式预览。')}>Explore the collection <ArrowRightOutlined /></Button></div><Image src="/images/chair.jpg" alt="主题预览中的休闲椅" preview={false} style={{ borderRadius: draft.radius }} /></div>
              <div className="sys-site-collection"><Flex justify="space-between" align="center"><Title level={4} style={{ fontFamily: fontFamily(draft.font), color: draft.text }}>A few of our favorites</Title><Text style={{ color: draft.primary }}>View all →</Text></Flex><div className="sys-site-products">{[{ image: '/images/sofa.jpg', name: 'The Sunday Sofa', label: 'Soft lines. Quiet comfort.' }, { image: '/images/interior.jpg', name: 'Spaces to slow down', label: 'Our considered spaces.' }].map((product) => <div key={product.image}><Image src={product.image} alt={product.name} preview={false} style={{ borderRadius: draft.radius }} /><Text strong style={{ color: draft.text }}>{product.name}</Text><Text style={{ color: draft.text, opacity: .6 }}>{product.label}</Text></div>)}</div></div>
              <div className="sys-site-foot" style={{ borderColor: `${draft.text}20` }}><Text style={{ color: draft.text }}>Designed with purpose.</Text><Text style={{ color: draft.primary }}>Let’s talk <ArrowRightOutlined /></Text></div>
            </div>
          </ConfigProvider>
        </div>
        <Text className="sys-preview-caption"><InfoCircleOutlined /> 仅预览主题效果。保存会更新主题草稿，需要在发布时勾选全站样式。</Text>
      </Card>
    </Col></Row>
  </div>;
}

export function SettingsScreen({ state, update, navigate }: ScreenProps) {
  const screens = Grid.useBreakpoint();
  const settingsRuntime=useStudioRuntime();
  const readRecovery = () => readLocalRecovery<BasicSettingsRecovery>(settingsRuntime.actor.id, 'site-basic-settings', validBasicSettingsRecovery);
  const [recovered] = useState(readRecovery);
  const [activeTab, setActiveTab] = useState(()=>{const saved=localRecoveries(settingsRuntime.actor.id);const target=typeof window!=='undefined'?new URL(window.location.href).searchParams.get('settings'):null;return target&&settingsTabKeys.includes(target)?target:recovered?.snapshot.tab || (saved.some(r=>r.scope==='ai-writing-profile')?'ai':saved.some(r=>r.scope.startsWith('locale-'))?'language':'general');});
  useEffect(() => {
    // 询盘通知入口只定位本分区；地址只记栏目，刷新仍可回到邮件页，不携带口令或自动保存。
    const open = () => { setActiveTab('mail'); };
    const openTab = (event: Event) => { const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab; if (tab && settingsTabKeys.includes(tab)) setActiveTab(tab); };
    const initialTab = new URL(location.href).searchParams.get('settings'); if (initialTab && settingsTabKeys.includes(initialTab)) setActiveTab(initialTab);
    window.addEventListener('form-studio:open-mail-settings', open); window.addEventListener('form-studio:open-settings-tab', openTab);
    return () => { window.removeEventListener('form-studio:open-mail-settings', open); window.removeEventListener('form-studio:open-settings-tab', openTab); };
  }, []);
  useEffect(()=>{const resume=(e:Event)=>{const scope=(e as CustomEvent).detail?.scope;if(scope==='ai-writing-profile')setActiveTab('ai');else if(scope?.startsWith('locale-'))setActiveTab('language');};window.addEventListener('form-studio:recover-local',resume);return()=>window.removeEventListener('form-studio:recover-local',resume);},[]);
  const [form] = Form.useForm<SiteSettings>();
  const initialValues = useRef(recovered?.snapshot.values || basicSettingsValues(state.settings));
  const [domain, setDomain] = useState(initialValues.current.domain);
  const [language, setLanguage] = useState(initialValues.current.language);
  const [timezone, setTimezone] = useState(initialValues.current.timezone);
  const [api, holder] = message.useMessage();
  const [exportedAt, setExportedAt] = useState('');
  const [showBackupHelp, setShowBackupHelp] = useState(false);
  const [saving, setSaving] = useState(false); const savingRef = useRef(false);
  const [settingsError, setSettingsError] = useState(recovered ? '已恢复未保存的网站设置，请核对后再保存。' : '');
  const baseRef = useRef(recovered?.snapshot.base ?? settingsRuntime.envelope.revision), baseline = useRef(basicSettingsValues(state.settings));
  const watched = Form.useWatch([], { form, preserve: true });
  const draft = basicSettingsValues({ ...state.settings, ...initialValues.current, ...(watched || {}), domain, language, timezone });
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.current), dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const savedValues = JSON.stringify(basicSettingsValues(state.settings)), firstSync = useRef(true);
  function replaceValues(values: BasicSettingsValues) { form.setFieldsValue(values); setDomain(values.domain); setLanguage(values.language); setTimezone(values.timezone); }
  // 干净表单跟随语言等子模块的新版本；未保存资料、域名和时区仍保留原版本，不被刷新覆盖。
  useEffect(() => { if (firstSync.current) { firstSync.current = false; form.setFieldsValue(initialValues.current); } else if (!dirtyRef.current) { const values = basicSettingsValues(state.settings); baseline.current = values; baseRef.current = settingsRuntime.getEnvelope().revision; replaceValues(values); } }, [savedValues, settingsRuntime.envelope.revision, form]);
  function discardSettings() { const env = settingsRuntime.getEnvelope(), values = basicSettingsValues(env.state.settings); baseline.current = values; baseRef.current = env.revision; replaceValues(values); setSettingsError(''); }
  const guard = useLocalDraftGuard({ actorId: settingsRuntime.actor.id, scope: 'site-basic-settings', screen: 'settings', title: '网站资料与设置', dirty, busy: saving, snapshot: { base: baseRef.current, values: draft, tab: ['general', 'domain', 'language'].includes(activeTab) ? activeTab : 'general' }, save: saveAllSettings, discard: discardSettings });
  useEffect(() => { const restore = (event: Event) => { if ((event as CustomEvent).detail?.scope !== 'site-basic-settings') return; const saved = readRecovery(); if (!saved) return; baseRef.current = saved.snapshot.base; replaceValues(saved.snapshot.values); setActiveTab(saved.snapshot.tab); setSettingsError('已恢复未保存的网站设置，请核对后再保存。'); }; window.addEventListener('form-studio:recover-local', restore); return () => window.removeEventListener('form-studio:recover-local', restore); }, []);
  async function saveSettings(patch: Partial<SiteSettings>, success: string) {
    if (savingRef.current) return false; savingRef.current = true; setSaving(true); setSettingsError('');
    try {
      if (settingsRuntime.getEnvelope().revision !== baseRef.current) throw new RequestError(409, '工作区已变化，输入仍保留；请读取最新工作区并核对后再保存。');
      // 部分设置只更新本次明确保存的字段，并在队列执行时检查恢复稿的原修订号。
      await settingsRuntime.mutate(env => { if (env.revision !== baseRef.current) throw new RequestError(409, '工作区已变化，输入仍保留；请读取最新工作区并核对后再保存。'); return request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { settings: { ...env.state.settings, ...patch } } }) }); });
      baseRef.current = settingsRuntime.getEnvelope().revision; baseline.current = { ...baseline.current, ...patch }; if (JSON.stringify(draft) === JSON.stringify(baseline.current)) guard.clear(); api.success(success); return true;
    }
    catch (error) { const text = error instanceof Error ? error.message : '设置保存失败，当前输入已保留'; setSettingsError(text); api.error(text); return false; }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function saveGeneral(values: SiteSettings) { return saveSettings({ name: values.name, description: values.description, publicUrl: values.publicUrl, email: values.email }, '网站资料草稿已保存'); }
  async function saveAllSettings() {
    try { await form.validateFields(); } catch { setActiveTab('general'); return false; }
    if (draft.domain !== baseline.current.domain && (!draft.domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(draft.domain))) { setActiveTab('domain'); setSettingsError('请输入不含路径的完整域名，例如 www.example.com。'); return false; }
    return saveSettings(Object.fromEntries(basicSettingsKeys.filter(key => draft[key] !== baseline.current[key]).map(key => [key, draft[key]])), '网站设置草稿已保存');
  }
  function exportJson() {
    // 浏览器导出真实的内容状态文件，不声称已备份数据库或服务器文件。
    const exported = new Date();
    const blob = new Blob([JSON.stringify({ format: 'form-studio-workspace', version: 1, exportedAt: exported.toISOString(), state }, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `form-studio-workspace-${exported.toISOString().slice(0, 10)}.json`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportedAt(formatDate(exported.toISOString(), state.settings.timezone)); api.success('内容数据 JSON 已交给浏览器下载');
  }
  const general = <Row gutter={[24, 24]}><Col xs={24} xl={16}><Card title="网站基本资料" className="sys-panel"><Form disabled={saving || undefined} form={form} layout="vertical" initialValues={state.settings} onFinish={saveGeneral}><Form.Item name="name" label="网站名称" rules={[{ required: true, whitespace: true, message: '请输入网站名称' }]}><Input placeholder="你的品牌或公司名称" maxLength={80} /></Form.Item><Form.Item name="description" label="网站简介" extra="简洁介绍你是谁、提供什么。这段文字也可作为网站描述的起点。"><Input.TextArea rows={4} showCount maxLength={240} /></Form.Item><Form.Item name="publicUrl" label="网站正式网址" extra="填写客户访问的网址，例如 https://www.example.com，不要加具体页面路径。此处保存网址，实际域名连接需在服务器配置。"><Input placeholder="https://www.your-company.com" /></Form.Item><Form.Item name="email" label="公开联系邮箱" rules={[{ type: 'email', message: '请输入有效邮箱地址' }]}><Input prefix={<MailOutlined />} placeholder="hello@example.com" /></Form.Item><Divider /><Flex justify="space-between" align="center" wrap gap={12}><Text type="secondary">保存后保留为草稿，发布时勾选网站资料后对外生效。</Text><Button type="primary" loading={saving} htmlType="submit">保存资料</Button></Flex></Form></Card></Col><Col xs={24} xl={8}><Card className="sys-settings-tip" variant="borderless"><GlobalOutlined /><Title level={4}>好的介绍，从清楚开始</Title><Paragraph>用客户熟悉的语言介绍公司、产品和服务。让访客在几秒内知道，你能为他们提供什么。</Paragraph><Text type="secondary">名称、简介和联系信息可随时调整。</Text></Card></Col></Row>;
  const domainPanel = <Card className="sys-panel sys-settings-narrow" title="域名显示记录（高级）"><Flex justify="space-between" align="center" className="sys-domain-current"><Space><GlobalOutlined className="sys-green" /><div><Text strong>{state.settings.domain || '尚未设置域名'}</Text><Text className="sys-field-help">已记录的域名名称</Text></div></Space><Tag>尚需连接服务器</Tag></Flex><Form disabled={saving || undefined} layout="vertical"><Form.Item label="域名名称" extra="这里用于记录域名名称；网站正式网址请在“网站资料”中填写。保存此项不会自动连接域名。"><Input prefix="https://" value={domain} onChange={(event) => setDomain(event.target.value.replace(/^https?:\/\//, '').trim())} placeholder="www.yourbrand.com" /></Form.Item><Button type="primary" loading={saving} onClick={async () => { if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) { api.warning('请输入不含路径的完整域名，例如 www.example.com'); return; } await saveSettings({ domain }, '域名配置已保存，仍需配置服务器域名解析和证书'); }}>保存域名配置</Button></Form><Divider /><Alert showIcon type="info" title="正式上线还需要域名解析与证书配置" description="这些操作将在实际部署阶段完成，当前工作区没有连接任何域名服务商。" /></Card>;
  const languagePanel = <Space orientation="vertical" size={24} style={{width:'100%'}}><LocalizationManager navigate={navigate}/><Card className="sys-panel sys-settings-narrow" title="后台时间与默认语言"><Form disabled={saving || undefined} layout="vertical"><MoreSettings title="旧版默认语言设置（高级）"><Form.Item label="网站默认语言" extra="设置语言标识不会自动翻译页面内容。"><Select value={language} disabled={!!state.settings.locales} onChange={setLanguage} options={[{ label: 'English · 英语', value: 'en' }, { label: '简体中文', value: 'zh-CN' }, { label: 'Deutsch · 德语', value: 'de' }, { label: 'Français · 法语', value: 'fr' }, { label: 'Español · 西班牙语', value: 'es' }]} /></Form.Item></MoreSettings><Form.Item label="后台显示时间"><Select value={timezone} onChange={setTimezone} options={[{ label: '香港 / 北京 · UTC+08:00', value: 'Asia/Hong_Kong' }, { label: '世界标准时间 · UTC', value: 'UTC' }, { label: '伦敦 · Europe/London', value: 'Europe/London' }, { label: '纽约 · America/New_York', value: 'America/New_York' }]} /></Form.Item><Button type="primary" loading={saving} onClick={() => { void saveSettings({ language, timezone }, '语言与时区配置已保存'); }}>保存设置</Button></Form></Card></Space>;
  const memberPanel = <MemberManager />;
  const backupPanel = <Row gutter={[24, 24]}><Col xs={24} xl={16}><Card title="下载内容资料副本" className="sys-panel"><Flex gap={20} align="start"><div className="sys-backup-icon"><CloudDownloadOutlined /></div><div><Title level={4}>把当前工作保存为文件</Title><Paragraph type="secondary">导出页面、产品、媒体索引、主题与站点配置，下载一份内容资料文件。图片、账号和完整数据库不包含在内。</Paragraph><Space wrap><Button type="primary" icon={<DownloadOutlined />} onClick={exportJson}>下载内容副本</Button><Button onClick={() => setShowBackupHelp(true)}>查看导出说明</Button></Space></div></Flex><Divider /><Descriptions size="small" column={1} items={[{ key: 'scope', label: '数据范围', children: '本实例当前工作区内容' }, { key: 'last', label: '本次会话最近导出', children: exportedAt || '尚未导出' }, { key: 'server', label: '服务器备份', children: <MoreSettings title="服务器备份详情（维护人员）"><OperationsStatus /></MoreSettings> }]} /></Card></Col><Col xs={24} xl={8}><Card className="sys-settings-tip" variant="borderless"><SafetyCertificateOutlined /><Title level={4}>完整备份，不止一个文件</Title><Paragraph>完整备份需要同时保存数据库、上传素材与应用版本，并实际验证恢复流程。</Paragraph><Text type="secondary">当前 JSON 导出用于保留内容状态，不等同于完整服务器备份。</Text></Card></Col></Row>;
  return <div className="sys-screen">{holder}{guard.dialog}<ScreenHeading eyebrow="站点运营" title="站点设置" description="管理网站资料、AI服务、邮件通知、域名与语言，设置成员权限并导出工作区数据。" />
    {settingsError && <Alert className="sys-inline-alert" type="warning" showIcon title={settingsError} action={<Button disabled={saving} onClick={async () => { try { const env = await readFreshStudio(settingsRuntime); baseRef.current = env.revision; baseline.current = basicSettingsValues(env.state.settings); setSettingsError('已读取最新工作区，当前输入仍保留；核对后再保存。'); } catch (error) { setSettingsError((error as Error).message); } }}>读取最新工作区</Button>} />}
    {/* 桌面使用二级侧向导航；窄屏切回横向标签，避免压缩设置表单。 */}
    <Tabs className="sys-settings-tabs" tabPlacement={screens.lg ? 'start' : 'top'} activeKey={activeTab} onChange={key => requestLocalLeave(() => { setActiveTab(key); const url = new URL(location.href); if (['mail', 'launch'].includes(key)) url.searchParams.set('settings', key); else url.searchParams.delete('settings'); history.replaceState(history.state, '', url.href); }, 'settings-tab')} items={[{ key: 'general', label: <Space><SettingOutlined />网站资料</Space>, children: general }, { key: 'ai', label: <Space><SettingOutlined />AI服务</Space>, children: activeTab === 'ai' ? <AiServiceSettings /> : null }, {key:'discovery',label:'搜索与AI可见性',children:<DiscoveryManager state={state} update={update} navigate={navigate} onEditSite={()=>setActiveTab('general')}/>}, { key: 'mail', label: <Space><MailOutlined />邮件通知</Space>, children: activeTab === 'mail' ? <MailSettings /> : null }, { key: 'launch', label: <Space><SafetyCertificateOutlined />上线检查</Space>, children: activeTab === 'launch' ? <LaunchCheck navigate={navigate} /> : null }, { key: 'inquiry-notifications', label: <Space><MailOutlined />询盘与通知</Space>, children: <InquiryNotificationSettings /> }, { key: 'language', label: <Space><GlobalOutlined />网站语言</Space>, children: languagePanel }, { key: 'members', label: <Space><TeamOutlined />成员与权限</Space>, children: memberPanel }, { key: 'backup', label: <Space><CloudDownloadOutlined />备份与导出</Space>, children: backupPanel }, { key: 'domain', label: <Space><LinkOutlined />域名记录（高级）</Space>, children: domainPanel }, {key:'extensions',label:'开发者扩展',children:<ExtensionManager/>}]} />
    <Modal open={showBackupHelp} title="这个 JSON 文件包含什么" onCancel={() => setShowBackupHelp(false)} footer={<Button type="primary" onClick={() => setShowBackupHelp(false)}>知道了</Button>}><Paragraph>文件保存当前工作区的页面、产品、媒体索引、询盘记录、主题、设置与编辑器数据。</Paragraph><Paragraph>它不包含图片文件、完整数据库、账号或部署环境。完整备份请按交付文档操作。</Paragraph><Alert type="info" showIcon title="文件由浏览器下载，请在下载列表中确认保存位置。" /></Modal>
  </div>;
}
