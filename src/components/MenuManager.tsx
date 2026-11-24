'use client';

import { useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Modal, Select, Space, Switch, Tree, Typography } from 'antd';
import type { DataNode, TreeProps } from 'antd/es/tree';
import type { MenuItem, ScreenProps, SiteMenu } from '@/lib/types';
import { request, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';
import {siteLocales,localeOf} from '@/lib/localization';
import { moveMenuItem } from '@/lib/site-navigation';

/** 菜单改动在本地编辑，显式保存整个布局；使用mutation确保422不污染工作区。 */
export default function MenuManager({ state }: Pick<ScreenProps, 'state'>) {
  const runtime = useStudioRuntime(), { message, modal } = App.useApp();
  const readonly = runtime.actor.role === 'viewer';
  const [draft, setDraft] = useState<SiteMenu | null>(null), [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [form] = Form.useForm();
  const layout = state.siteLayout || { header: { mode: 'default' as const, blockId: '' }, footer: { mode: 'default' as const, blockId: '' } };
  const menus = layout.menus || [];
  const visit = (items: MenuItem[], id: string): MenuItem | undefined => { for (const item of items) { if (item.id === id) return item; const child = visit(item.children || [], id); if (child) return child; } };
  const targets = [...state.pages.filter(page => !page.slug.includes(':')).map(page => ({ value: `page:${page.id}`, label: `页面 · ${page.title} · ${localeOf(state.settings,page)}` })), ...state.products.map(item => ({ value: `product:${item.id}`, label: `产品 · ${item.name} · ${localeOf(state.settings,item)}` })), ...(state.contentEntries || []).map(item => ({ value: `entry:${item.id}`, label: `内容 · ${item.title} · ${localeOf(state.settings,item)}` }))];
  async function saveMenus(next: SiteMenu[], slots?: Partial<typeof layout>) {
    await runtime.mutate(env => request<StudioEnvelope>('/api/studio', { method: 'PATCH', body: JSON.stringify({ expectedRevision: env.revision, patch: { siteLayout: { ...(env.state.siteLayout || layout), ...slots, menus: next } } }) }));
  }
  function choose(id: string) {
    if (!draft) return; const item = visit(draft.items, id); if (!item) return;
    setSelected(id); form.setFieldsValue({ label: item.label, target: item.target ? `${item.target.kind}:${item.target.id}` : '', href: item.href || '', newTab: item.newTab || false });
  }
  function patchItem() {
    if (!draft || !selected) return;
    const values = form.getFieldsValue(), next = structuredClone(draft), item = visit(next.items, selected);
    if (!item) return; const parts = String(values.target || '').split(':');
    Object.assign(item, { label: values.label || '', target: values.target ? { kind: parts[0], id: parts[1] } : null, href: values.href || '', newTab: !!values.newTab }); setDraft(next);
  }
  function add(parent?: string) {
    if (!draft) return; const next = structuredClone(draft), item: MenuItem = { id: `menuitem-${crypto.randomUUID()}`, label: 'New link', href: '/' };
    if (parent) { const owner = visit(next.items, parent); if (owner) (owner.children ||= []).push(item); } else next.items.push(item);
    setDraft(next); setSelected(item.id); form.setFieldsValue({ label: item.label, target: '', href: '/', newTab: false });
  }
  const tree = (items: MenuItem[]): DataNode[] => items.map(item => ({ key: item.id, title: item.label || '未命名项目', children: tree(item.children || []) }));
  const drop: TreeProps['onDrop'] = info => { if (!draft) return; try { const position = info.dropPosition - Number(info.node.pos.split('-').at(-1)); setDraft({ ...draft, items: moveMenuItem(draft.items, String(info.dragNode.key), String(info.node.key), info.dropToGap ? position < 0 ? 'before' : 'after' : 'inside') }); setError(''); } catch (e) { setError((e as Error).message); } };
  function close() { if (!draft || readonly) { setDraft(null); return; } modal.confirm({ title: '放弃未保存的菜单编辑？', okText: '放弃并关闭', cancelText: '继续编辑', onOk: () => setDraft(null) }); }
  return <Card title="导航菜单" extra={<Button type="primary" disabled={readonly} onClick={() => { setDraft({ id: `menu-${crypto.randomUUID()}`, name: 'New menu', items: [] }); setSelected(undefined); setError(''); }}>新建菜单</Button>}>
    <Typography.Paragraph type="secondary">拖拽项目调整顺序和缩进，最多三级。菜单、页眉页脚在发布时统一选择。</Typography.Paragraph>
    <Space wrap>{menus.map(menu => <Button key={menu.id} onClick={() => { setDraft(structuredClone(menu)); setSelected(undefined); setError(''); }}>{menu.name}</Button>)}</Space>
    <Form layout="vertical" style={{ marginTop: 24 }}>{(['header', 'footer'] as const).map(slot => <Form.Item key={slot} label={slot === 'header' ? '默认页眉菜单' : '默认页脚菜单'}><Select style={{ maxWidth: 420 }} aria-label={`${slot}菜单`} disabled={readonly} value={layout[slot].menuId || ''} options={[{ value: '', label: '使用原默认内容' }, ...menus.map(menu => ({ value: menu.id, label: menu.name }))]} onChange={async menuId => { try { await saveMenus(menus, { [slot]: { ...layout[slot], menuId } }); message.success('已保存菜单配置草稿'); } catch (e) { message.error((e as Error).message); } }} /></Form.Item>)}{(['header','footer'] as const).flatMap(slot=>siteLocales(state.settings).filter(l=>l.code!==state.settings.language).map(l=><Form.Item key={`${slot}-${l.code}`} label={`${l.label} · ${slot==='header'?'页眉':'页脚'}菜单`}><Select aria-label={`${l.code}-${slot}菜单`} disabled={readonly} value={layout[slot].localeMenuIds?.[l.code]||''} style={{maxWidth:420}} options={[{value:'',label:'此语言不显示菜单'},...menus.map(m=>({value:m.id,label:m.name}))]} onChange={async id=>{try{await saveMenus(menus,{[slot]:{...layout[slot],localeMenuIds:Object.fromEntries(Object.entries({...layout[slot].localeMenuIds,[l.code]:id}).filter(([,v])=>v))}});message.success('已保存语言菜单草稿');}catch(e){message.error((e as Error).message);}}}/></Form.Item>))}</Form>
    <Modal title="编辑菜单" open={!!draft} width={880} onCancel={close} footer={draft && <Space><Button danger disabled={readonly || busy || !menus.some(item => item.id === draft.id)} onClick={async () => { try { await saveMenus(menus.filter(item => item.id !== draft.id)); setDraft(null); } catch (e) { setError((e as Error).message); } }}>删除菜单</Button><Button onClick={close}>关闭</Button><Button type="primary" loading={busy} disabled={readonly} onClick={async () => { setBusy(true); try { const current = runtime.getEnvelope().state.siteLayout?.menus || []; await saveMenus([...current.filter(item => item.id !== draft.id), draft]); setDraft(null); message.success('菜单草稿已保存'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>保存菜单</Button></Space>}>
      {draft && <><Form layout="vertical"><Form.Item label="菜单名称"><Input aria-label="菜单名称" maxLength={120} disabled={readonly} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Form.Item></Form>{error && <Alert type="error" title={error} style={{ marginBottom: 16 }} />}<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', gap: 24 }}><div><Space wrap><Button disabled={readonly} onClick={() => add()}>添加项目</Button><Button disabled={readonly || !selected} onClick={() => add(selected)}>添加子项</Button><Button danger disabled={readonly || !selected} onClick={() => { const remove = (items: MenuItem[]): MenuItem[] => items.filter(item => item.id !== selected).map(item => ({ ...item, children: remove(item.children || []) })); setDraft({ ...draft, items: remove(draft.items) }); setSelected(undefined); }}>删除项目</Button></Space><Tree style={{ marginTop: 20 }} blockNode draggable={!readonly} defaultExpandAll treeData={tree(draft.items)} selectedKeys={selected ? [selected] : []} onSelect={keys => choose(String(keys[0]))} onDrop={drop} /></div><div>{selected ? <Form form={form} layout="vertical" disabled={readonly} onValuesChange={patchItem}><Form.Item name="label" label="显示文字"><Input aria-label="菜单项目文字" maxLength={120} /></Form.Item><Form.Item name="target" label="链接到站内内容"><Select aria-label="菜单内部目标" showSearch optionFilterProp="label" options={[{ value: '', label: '手动填写网址' }, ...targets]} /></Form.Item><Form.Item name="href" label="手动填写网址"><Input aria-label="菜单链接地址" placeholder="https://...、mailto:...、tel:...、#anchor" /></Form.Item><Form.Item name="newTab" label="新窗口打开" valuePropName="checked"><Switch /></Form.Item></Form> : <Typography.Text type="secondary">选择左侧项目编辑链接。</Typography.Text>}</div></div></>}
    </Modal>
  </Card>;
}
