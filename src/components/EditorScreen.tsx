'use client';
import MoreSettings from './MoreSettings';
import ProductLogo from './ProductLogo';
import BusinessBlockLibrary from './editor/BusinessBlockLibrary';
import AiPageEdit from './AiPageEdit';
import AiDetailDesign from './AiDetailDesign';
import AiBuildSiteCheck from './AiBuildSiteCheck';
import { withEditorRootDefaults } from '@/lib/editor-root-defaults';
import { focusTemplateLibrary, templateEditorState } from '@/lib/template-editor-client';

import LayoutDiagnostics from './editor/LayoutDiagnostics';
import {componentCompatibilityErrors, TRADE_COMPONENT_LABELS} from '@/lib/component-contract';
import {LOCAL_EXTENSIONS,extensionMigrationsNeeded,migrateExtensionData} from '@/extensions/registry';
import {getSharedBlockReferences} from '@/lib/shared-blocks';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Puck, createUsePuck, type ComponentData, type Data } from '@puckeditor/core';
import { Alert, App, Button, Drawer, Dropdown, Grid, Input, InputNumber, Modal, Segmented, Select, Space, Tabs, Tag, Tooltip, Tree, message } from 'antd';
import { AppstoreOutlined, ArrowDownOutlined, ArrowLeftOutlined, ArrowUpOutlined, BarsOutlined, CheckCircleFilled, CopyOutlined, DeleteOutlined, DesktopOutlined, EyeOutlined, GlobalOutlined, MobileOutlined, PlusOutlined, RedoOutlined, SaveOutlined, SettingOutlined, TabletOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import type { ScreenProps } from '@/lib/types';
import { createEditorConfig, getPageData } from '@/lib/editor-config';
import { EditorDeviceContext } from './editor/DesignFields';
import { cloneEditorNode, appendEditorNodeToZone, createLayoutPreset, editorNodes, moveTargets } from '@/lib/editor-layout';
import type { Device, ResponsiveDesign } from '@/lib/responsive-style';
import { textToRichText,createFreePanelNode } from '@/lib/presentation-content';
import { createContentDesignData } from '@/lib/content-design-presets';
import { getTemplatePreviewPath } from '@/lib/content-routes';
import { readLocalRecovery } from '@/lib/local-recovery';
import type { AiBuildCheckLocation } from '@/lib/ai-build-site-check-types';
import { safePreviewNavigation } from '@/lib/site-code-render';
import { EDITOR_MAX_WIDTH, EDITOR_MIN_WIDTH, readEditorTarget, sharedBlockPreviewPages, type EditorPreviewOrigin, type EditorTarget, type LoopCardOrigin } from '@/lib/editor-preview';
import { forgetEditorCanvasHistory, matchesCanvasData, readEditorCanvasHistory, rememberEditorCanvasHistory } from '@/lib/editor-canvas-history';
// 使用同版本官方无外部字体入口，编辑器字体统一随后台本地资源加载。
import '@puckeditor/core/no-external.css';
import './editor.css';

export { createPageData, getPageData } from '@/lib/editor-config';

const componentLabels: Record<string, string> = { ...Object.fromEntries(LOCAL_EXTENSIONS.map(e=>[e.type,e.label])), ...TRADE_COMPONENT_LABELS, CompanyFacts:'企业事实与证据', LanguageSwitcher:'语言切换器', Download: 'PDF目录下载', Form: '网站询盘表单', RichText: '图文内容', Icon: '图标', Divider: '分隔线', Gallery: '图片画廊', Accordion: '常见问题 / 折叠内容', Tabs: '标签页 / 自由内容', Video: '视频', Carousel: '轮播 / 自由内容',  Container: '容器 / 分栏', Heading: '标题', Text: '正文', Image: '图片', ActionButton: '按钮 / 链接', ProductList: '产品集合', ProductDetail: '产品详情 · 动态示例', Spacer: '留白 / 分隔', SharedBlock: '同步区块', ContentList: '案例等内容列表', ContentLoop: '自定义卡片列表' };
const viewports = [{ width: 1280, height: 'auto' as const, label: '桌面' }, { width: 768, height: 'auto' as const, label: '平板' }, { width: 390, height: 'auto' as const, label: '手机' }];
// 仅当前浏览器会话内跨页面复用，不读写系统剪贴板，也不跨站点持久化。
let editorNodeClipboard: ComponentData | undefined;
const useBuilderPuck = createUsePuck();
const iframeOptions = { enabled: true, waitForStyles: true, syncHostStyles: true };

type LoopCardRequest = { nodeId: string; source: 'product' | 'entry'; modelId?: string; blockId?: string; create: boolean };
type CheckFocus = AiBuildCheckLocation & { target: NonNullable<AiBuildCheckLocation['target']> };
function EditorWorkspace({ state, navigate, journey, onSave, documentKey, savedData, canSaveCanvas, editingBlockId, editingTemplateId, onTargetChange, onOpenCard, cardOrigin, onReturnCard, onOpenAi, aiModalOpen, onOpenCheck, checkFocus, preferredPreviewWidth, onPreview }: ScreenProps & { onSave: (data: Data, announce?: boolean) => Promise<void>; documentKey: string; savedData: Data; canSaveCanvas: () => boolean; editingBlockId?: string; editingTemplateId?: string; onTargetChange: (target: string) => void; onOpenCard: (request: LoopCardRequest) => Promise<void>; cardOrigin?: LoopCardOrigin; onReturnCard: () => Promise<void>; onOpenAi: (data: Data, selectedId?: string) => void; aiModalOpen: boolean; onOpenCheck: (data: Data) => Promise<void>; checkFocus?: CheckFocus; preferredPreviewWidth?: number; onPreview: (width: number) => void }) {
  const { appState, dispatch, selectedItem, history, getSelectorForId, getItemBySelector } = useBuilderPuck((store) => store);
  const runtime = useStudioRuntime();
  const { histories, index } = history;
  useEffect(() => {
    // 清空等操作自动保存后立即建立撤销点。服务器和当前历史一致才记住，失败或被替换的画布不能恢复。
    const current = histories[index]?.state.data as Data | undefined;
    if (runtime.saveState !== 'saved' || !canSaveCanvas() || histories.length < 2 || !current || !matchesCanvasData(current, appState.data) || !matchesCanvasData(appState.data, savedData)) return;
    rememberEditorCanvasHistory(runtime.actor.id, documentKey, histories.map(entry => entry.state.data as Data), index);
  }, [runtime.saveState, runtime.actor.id, documentKey, histories, index, appState.data, savedData, canSaveCanvas]);
  const [leftTab, setLeftTab] = useState('elements');
  const [rightTab, setRightTab] = useState('fields');
  // 区块弹窗挂在工作区，切换手机侧栏时不卸载正在查看的库或预览。
  const [blockLibraryOpen,setBlockLibraryOpen]=useState(false);
  const [search, setSearch] = useState('');
  const [layerSearch, setLayerSearch] = useState('');
  const [hasNodeClipboard, setHasNodeClipboard] = useState(Boolean(editorNodeClipboard));
  const [mobilePanel, setMobilePanel] = useState<'elements' | 'properties' | null>(null);
  // 设备是工作区视图状态，不随 Puck 内容历史回退，撤销手机样式不会跳回桌面。
  const [currentWidth, setCurrentWidth] = useState(() => preferredPreviewWidth ?? (window.matchMedia('(max-width: 767px)').matches ? 390 : 1280));
  const [styleClipboard, setStyleClipboard] = useState<ResponsiveDesign>();
  const [cardBusy, setCardBusy] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const screens = Grid.useBreakpoint();
  const compact = screens.md === false;
  const [modal, modalContext] = Modal.useModal();
  const { message: canvasMessage } = App.useApp();
  const handledJourneyIntent=useRef('');
  const handledCheckFocus = useRef<CheckFocus | undefined>(undefined);
  // 流程只打开原AI输入窗，读取Puck当前画布；不保存、生成或套用任何结果。
  useEffect(()=>{const intent=journey?.intent;if(!journey?.session.active||intent?.action!=='ai-edit'||handledJourneyIntent.current===intent.id||runtime.actor.role!=='admin'||aiModalOpen)return;handledJourneyIntent.current=intent.id;journey.consumeIntent(intent.id);if(editingBlockId||editingTemplateId)return;onOpenAi(appState.data,selectedItem?.props.id);},[journey,runtime.actor.role,aiModalOpen,editingBlockId,editingTemplateId,onOpenAi,appState.data,selectedItem?.props.id]);
  const currentPage = state.pages.find((p) => p.id === state.activePageId);
  const editingBlock = state.sharedBlocks?.find((block) => block.id === editingBlockId);
  const editingTemplate = state.pageTemplates?.find(item => item.id === editingTemplateId);
  const targetTitle = editingTemplate?.name || editingBlock?.name || currentPage?.title || '页面';
  const selected = selectedItem ? getSelectorForId(selectedItem.props.id) : undefined;
  const device: Device = currentWidth <= 700 ? 'mobile' : currentWidth <= 1024 ? 'tablet' : 'desktop';
  const zoom = Math.min(1, canvasSize.width / currentWidth);
  const viewportLabel = `${currentWidth} px · ${Math.round(zoom * 100)}%`;
  const nodes = editorNodes(appState.data);
  const selectedNode = nodes.find((node) => node.id === selectedItem?.props.id);
  const layerTree = (parentId?: string): import('antd').TreeDataNode[] => nodes.filter(n => n.parentId === parentId).filter(n => !layerSearch || `${n.label} ${n.type}`.toLowerCase().includes(layerSearch.toLowerCase()) || nodes.some(child => child.ancestors.includes(n.id) && `${child.label} ${child.type}`.toLowerCase().includes(layerSearch.toLowerCase()))).map(n => {
    const selector = getSelectorForId(n.id), item = selector && getItemBySelector(selector);
    return { key: n.id, title: `${item?.props.locked ? '🔒 ' : ''}${n.label}`, children: layerTree(n.id), draggable: !item?.props.locked };
  });
  const outline = <Tree aria-label="页面图层" blockNode defaultExpandAll selectedKeys={selectedItem ? [selectedItem.props.id] : []} treeData={layerTree()} draggable={!layerSearch} onSelect={keys => { const selector = keys[0] && getSelectorForId(String(keys[0])); if (selector) dispatch({ type: 'setUi', ui: { itemSelector: selector } }); }} onDrop={info => {
    const source = nodes.find(n => n.id === info.dragNode.key), target = nodes.find(n => n.id === info.node.key);
    if (!source || !target || source.id === target.id || target.ancestors.includes(source.id)) return;
    const sourceItem = getItemBySelector({ index: source.index, zone: source.zone }), targetItem = getItemBySelector({ index: target.index, zone: target.zone });
    if (sourceItem?.props.locked || targetItem?.props.locked) return;
    // Ant图层拖放和画布共用Puck action；搜索时禁用拖放，避免隐藏兄弟导致位置误判。
    const inside = !info.dropToGap && target.type === 'Container';
    const zone = inside ? `${target.id}:content` : target.zone;
    const after = info.dropPosition - Number(info.node.pos.split('-').at(-1)) > 0;
    let index = inside ? nodes.filter(n => n.zone === zone).length : target.index + (after ? 1 : 0);
    if (source.zone === zone && source.index < index) index--;
    if (source.zone === zone) dispatch({ type: 'reorder', sourceIndex: source.index, destinationIndex: index, destinationZone: zone });
    else dispatch({ type: 'move', sourceIndex: source.index, sourceZone: source.zone, destinationIndex: index, destinationZone: zone });
    dispatch({ type: 'setUi', ui: { itemSelector: { index, zone } } });
  }} />;

  // 返回卡片来源时只恢复选中目标，不把旧画布内容重新覆盖到最新草稿。
  useEffect(() => { try { const saved = JSON.parse(sessionStorage.getItem('form-studio:return-loop-node') || 'null'); const target = editingBlockId ? `block:${editingBlockId}` : editingTemplateId ? `template:${editingTemplateId}` : `page:${state.activePageId}`; if (saved?.target !== target) return; const selector = getSelectorForId(saved.nodeId); if (selector) { dispatch({ type: 'setUi', ui: { itemSelector: selector } }); sessionStorage.removeItem('form-studio:return-loop-node'); } } catch { /* 无恢复目标时保持正常选择。 */ } }, [appState.data, editingBlockId, editingTemplateId, state.activePageId, getSelectorForId, dispatch]);
  async function openLoopCard(create: boolean) {
    if (cardBusy || selectedItem?.type !== 'ContentLoop') return;
    if (selectedItem.props.source === 'entry' && !selectedItem.props.modelId) { message.info('请先为循环列表选择内容模型'); return; }
    setCardBusy(true);
    try { await onSave(appState.data); await onOpenCard({ nodeId: selectedItem.props.id, source: selectedItem.props.source === 'entry' ? 'entry' : 'product', modelId: selectedItem.props.modelId || undefined, blockId: selectedItem.props.itemBlockId || undefined, create }); }
    catch (error) { message.error(error instanceof Error ? error.message : '无法打开卡片编辑器'); }
    finally { setCardBusy(false); }
  }
  async function returnFromCard() { setCardBusy(true); try { await onSave(appState.data); await onReturnCard(); } catch (error) { message.error(error instanceof Error ? error.message : '请先保存当前卡片'); } finally { setCardBusy(false); } }

  // 只缩放外壳，iframe 保持真实设备宽度；断点判断与公开页一致，Puck 保留拖放坐标换算。
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setCanvasSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (appState.ui.previewMode === 'edit' || !canvasRef.current) return;
    const root = canvasRef.current;
    const click = (event: Event) => {
      const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href]');
      const href = link?.getAttribute('href')?.trim();
      if (!href) return;
      // 交互模式仍是编辑画布。跨页链接不能替换 Puck 的 iframe；真实草稿按同源预览路径在新标签打开。
      event.preventDefault();
      event.stopImmediatePropagation();
      // srcdoc 的基础网址可指向后台；即使是普通富文本锚点也在子文档内定位，不触发导航。
      if (href.startsWith('#')) {
        try { link?.ownerDocument.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' }); } catch { /* 无效的锚点不退出编辑器。 */ }
        return;
      }
      const url = URL.parse(href, new URL(currentPage?.slug || '/', location.origin));
      const internal = url && url.origin === location.origin && !/^\/(api|admin|_next|images|fonts)(\/|$)/.test(url.pathname);
      const draftPath = internal && safePreviewNavigation(`${/^\/preview(?:\/|$)/.test(url.pathname) ? '' : '/preview'}${url.pathname}${url.search}${url.hash}`, location.origin);
      if (draftPath && !link?.hasAttribute('download')) window.open(draftPath, '_blank', 'noopener,noreferrer');
      else canvasMessage.info('请使用顶部「预览」核对外部链接，再到公开网站测试跳转或下载。');
    };
    let frame: HTMLIFrameElement | null = null;
    let frameDocument: Document | null = null;
    const bind = () => {
      frameDocument?.removeEventListener('click', click, true);
      frameDocument?.removeEventListener('auxclick', click, true);
      frameDocument = frame?.contentDocument || null;
      frameDocument?.addEventListener('click', click, true);
      frameDocument?.addEventListener('auxclick', click, true);
    };
    const observeFrame = () => {
      const next = root.querySelector('iframe');
      if (frame === next) return;
      frame?.removeEventListener('load', bind);
      frame = next;
      frame?.addEventListener('load', bind);
      bind();
    };
    const observer = new MutationObserver(observeFrame);
    observer.observe(root, { childList: true, subtree: true });
    observeFrame();
    return () => { observer.disconnect(); frame?.removeEventListener('load', bind); frame = null; bind(); };
  }, [appState.ui.previewMode, canvasMessage, currentPage?.slug]);

  // 按钮与拖放调用同一 Puck action，确保替代操作也能撤销和保存。
  // 选中面板内的元素时继续插入同一内容区；容器仍优先插入它自己的 slot。
  const insertionZone=selectedItem?.type==='Container'?`${selectedItem.props.id}:content`:selected?.zone||'root:default-zone';
  function insert(type:string){if(selectedItem?.props.locked)return;if(type==='Tabs'||type==='Accordion'||type==='Carousel'){insertNode(createFreePanelNode(type));return;}dispatch({type:'insert',componentType:type,destinationIndex:nodes.filter(node=>node.zone===insertionZone).length,destinationZone:insertionZone});if(compact)setMobilePanel(null);}
  function insertNode(node:ComponentData,zone=insertionZone){if(selectedItem?.props.locked)return;const index=nodes.filter(item=>item.zone===zone).length;dispatch({type:'setData',recordHistory:true,data:appendEditorNodeToZone(appState.data,node,zone)});dispatch({type:'setUi',ui:{itemSelector:{index,zone}}});if(compact)setMobilePanel(null);}
  function insertLayout(kind:'two'|'three'|'sidebar'){insertNode(createLayoutPreset(kind));}
  function moveInto(targetId: string) {
    if (!selected || selectedItem?.props.locked) return;
    const destinationZone = targetId === 'root' ? 'root:default-zone' : `${targetId}:content`;
    if (destinationZone === selected.zone) return;
    const destinationIndex = nodes.filter((node) => node.zone === destinationZone).length;
    dispatch({ type: 'move', sourceIndex: selected.index, sourceZone: selected.zone, destinationIndex, destinationZone });
    dispatch({ type: 'setUi', ui: { itemSelector: { index: destinationIndex, zone: destinationZone } } });
  }
  function pasteStyle() {
    if (!styleClipboard || selectedItem?.props.locked) return;
    const design = structuredClone(styleClipboard);
    if (selected && selectedItem) dispatch({ type: 'replace', destinationIndex: selected.index, destinationZone: selected.zone, data: { ...selectedItem, props: { ...selectedItem.props, design } } });
    else { const props = { ...appState.data.root.props, title: appState.data.root.props?.title, design }; dispatch({ type: 'replaceRoot', root: { ...appState.data.root, props } }); }
  }
  function move(direction: -1 | 1) {
    if (!selected || selectedItem?.props.locked) return;
    const destinationIndex = Math.max(0, selected.index + direction);
    dispatch({ type: 'reorder', sourceIndex: selected.index, destinationIndex, destinationZone: selected.zone });
    // Puck 重排只更新内容索引；同步选择新位置，避免属性面板跳到相邻组件。
    dispatch({ type: 'setUi', ui: { itemSelector: { index: destinationIndex, zone: selected.zone } } });
  }
  function copyNode() { if (!selectedItem || selectedItem.props.locked) return; editorNodeClipboard = structuredClone(selectedItem); setHasNodeClipboard(true); }
  function pasteNode() {
    if (!editorNodeClipboard || selectedItem?.props.locked) return;
    insertNode(cloneEditorNode(editorNodeClipboard));
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      // AI弹窗内的快捷键不保存背后的旧画布，避免在事务期间重新提交旧数据。
      if (aiModalOpen) { if (key === 's') event.preventDefault(); return; }
      if (key !== 's' && target?.closest('input,textarea,select,[contenteditable=true],[role=combobox],[role=textbox]')) return;
      if (!['c', 'v', 's'].includes(key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (key === 'c') copyNode();
      if (key === 'v') pasteNode();
      if (key === 's') void onSave(appState.data, true).catch(() => {});
    };
    // 画布在同源iframe中，键盘事件不会冒泡到宿主，必须同时注册两边。
    const frame = document.querySelector<HTMLIFrameElement>('#preview-frame');
    window.addEventListener('keydown', keydown, true); frame?.contentWindow?.addEventListener('keydown', keydown, true);
    return () => { window.removeEventListener('keydown', keydown, true); frame?.contentWindow?.removeEventListener('keydown', keydown, true); };
  }, [appState.data, selectedItem, aiModalOpen]);
  function setDevice(next: string) { setCurrentWidth(next === 'mobile' ? 390 : next === 'tablet' ? 768 : 1280); }
  async function saveBeforeLeavingCanvas() {
    const next = appState.data;
    await onSave(next);
    if (!canSaveCanvas()) return;
    const entries = histories.map(entry => entry.state.data as Data);
    const recorded = entries[index];
    if (!recorded) return;
    if (matchesCanvasData(recorded, next)) {
      if (entries.length > 1) rememberEditorCanvasHistory(runtime.actor.id, documentKey, entries, index);
    } else {
      // 立即切页可能早于Puck记录撤销点，已保存画布作为新的末步，清空前那一步仍可找回。
      rememberEditorCanvasHistory(runtime.actor.id, documentKey, [...entries.slice(0, index + 1), next], index + 1);
    }
  }
  async function switchPage(id: string) { try { await saveBeforeLeavingCanvas(); onTargetChange(id); } catch { /* 保存错误由工作区统一提示。 */ } }
  async function saveThenGo(target: Parameters<typeof navigate>[0]) {
    try {
      await saveBeforeLeavingCanvas();
      if (target === 'preview') onPreview(currentWidth);
      else navigate(target);
    } catch { /* 不离开尚未保存的画布。 */ }
  }
  // 小屏优先显示画布，组件和属性使用抽屉；真实预览宽度同步到手机。
  useEffect(() => { if (compact && preferredPreviewWidth === undefined) setCurrentWidth(390); }, [compact, preferredPreviewWidth]);
  useEffect(() => {
    if (!checkFocus || handledCheckFocus.current === checkFocus) return;
    const { target, viewportWidth } = checkFocus;
    const current = editingBlockId ? `block:${editingBlockId}` : editingTemplateId ? `template:${editingTemplateId}` : `page:${state.activePageId}`;
    if (current !== `${target.kind}:${target.id}`) return;
    const selector = getSelectorForId(target.nodeId);
    if (!selector) return;
    // 使用当前画布的稳定节点 ID 选中元素及手机宽度，定位本身不加入撤销历史或修改数据。
    handledCheckFocus.current = checkFocus;
    dispatch({ type: 'setUi', ui: { itemSelector: selector, previewMode: 'edit' } });
    setCurrentWidth(viewportWidth); setRightTab('fields');
    if (compact) setMobilePanel('properties');
    const frame = canvasRef.current?.querySelector('iframe');
    const scroll = () => Array.from(frame?.contentDocument?.querySelectorAll('[data-site-node-id]') || [])
      .find(element => element.getAttribute('data-site-node-id') === target.nodeId)
      ?.scrollIntoView({ block: 'center', inline: 'nearest' });
    const frameRequest = window.requestAnimationFrame(scroll);
    frame?.addEventListener('load', scroll, { once: true });
    return () => { window.cancelAnimationFrame(frameRequest); frame?.removeEventListener('load', scroll); };
  }, [appState.data, checkFocus, compact, dispatch, editingBlockId, editingTemplateId, getSelectorForId, state.activePageId]);

  const leftPanel = <><Tabs activeKey={leftTab} onChange={setLeftTab} items={[{ key: 'elements', label: <><AppstoreOutlined /> 元素</> }, { key: 'outline', label: <><BarsOutlined /> 图层</> }]} />
        {leftTab === 'elements' ? <><div className="editor-panel-intro"><h3>添加控件</h3><p>自由搭建，或从现成区块开始。</p><Button block icon={<PlusOutlined/>} onClick={()=>setBlockLibraryOpen(true)}>插入现成区块</Button><div style={{height:12}}/><Input.Search placeholder="查找元素…" aria-label="查找元素" value={search} onChange={(e) => setSearch(e.target.value)} allowClear /></div>{search ? <div className="editor-search-results">{Object.entries(componentLabels).filter(([, label]) => label.includes(search)).map(([key, label]) => <Button key={key} icon={<PlusOutlined />} onClick={() => insert(key)} block>{label}</Button>)}</div> : <div className="editor-components"><Puck.Components /></div>}<div className="editor-insert-box">{/* 长组件列表限制高度，避免首项随弹层翻转后落到屏幕外。 */}<Dropdown menu={{ style:{maxHeight:'min(50vh,480px)',overflowY:'auto'},items: Object.entries(componentLabels).map(([key, label]) => ({ key, label })), onClick: ({ key }) => insert(key) }} trigger={['click']}><Button icon={<PlusOutlined />} block>添加元素</Button></Dropdown><p>{insertionZone==='root:default-zone'?'添加到页面；选中容器或面板内元素可嵌套添加。':'将添加到当前选中的内容区域。'}</p><Dropdown trigger={['click']} menu={{ items: [{ key: 'two', label: '两列等宽' }, { key: 'sidebar', label: '侧栏 + 主内容' }, { key: 'three', label: '三列网格' }], onClick: ({ key }) => insertLayout(key as 'two' | 'three' | 'sidebar') }}><Button block>快速布局</Button></Dropdown></div><div className="editor-pattern-card"><Button size="small" block onClick={() => { void saveThenGo('global-design'); }}>管理全站设计</Button><span>设计资源</span><h4>复用页面模板</h4><p>从现有结构创建独立草稿。</p><Button size="small" onClick={() => { void saveThenGo('templates'); }}>浏览模板 →</Button></div></> : <div className="editor-outline"><Input.Search aria-label="搜索图层" placeholder="搜索图层名称或内容" value={layerSearch} onChange={e => setLayerSearch(e.target.value)} allowClear />{outline}<div className="editor-outline-help">选择节点后，可在右侧调整位置、复制或删除。</div></div>}
        <div className="editor-left-bottom"><GlobalOutlined /><span>{state.settings.name || '当前站点'}</span><Tag color="blue" variant="filled">草稿工作区</Tag></div>
      </>;
  const rightPanel = <><div className="editor-selection-title"><span className="editor-selection-icon"><SettingOutlined /></span><div><strong>{selectedItem ? selectedItem.props.nodeLabel || componentLabels[selectedItem.type] || selectedItem.type : '页面设置'}</strong><small>{selectedItem ? '元素属性' : targetTitle}</small></div></div>
        {selectedItem?.type === 'Text' && <Button className="editor-convert-text" size="small" disabled={selectedItem.props.locked || Boolean(selectedItem.props.bindings && Object.keys(selectedItem.props.bindings).length)} onClick={() => { if (!selected) return; const props = { ...selectedItem.props, doc: textToRichText(String(selectedItem.props.text || '')) }; delete props.text; delete props.bindings; dispatch({ type: 'replace', destinationIndex: selected.index, destinationZone: selected.zone, data: { type: 'RichText', props } }); }}>转换为富文本（独立内容）</Button>}
        {selectedItem?.type === 'ContentLoop'  && <div className="editor-loop-card-actions"><Alert type="info" showIcon title="先设计一张卡片，再按内容循环" description="卡片内可自由拖拽组件并调整三端样式，绑定“当前记录”后逐项展示。修改已有卡片会同步到所有引用它的列表。" /><Space wrap><Button type="primary" size="small" loading={cardBusy} disabled={!selectedItem.props.itemBlockId} onClick={() => { void openLoopCard(false); }}>编辑卡片设计</Button><Button size="small" loading={cardBusy} onClick={() => { void openLoopCard(true); }}>{selectedItem.props.itemBlockId ? '新建独立卡片' : '新建卡片设计'}</Button></Space></div>}
        {selectedItem && <div className="editor-selection-actions"><Tooltip title="上移"><Button size="small" icon={<ArrowUpOutlined />} aria-label="上移元素" disabled={selectedItem.props.locked || !selected || selected.index === 0} onClick={() => move(-1)} /></Tooltip><Tooltip title="下移"><Button size="small" icon={<ArrowDownOutlined />} aria-label="下移元素" disabled={selectedItem.props.locked || !selected || !getItemBySelector({ index: selected.index + 1, zone: selected.zone })} onClick={() => move(1)} /></Tooltip><Tooltip title="复制"><Button size="small" icon={<CopyOutlined />} aria-label="复制元素" disabled={selectedItem.props.locked} onClick={() => selected && dispatch({ type: 'duplicate', sourceIndex: selected.index, sourceZone: selected.zone })} /></Tooltip><Tooltip title="删除"><Button size="small" danger icon={<DeleteOutlined />} aria-label="删除元素" disabled={selectedItem.props.locked} onClick={() => selected && dispatch({ type: 'remove', index: selected.index, zone: selected.zone })} /></Tooltip></div>}
        <MoreSettings title="复制、移动与复用（选填）">
        {selectedItem && <div className="editor-node-navigation"><Button size="small" onClick={() => dispatch({ type: 'setUi', ui: { itemSelector: selectedNode?.parentId ? getSelectorForId(selectedNode.parentId) : null } })}>选择父级</Button><Dropdown trigger={['click']} menu={{ items: [{ key: 'root', label: '页面根层', disabled: selected?.zone === 'root:default-zone' }, ...moveTargets(appState.data, selectedItem.props.id).map((node) => ({ key: node.id, label: `${'· '.repeat(node.ancestors.length)}${componentLabels[node.type]} · ${node.id.slice(-8)}`, disabled: selected?.zone === `${node.id}:content` }))], onClick: ({ key }) => moveInto(key) }}><Button size="small" disabled={selectedItem.props.locked}>移动到…</Button></Dropdown></div>}
        <div className="editor-style-transfer"><Button size="small" disabled={!selectedItem || selectedItem.props.locked} onClick={copyNode}>复制到剪贴板</Button><Button size="small" disabled={!hasNodeClipboard || selectedItem?.props.locked} onClick={pasteNode}>粘贴元素</Button><Button size="small" onClick={() => setStyleClipboard(structuredClone((selectedItem ? selectedItem.props.design || {} : appState.data.root.props?.design || {}) as ResponsiveDesign))}>复制样式</Button><Button size="small" disabled={!styleClipboard || selectedItem?.props.locked} onClick={pasteStyle}>粘贴样式</Button><Tooltip title="复制三个设备的自定义样式；粘贴可撤销，不改文字和图片内容。"><span>三端样式</span></Tooltip></div>
        </MoreSettings>
        <Tabs activeKey={rightTab} onChange={setRightTab} items={[{ key: 'fields', label: '属性' }, { key: 'advanced', label: '页面操作' }]} />
        <div className="editor-fields">{rightTab === 'fields' ? <Puck.Fields /> : <div className="editor-advanced"><Alert title="编辑器能力说明" description="样式按桌面 → 平板 → 手机继承。只覆盖需要变化的属性，清除单项或当前设备覆盖可恢复继承。隐藏元素仍可从图层选择。" type="info" /><div className="editor-advanced-actions"><Button onClick={() => dispatch({ type: 'setUi', ui: { itemSelector: null } })}>编辑页面设置</Button><Button danger onClick={() => modal.confirm({ title: '清空当前页面？', content: '只清空当前页面内容，可通过撤销恢复。不会删除其他页面。', okText: '清空页面', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => dispatch({ type: 'setData', recordHistory: true, data: { ...appState.data, content: [] } }) })}>清空当前页面</Button></div></div>}</div><div className="editor-properties-note">修改会自动保存为草稿，发布后才会更新网站。自定义代码的效果请点击预览查看。</div>
      </>;

  return <EditorDeviceContext.Provider value={{ device, setDevice }}><div className="editor-workspace">
    {modalContext}
    <BusinessBlockLibrary state={state} open={blockLibraryOpen} onClose={()=>setBlockLibraryOpen(false)} onInsert={node=>insertNode(node,selected?.zone||'root:default-zone')}/>
    <header className="editor-topbar">
      <div className="editor-topbar-left"><Tooltip title={cardOrigin ? '返回来源页面' : editingTemplateId ? '返回模板资源' : journey?.session.active && !editingBlockId ? '返回建站流程' : '返回页面管理'}><Button type="text" icon={<ArrowLeftOutlined />} aria-label={cardOrigin ? '返回来源页面' : editingTemplateId ? '返回模板资源' : journey?.session.active && !editingBlockId ? '返回建站流程' : '返回页面管理'} disabled={cardBusy} onClick={() => { if (cardOrigin) void returnFromCard(); else void saveThenGo(editingTemplateId ? 'templates' : editingBlockId ? 'global-design' : journey?.session.active ? 'site-journey' : 'pages'); }} /></Tooltip><span className="editor-topbar-divider" /><span className="editor-brand-mark"><ProductLogo compact /></span><Select aria-label="当前编辑页面" className="editor-page-picker" value={editingBlockId ? `block:${editingBlockId}` : editingTemplateId ? `template:${editingTemplateId}` : `page:${state.activePageId}`} onChange={switchPage} options={[{ label: '网站页面', options: state.pages.map((p) => ({ value: `page:${p.id}`, label: p.title })) }, { label: '详情模板', options: (state.pageTemplates || []).filter(item => item.kind !== 'page').map(item => ({ value: `template:${item.id}`, label: item.name })) }, { label: '全站同步区块', options: (state.sharedBlocks || []).map((block) => ({ value: `block:${block.id}`, label: block.name })) }]} /><Tag color={editingBlockId ? "blue" : undefined} variant="filled">{cardOrigin ? '循环卡片' : editingTemplateId ? '详情模板草稿' : editingBlockId ? "同步区块" : "草稿"}</Tag></div>
      <div className="editor-device-switch"><Segmented value={device} onChange={setDevice} options={[{ value: 'desktop', icon: <DesktopOutlined />, label: <span className="editor-device-label">桌面</span> }, { value: 'tablet', icon: <TabletOutlined />, label: <span className="editor-device-label">平板</span> }, { value: 'mobile', icon: <MobileOutlined />, label: <span className="editor-device-label">手机</span> }]} /></div>
      <div className="editor-topbar-actions"><Space size={2}><Tooltip title="撤销"><Button type="text" icon={<UndoOutlined />} aria-label="撤销" disabled={!history.hasPast} onClick={history.back} /></Tooltip><Tooltip title="重做"><Button type="text" icon={<RedoOutlined />} aria-label="重做" disabled={!history.hasFuture} onClick={history.forward} /></Tooltip></Space><span className="editor-topbar-divider" />{runtime.actor.role === 'admin' && <Tooltip title={editingBlockId ? '请返回页面后选择要调整的区块；同步区块内部仍用原编辑器维护' : '用自然语言调整当前页面或选中区块'}><Button aria-label={editingTemplateId ? 'AI调整详情模板' : 'AI调整页面或区块'} icon={<ThunderboltOutlined />} disabled={!!editingBlockId} onClick={() => onOpenAi(appState.data, selectedItem?.props.id)}>AI设计</Button></Tooltip>}<Button aria-label="保存草稿" icon={<SaveOutlined />} onClick={() => { void onSave(appState.data, true).catch(() => {}); }}>保存</Button><Button aria-label="预览页面" icon={<EyeOutlined />} onClick={() => { void saveThenGo('preview'); }}>预览</Button><Button type="primary" aria-label={journey?.session.active ? '保存并进入搜索检查' : '发布管理'} onClick={() => { void saveThenGo(journey?.session.active ? 'seo' : 'releases'); }}>{journey?.session.active ? compact ? '搜索检查' : '下一步：搜索检查' : '发布管理'}</Button></div>
    </header>
    {compact && <div className="editor-mobile-tools"><Button size="small" icon={<AppstoreOutlined />} onClick={() => { setLeftTab('elements'); setMobilePanel('elements'); }}>元素</Button><Button size="small" icon={<BarsOutlined />} onClick={() => { setLeftTab('outline'); setMobilePanel('elements'); }}>图层</Button><Button size="small" icon={<SettingOutlined />} onClick={() => setMobilePanel('properties')}>属性</Button><Tooltip title="撤销"><Button size="small" aria-label="撤销操作" icon={<UndoOutlined />} disabled={!history.hasPast} onClick={history.back} /></Tooltip><Tooltip title="重做"><Button size="small" aria-label="重做操作" icon={<RedoOutlined />} disabled={!history.hasFuture} onClick={history.forward} /></Tooltip></div>}
    <Drawer className="editor-mobile-drawer" title={mobilePanel === 'elements' ? '元素与图层' : '页面与元素属性'} placement={mobilePanel === 'elements' ? 'left' : 'right'} size={300} open={compact && mobilePanel !== null} onClose={() => setMobilePanel(null)} styles={{ body: { padding: 0 } }}><div className={mobilePanel === 'elements' ? 'editor-left-panel' : 'editor-right-panel'}>{mobilePanel === 'elements' ? leftPanel : rightPanel}</div></Drawer>
    <div className="editor-main">
      {!compact && <aside className="editor-left-panel">{leftPanel}</aside>}
      <section className="editor-canvas-area"><div className="editor-canvas-meta"><span><GlobalOutlined /> {editingTemplate ? `详情模板 · ${editingTemplate.name}（布局草稿，适用范围单独设置）` : editingBlock ? `同步区块 · ${editingBlock.name}` : `${state.settings.domain || '当前站点'}${currentPage?.slug === '/' ? '' : `/${currentPage?.slug?.replace(/^\//, '') || ''}`}`}</span><span className="editor-width-control"><InputNumber aria-label="画布宽度" size="small" min={EDITOR_MIN_WIDTH} max={EDITOR_MAX_WIDTH} precision={0} step={10} value={currentWidth} onChange={(width) => width !== null && setCurrentWidth(Math.max(EDITOR_MIN_WIDTH, Math.min(EDITOR_MAX_WIDTH, Math.round(width))))} />{viewportLabel} <span className="editor-meta-dot">·</span> {appState.ui.previewMode === 'edit' ? '点击选择 · 拖动设计' : '交互预览'}</span></div><div className="editor-canvas"><div className="editor-canvas-measure" ref={canvasRef}><div className="editor-scaled-frame" style={{ width: currentWidth, height: canvasSize.height / zoom, transform: `scale(${zoom})`, left: Math.max(0, (canvasSize.width - currentWidth * zoom) / 2) }}><Puck.Preview /></div></div>{appState.data.content.length === 0 && <div className="editor-empty-canvas"><div className="editor-empty-icon"><PlusOutlined /></div><h3>留白，是一个好开始。</h3><p>拖入元素，或先添加一个容器。</p><Button type="primary" icon={<PlusOutlined />} onClick={() => insert('Container')}>添加容器</Button></div>}</div><footer className="editor-statusbar"><span><CheckCircleFilled /> {runtime.saveState === 'saved' ? '草稿已保存' : runtime.saveState === 'error' ? '保存失败 · 请保留当前画布' : '正在保存草稿…'}</span><Space size={14} wrap><LayoutDiagnostics device={device}/><Button type="text" size="small" onClick={() => dispatch({ type: 'setUi', ui: { previewMode: appState.ui.previewMode === 'edit' ? 'interactive' : 'edit' } })}>{appState.ui.previewMode === 'edit' ? '切换交互模式' : '返回编辑模式'}</Button>{runtime.actor.role === 'admin' ? <Button type="text" size="small" onClick={() => void onOpenCheck(appState.data)}>整站检查</Button> : <span>设备预览 · {device === 'desktop' ? '桌面' : device === 'tablet' ? '平板' : '手机'}</span>}</Space></footer></section>
      {!compact && <aside className="editor-right-panel">{rightPanel}</aside>}
    </div>
  </div></EditorDeviceContext.Provider>;
}

export function EditorScreen({ state: studioState, update, navigate, journey, target, onTargetChange, canSaveCanvas, preferredPreviewWidth, onPreview }: ScreenProps & { target: EditorTarget; onTargetChange: (target: EditorTarget) => void; canSaveCanvas: () => boolean; preferredPreviewWidth?: number; onPreview: (origin: EditorPreviewOrigin) => void }) {
  // 画布的页面标识来自当前历史条目，当前服务器数据只提供该对象的最新内容。
  const state = target.kind === 'page' && studioState.activePageId !== target.id ? { ...studioState, activePageId: target.id } : studioState;
  const editingBlockId = target.kind === 'block' ? target.id : undefined;
  const editingTemplateId = target.kind === 'template' ? target.id : undefined;
  const cardOrigin = target.cardOrigin;
  const documentKey = `${target.kind}:${target.id}`;
  const activeDocument = useRef(documentKey); activeDocument.current = documentKey;
  const runtime = useStudioRuntime();
  const stateRef = useRef(state); stateRef.current = state;
  const [detailAiOpen, setDetailAiOpen] = useState(false), [detailAiTarget, setDetailAiTarget] = useState<string>();
  const [aiOpen, setAiOpen] = useState(false), [canvasEpoch, setCanvasEpoch] = useState(0);
  const activeCanvasEpoch = useRef(0);
  const [draftCheckOpen, setDraftCheckOpen] = useState(false), [checkFocus, setCheckFocus] = useState<CheckFocus>();
  const [aiSession, setAiSession] = useState<{ pageId: string; pageTitle: string; data: Data; selectedId?: string }>();
  const aiCanvasRef = useRef<Data | undefined>(undefined), pauseCanvasSave = useRef(false);
  // 服务端AI事务完成后重挂Puck，期间阻止旧画布onChange把AI结果覆盖回去。
  useEffect(() => { pauseCanvasSave.current = false; }, [canvasEpoch]);
  useEffect(() => {
    const resumeAi = (event: Event) => {
      const scope = (event as CustomEvent<{ scope?: string }>).detail?.scope;
      if (!scope?.startsWith('ai-page-edit:')) return;
      const pageId = scope.slice('ai-page-edit:'.length), current = stateRef.current, target = current.pages.find(item => item.id === pageId);
      if (!target || !readLocalRecovery(runtime.actor.id, scope, value => !!value && typeof value === 'object' && (value as { pageId?: unknown }).pageId === pageId)) return;
      // 恢复只打开输入工作区；不自动调用AI、保存页面或套用旧模型结果。
      const next = (current.editorData[pageId] as Data | undefined) || getPageData(target);
      onTargetChange({ kind: 'page', id: pageId }); aiCanvasRef.current = next; setAiSession({ pageId, pageTitle: target.title, data: next }); setAiOpen(true);
    };
    window.addEventListener('form-studio:recover-local', resumeAi); return () => window.removeEventListener('form-studio:recover-local', resumeAi);
  }, [runtime.actor.id, onTargetChange]);
  function openAi(next: Data, selectedId?: string) {
    const current = stateRef.current, currentPage = current.pages.find(item => item.id === current.activePageId);
    if (editingTemplateId) { aiCanvasRef.current = next; setDetailAiTarget(selectedId); void save(next).then(() => setDetailAiOpen(true)).catch(() => {}); return; }
    if (!currentPage || editingBlockId) return;
    aiCanvasRef.current = next; setAiSession({ pageId: currentPage.id, pageTitle: currentPage.title, data: next, selectedId }); setAiOpen(true);
  }
  function reloadAiCanvas() {
    const current = runtime.getEnvelope().state; stateRef.current = current;
    if (editingTemplateId) aiCanvasRef.current = current.pageTemplates?.find(item => item.id === editingTemplateId)?.data;
    else {
      const pageId = aiSession?.pageId || current.activePageId, next = current.editorData[pageId] as Data | undefined;
      if (next) { aiCanvasRef.current = next; setAiSession(value => value ? { ...value, data: next } : value); }
    }
    forgetEditorCanvasHistory(runtime.actor.id, documentKey);
    // 旧事件在渲染前即失效，即使同一页面ID的Puck还在卸载。
    activeCanvasEpoch.current += 1;
    setCanvasEpoch(activeCanvasEpoch.current);
  }
  const [messageApi, contextHolder] = message.useMessage();
  const page = state.pages.find((p) => p.id === state.activePageId);
  const template = state.pageTemplates?.find(item => item.id === editingTemplateId);
  const block = state.sharedBlocks?.find((item) => item.id === editingBlockId);
  // 模板上下文只供画布渲染，保存始终定位真实模板，不写任何临时普通页面。
  const data = template ? withEditorRootDefaults(template.data) : block?.data || (state.editorData[state.activePageId] as Data | undefined) || getPageData(page);
  const initialHistory = useMemo(() => readEditorCanvasHistory(runtime.actor.id, documentKey, data), [runtime.actor.id, documentKey, data, canvasEpoch]);
  const canvasState = template ? templateEditorState(state, template) : state;
  const config = useMemo(() => createEditorConfig(canvasState, undefined, undefined, { editingBlockId, editingTemplateId }), [state.products, state.forms, state.media, state.theme, state.settings, state.sharedBlocks, state.siteLayout, state.contentModels, state.contentEntries, state.activePageId, state.editorData[state.activePageId], state.editorData.__themeControls, editingBlockId, editingTemplateId, template]);
  async function save(next: Data, announce = false) {
    // 显式重载先锁住旧画布，防止自动保存、快捷键或迟到的事件使用服务器新版本号提交旧内容。
    if (!canSaveCanvas() || pauseCanvasSave.current || canvasEpoch !== activeCanvasEpoch.current) throw new Error('画布正在重新加载，请在加载完成后再保存。');
    if (activeDocument.current !== documentKey) return;
    const current = stateRef.current;
    const pageId = state.activePageId;
    const currentBlock = current.sharedBlocks?.find((item) => item.id === editingBlockId);
    const currentTemplate = current.pageTemplates?.find(item => item.id === editingTemplateId);
    if (editingTemplateId && !currentTemplate) throw new Error('当前模板已不存在，请重新选择模板。');
    // 其他窗口删除并刷新区块后，禁止把旧画布误存到当前页面。
    if (editingBlockId && !currentBlock) throw new Error('当前区块已不存在，请切换页面或重新选择区块。');
    if (target.kind === 'page' && !current.pages.some(item => item.id === pageId)) throw new Error('当前页面已不存在，请从页面列表重新打开。');
    const previous = (currentTemplate ? withEditorRootDefaults(currentTemplate.data) : undefined) || currentBlock?.data || (current.editorData[pageId] || getPageData(page)) as Data;
    // Puck 初始化会补空 zones；区块内容单独保存，引用页面不会被批量改写。
    if (!matchesCanvasData(previous, next)) {
      const patch = currentTemplate
        ? { pageTemplates: current.pageTemplates!.map(item => item.id === currentTemplate.id ? { ...item, data: next, updated: new Date().toISOString() } : item) }
        : currentBlock
        ? { sharedBlocks: current.sharedBlocks!.map((item) => item.id === currentBlock.id ? { ...item, data: next } : item) }
        : { editorData: { ...current.editorData, [pageId]: next }, pages: current.pages.map((item) => item.id === pageId ? { ...item, status: 'draft' as const, updated: '刚刚' } : item) };
      stateRef.current = { ...current, ...patch };
      await update(patch);
    }
    await runtime.flush();
    if (announce) messageApi.success(currentTemplate ? '详情模板布局草稿已保存，适用内容规则保持原设置。' : currentBlock ? '同步区块草稿已保存，发布后更新所有引用处。' : '草稿已保存；公开发布请进入发布管理。');
  }
  function changeTarget(value: string) {
    setCheckFocus(undefined);
    const [kind, id] = value.split(':');
    const next = readEditorTarget({ kind, id });
    if (next) onTargetChange(next);
  }
  async function openDraftCheck(canvas: Data) {
    try {
      // 等待当前画布进入服务端草稿，再检查该修订；保存失败时不显示旧数据的检查结果。
      await save(canvas);
      setDraftCheckOpen(true);
    } catch (error) { messageApi.error(error instanceof Error ? error.message : '请先保存当前草稿，再检查整站'); }
  }
  function openCheckedPage(_path: string, previewPath?: string, nodeId?: string) {
    if (!previewPath) return;
    const prefix = `/preview/~draft-check/${runtime.envelope.revision}`;
    const href = safePreviewNavigation(nodeId ? `${previewPath}#locate=${encodeURIComponent(nodeId)}` : previewPath, location.origin, prefix);
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
  }
  async function locateDraftIssue(issue: AiBuildCheckLocation) {
    const target = issue.target;
    if (!target) { openCheckedPage(issue.path, issue.previewPath, issue.nodeId); return; }
    const current = runtime.getEnvelope().state;
    const page = target.kind === 'page' ? current.pages.find(item => item.id === target.id) : undefined;
    const currentData = target.kind === 'template' ? current.pageTemplates?.find(item => item.id === target.id)?.data
      : target.kind === 'block' ? current.sharedBlocks?.find(item => item.id === target.id)?.data
      : page ? current.editorData[page.id] as Data | undefined || getPageData(page) : undefined;
    if (!currentData || !editorNodes(currentData).some(node => node.id === target.nodeId)) {
      messageApi.warning('该区块已变化，请重新检查后定位。'); return;
    }
    try {
      changeTarget(`${target.kind}:${target.id}`);
      setCheckFocus({ ...issue, target }); setDraftCheckOpen(false);
    } catch (error) { messageApi.error(error instanceof Error ? error.message : '未能切换到对应区块'); }
  }
  async function openCard(input: LoopCardRequest) {
    const target = editingBlockId ? `block:${editingBlockId}` : editingTemplateId ? `template:${editingTemplateId}` : `page:${stateRef.current.activePageId}`;
    let blockId = input.blockId;
    if (input.create) {
      blockId = `block-${crypto.randomUUID()}`;
      const id = blockId;
      // 卡片资产与来源列表引用一次保存，避免留下缺失引用或覆盖并发更新。
      await runtime.mutate(env => {
        const current = env.state, model = current.contentModels?.find(item => item.id === input.modelId);
        // 请求发出前的校验失败是确定性错误，不应被队列当成网络结果未确认。
        if (input.source === 'entry' && (!model || model.target !== 'content')) throw new RequestError(422, '请先选择有效的独立内容模型');
        const sample = input.source === 'product' ? current.products.find(item => !input.modelId || item.modelId === input.modelId) : current.contentEntries?.find(item => item.modelId === input.modelId);
        const name = `${(model?.name || '产品').slice(0, 108)} · 循环卡片`;
        const block = { id, name, updated: new Date().toISOString(), data: createContentDesignData({ name, source: input.source, model, recordId: sample?.id, kind: 'card', hasDetailRoute: input.source === 'product' ? current.pages.some(page => page.slug === '/products/:slug') : current.pages.some(page => page.contentModelId === input.modelId) }) };
        const sourceBlock = target.startsWith('block:') ? current.sharedBlocks?.find(item => item.id === target.slice(6)) : undefined;
        const sourceTemplate = target.startsWith('template:') ? current.pageTemplates?.find(item => item.id === target.slice(9)) : undefined;
        const sourcePage = target.startsWith('page:') ? current.pages.find(page => page.id === target.slice(5)) : undefined;
        const data = sourceTemplate?.data || sourceBlock?.data || (sourcePage ? current.editorData[sourcePage.id] as Data : undefined);
        if (!data) throw new RequestError(422, '来源页面或区块已不存在，请重新打开编辑器');
        let matched = false;
        const replace = (value: unknown): unknown => { if (Array.isArray(value)) return value.map(replace); if (!value || typeof value !== 'object') return value; const node = value as Record<string, unknown>, props = node.props as Record<string, unknown> | undefined; if (node.type === 'ContentLoop' && props?.id === input.nodeId) { matched = true; return { ...node, props: { ...props, itemBlockId: id } }; } return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, replace(child)])); };
        const nextData = replace(data) as Data;
        if (!matched) throw new RequestError(422, '来源循环列表已不存在，请重新选择');
        const sharedBlocks = [...(current.sharedBlocks || []).map(item => sourceBlock?.id === item.id ? { ...item, data: nextData } : item), block];
        return request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { sharedBlocks, ...(sourceTemplate ? { pageTemplates: current.pageTemplates!.map(item => item.id === sourceTemplate.id ? { ...item, data: nextData, updated: new Date().toISOString() } : item) } : {}), ...(sourcePage ? { editorData: { ...current.editorData, [sourcePage.id]: nextData } } : {}) } }) });
      });
      stateRef.current = { ...stateRef.current, ...runtime.getEnvelope().state, activePageId: stateRef.current.activePageId };
    }
    if (!blockId || !runtime.getEnvelope().state.sharedBlocks?.some(item => item.id === blockId)) throw new Error('请先选择有效的卡片模板');
    const origin = { target, nodeId: input.nodeId, cardId: blockId };
    onTargetChange({ kind: 'block', id: blockId, cardOrigin: origin });
  }
  async function returnCard() {
    if (!cardOrigin) return;
    const current = runtime.getEnvelope().state;
    const exists = cardOrigin.target.startsWith('block:') ? current.sharedBlocks?.some(item => item.id === cardOrigin.target.slice(6)) : cardOrigin.target.startsWith('template:') ? current.pageTemplates?.some(item => item.id === cardOrigin.target.slice(9)) : current.pages.some(item => item.id === cardOrigin.target.slice(5));
    if (!exists) throw new Error('来源页面已不存在，请从顶部选择其他页面');
    try { sessionStorage.setItem('form-studio:return-loop-node', JSON.stringify(cardOrigin)); } catch { /* 仍可返回来源，仅不恢复选择。 */ }
    changeTarget(cardOrigin.target);
  }
  function navigateFromEditor(target: Parameters<typeof navigate>[0]) {
    if (target === 'templates') focusTemplateLibrary();
    navigate(target);
  }
  function previewFromEditor(width: number) {
    // 已保存再进入真实页面；记原始资产，而不是当前恰好选中的普通页面。
    onPreview({ ...target, width });
  }
  // 先检查原始设计及可达区块，再挂载Puck，避免未知节点被编辑器忽略后自动保存。
  if (target.kind === 'page' ? !page : target.kind === 'block' ? !block : !template) {
    const label = target.kind === 'page' ? '页面' : target.kind === 'block' ? '同步区块' : '模板';
    return <div className="editor-screen" style={{ padding: 24 }}><Alert type="warning" showIcon title={`此${label}已不存在，请返回列表重新选择。`} action={<Button onClick={() => navigateFromEditor(target.kind === 'page' ? 'pages' : target.kind === 'block' ? 'global-design' : 'templates')}>返回列表</Button>} /></div>;
  }
  const compatibility=componentCompatibilityErrors(data),seenBlocks=new Set<string>();
  function checkBlocks(value:unknown){for(const id of getSharedBlockReferences(value)){if(seenBlocks.has(id))continue;seenBlocks.add(id);const b=state.sharedBlocks?.find(b=>b.id===id);if(b){compatibility.push(...componentCompatibilityErrors(b.data).map(e=>`${b.name}：${e}`));checkBlocks(b.data);}}}checkBlocks(data);
  if(compatibility.length||extensionMigrationsNeeded(data))return <div className="editor-screen" style={{padding:24}}>{contextHolder}<Space orientation="vertical"><Button onClick={()=>navigate('pages')}>返回页面管理</Button><Alert type="warning" showIcon title={compatibility.length?'布局原始数据已保留，当前程序不能编辑这些组件':'此布局使用旧组件数据，请明确升级后编辑'} description={compatibility.length?compatibility.join('；'):'升级只写当前页面或区块的草稿，不改历史发布、节点ID或其他客户。'}/>{!compatibility.length&&<Button type="primary" onClick={()=>{void save(migrateExtensionData(data),true);}}>升级当前布局组件到草稿</Button>}<Button onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='original-layout.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>导出原始布局</Button></Space></div>;
  return <div className="editor-screen">{contextHolder}<Puck key={`${documentKey}:${canvasEpoch}`} config={config} data={data} initialHistory={initialHistory} onChange={(next) => { if (!pauseCanvasSave.current) void save(next).catch(() => {}); }} viewports={viewports} iframe={iframeOptions} ui={{ viewports: { current: { width: 1280, height: 'auto' }, controlsVisible: false, options: viewports } }} dictionary={{ 'action-duplicate': '复制', 'action-delete': '删除', 'action-selectparent': '选择父容器', 'action-drag': '拖动调整顺序', 'outline-empty': '暂无元素', 'outline-header-title': '页面结构', 'outline-header-collapseall': '收起全部', 'outline-item-collapse': '收起', 'outline-item-expand': '展开', 'outline-item-duplicate': '复制', 'outline-item-delete': '删除', 'drawer-category-collapse': '收起 {title}', 'drawer-category-expand': '展开 {title}', 'label-page': '页面', 'label-component': '元素', 'drawer-category-other': '其他元素' }}><EditorWorkspace state={state} update={update} navigate={navigateFromEditor} journey={journey} onSave={save} documentKey={documentKey} savedData={data} canSaveCanvas={canSaveCanvas} editingBlockId={editingBlockId} editingTemplateId={editingTemplateId} onTargetChange={changeTarget} onOpenCard={openCard} cardOrigin={cardOrigin?.cardId === editingBlockId ? cardOrigin : undefined} onReturnCard={returnCard} onOpenAi={openAi} aiModalOpen={aiOpen || detailAiOpen} onOpenCheck={openDraftCheck} checkFocus={checkFocus} preferredPreviewWidth={preferredPreviewWidth} onPreview={previewFromEditor} /></Puck>
    <Modal title="草稿整站检查" open={draftCheckOpen} destroyOnHidden width={780} footer={null} onCancel={() => setDraftCheckOpen(false)}><AiBuildSiteCheck draftRevision={runtime.envelope.revision} draftPageId={state.activePageId} disabled={!draftCheckOpen || runtime.saveState !== 'saved'} onLocate={issue => void locateDraftIssue(issue)} onOpenPage={openCheckedPage} /></Modal>
    {template && <AiDetailDesign key={`${template.id}:${detailAiTarget || 'whole'}`} open={detailAiOpen} state={state} templateId={template.id} targetId={detailAiTarget} originScreen="editor" onClose={() => setDetailAiOpen(false)} onSaveCanvas={async () => { if (aiCanvasRef.current) await save(aiCanvasRef.current); }} onPauseCanvas={paused => { pauseCanvasSave.current = paused; }} onReloadCanvas={reloadAiCanvas} navigate={navigate} />}{aiSession && <AiPageEdit key={aiSession.pageId} open={aiOpen} {...aiSession} onClose={() => setAiOpen(false)} onSaveCanvas={async () => { if (aiCanvasRef.current) await save(aiCanvasRef.current); }} onPauseCanvas={paused => { pauseCanvasSave.current = paused; }} onReloadCanvas={reloadAiCanvas} navigate={navigate} />}</div>;
}

export function PreviewScreen({ state, editorPreview, onWidthChange, onReferenceChange, onReturnToEditor }: ScreenProps & { editorPreview?: EditorPreviewOrigin; onWidthChange: (width: number) => void; onReferenceChange: (path: string) => void; onReturnToEditor: (target: EditorTarget | undefined, width: number) => void }) {
  const runtime = useStudioRuntime();
  const templateId = editorPreview?.kind === 'template' ? editorPreview.id : undefined;
  const template = state.pageTemplates?.find(item => item.id === templateId);
  const blockId = editorPreview?.kind === 'block' ? editorPreview.id : undefined;
  const block = state.sharedBlocks?.find(item => item.id === blockId);
  const [defaultWidth, setDefaultWidth] = useState(() => window.matchMedia('(max-width: 767px)').matches ? 390 : 1280);
  const previewWidth = editorPreview?.width ?? defaultWidth;
  const device: Device = previewWidth <= 700 ? 'mobile' : previewWidth <= 1024 ? 'tablet' : 'desktop';
  const previewStageRef = useRef<HTMLDivElement>(null);
  const [previewBounds, setPreviewBounds] = useState({ width: 1280, height: 800 });
  const chosenPath = editorPreview?.referencePath;
  const previewZoom = Math.min(1, previewBounds.width / previewWidth);
  // 预览走认证路由，任意客户代码只在其独立沙箱内执行，不能注入后台 DOM。
  useEffect(() => {
    if (!previewStageRef.current) return;
    const observer = new ResizeObserver(([entry]) => setPreviewBounds({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }));
    observer.observe(previewStageRef.current);
    return () => observer.disconnect();
  }, []);
  const page = state.pages.find((p) => p.id === (editorPreview?.kind === 'page' ? editorPreview.id : state.activePageId));
  const slug = page ? getTemplatePreviewPath(state, page) : editorPreview ? undefined : '/';
  const blockChoices = useMemo(() => blockId && block ? sharedBlockPreviewPages(state, blockId) : [], [state, blockId, block]);
  // 优先保留当前引用页；没有引用时展示区块自身，绝不回退成无关首页。
  const blockPath = blockChoices.some(option => option.value === chosenPath) ? chosenPath : blockChoices.some(option => option.value === slug) ? slug : blockChoices[0]?.value;
  const blockTitle = blockChoices.find(option => option.value === blockPath)?.label;
  const standalone = Boolean(blockId && !blockPath);
  const previewUrl = blockId
    ? !block ? undefined : blockPath ? `/preview${blockPath === '/' ? '' : blockPath}` : `/preview/~block/${encodeURIComponent(blockId)}`
    : templateId ? template && `/preview/~template/${encodeURIComponent(template.id)}` : slug ? `/preview${slug === '/' ? '' : slug}` : undefined;
  function setPreviewDevice(next: Device) {
    const width = next === 'mobile' ? 390 : next === 'tablet' ? 768 : 1280;
    if (editorPreview) onWidthChange(width);
    else setDefaultWidth(width);
  }
  function returnToEditor() { onReturnToEditor(readEditorTarget(editorPreview) || (page ? { kind: 'page', id: page.id } : undefined), previewWidth); }
  return <div className="editor-preview-screen">
    <header className="editor-preview-topbar"><div><Button icon={<ArrowLeftOutlined />} onClick={returnToEditor}>{runtime.actor.role === 'viewer' ? '返回页面列表' : '返回编辑器'}</Button><span className="editor-preview-title">{block?.name || template?.name || page?.title || '页面'} <Tag color="gold">{block ? '同步区块' : template ? '模板布局预览 · 不改变适用范围' : '隔离草稿预览'}</Tag></span></div><Segmented<Device> aria-label="预览设备" value={device} onChange={setPreviewDevice} options={[{ value: 'desktop', icon: <DesktopOutlined />, label: <span className="sr-only">桌面</span> }, { value: 'tablet', icon: <TabletOutlined />, label: <span className="sr-only">平板</span> }, { value: 'mobile', icon: <MobileOutlined />, label: <span className="sr-only">手机</span> }]} /><span className="editor-preview-disclaimer">{previewWidth} px · {template || standalone ? '客户 JS 已隔离' : '应用草稿 CSS / JS'}</span></header>
    {block && <div className="editor-preview-context">{standalone ? <Tag>区块独立预览 · 尚无可用引用页</Tag> : blockChoices.length === 1 ? <Tag color="blue">引用页面：{blockTitle}</Tag> : <><span>引用页面</span><Select aria-label="选择区块预览的引用页面" value={blockPath} options={blockChoices} onChange={onReferenceChange} popupMatchSelectWidth={false} /></>}</div>}
    <div className="editor-preview-stage"><div className="editor-preview-measure" ref={previewStageRef} style={{ height: block ? 'calc(100dvh - 162px)' : 'calc(100dvh - 114px)' }}>{previewUrl ? <iframe title="网站完整草稿预览" className="editor-preview-page" src={previewUrl} style={{ width: previewWidth, height: previewBounds.height / previewZoom, transform: `scale(${previewZoom})`, left: Math.max(0, (previewBounds.width - previewWidth * previewZoom) / 2) }} /> : <Alert type="info" showIcon title="还没有可预览的内容" description="当前页面、区块或详情样本未找到。请返回编辑器核对后再试。" />}</div></div>
  </div>;
}
