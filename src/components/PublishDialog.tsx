'use client';

import {localeOf} from '@/lib/localization';
import PublicationCheckDetails from './PublicationCheckDetails';
import MoreSettings from './MoreSettings';
import { useEffect,useState } from 'react';
import { readLocalRecovery,storeLocalRecovery,clearLocalRecovery } from '@/lib/local-recovery';

import { Alert, App, Button, Checkbox, Divider, Empty, Input, Modal, Space, Steps, Tag, Typography } from 'antd';
import type { RedirectRule } from '@/lib/types';
import type { PublicationDiagnostics,Dependency } from '@/server/publication-diagnostics';
import type { Screen } from '@/lib/types';
import { request, RequestError, useStudioRuntime, type StudioEnvelope } from '@/lib/studio-client';

const scopeArrays=['pageIds','productIds','removePageIds','removeProductIds','sharedBlockIds','removeSharedBlockIds','contentModelIds','contentEntryIds','removeContentModelIds','removeContentEntryIds'] as const;
const scopeFlags=['includeTheme','includeSettings','includeTemplates','includeForms','includeRedirects','includeCatalog','includeLayout','includeCode'] as const;
function readPublishRecovery(actorId:string){return readLocalRecovery<Record<string,unknown>>(actorId,'publish-scope',value=>{const v=value as Record<string,unknown>;return !!v&&typeof v.title==='string'&&v.title.length<=80&&scopeArrays.every(k=>Array.isArray(v[k])&&(v[k] as unknown[]).length<=2000&&(v[k] as unknown[]).every(id=>typeof id==='string'&&id.length<=100))&&scopeFlags.every(k=>typeof v[k]==='boolean');});}
type CheckResult = { expectedRevision:number; baseReleaseId:string|null; requestKey:string; diagnostics:PublicationDiagnostics; preview?: { href: string; expiresAt: string }; summary: { totalPages: number; totalProducts: number; totalSharedBlocks?: number; totalContentModels?: number; totalContentEntries?: number; affectedPages?: { id: string; title: string }[] }; errors: string[]; warnings: string[]; suggestedRedirects?: RedirectRule[] };
/** 确认范围与服务端预检共用同一请求；提交仍会再次检查版本，不能发布过期预检。 */
export default function PublishDialog({ onClose, onPublished, onRepair,entryId }: { onClose: () => void; onPublished: () => void; onRepair?: (screen:Screen,pageId?:string)=>void;entryId?:string }) {
  const runtime = useStudioRuntime();
  const { state, activeReleaseId } = runtime.envelope;
  const { message } = App.useApp();
  const [recovered]=useState(()=>entryId?undefined:readPublishRecovery(runtime.actor.id));
  const [title,setTitle]=useState((recovered?.snapshot.title as string|undefined)??'网站内容更新');
  const [pageIds, setPageIds] = useState((recovered?.snapshot.pageIds as string[]|undefined)??(entryId?[]:state.pages.filter(p=>p.status==='draft').map(p=>p.id)));
  const [productIds,setProductIds]=useState<string[]>((recovered?.snapshot.productIds as string[]|undefined)??[]);
  const [removePageIds,setRemovePageIds]=useState<string[]>((recovered?.snapshot.removePageIds as string[]|undefined)??[]);
  const [removeProductIds,setRemoveProductIds]=useState<string[]>((recovered?.snapshot.removeProductIds as string[]|undefined)??[]);
  // 全站资产会影响未勾选页面，必须由发布者逐项选择，首次发布也不自动带入。
  const [sharedBlockIds,setSharedBlockIds]=useState<string[]>((recovered?.snapshot.sharedBlockIds as string[]|undefined)??[]);
  const [removeSharedBlockIds,setRemoveSharedBlockIds]=useState<string[]>((recovered?.snapshot.removeSharedBlockIds as string[]|undefined)??[]);
  const [contentModelIds,setContentModelIds]=useState<string[]>((recovered?.snapshot.contentModelIds as string[]|undefined)??[]);
  const [contentEntryIds,setContentEntryIds]=useState<string[]>((recovered?.snapshot.contentEntryIds as string[]|undefined)??(entryId?[entryId]:[]));
  const [removeContentModelIds,setRemoveContentModelIds]=useState<string[]>((recovered?.snapshot.removeContentModelIds as string[]|undefined)??[]);
  const [removeContentEntryIds,setRemoveContentEntryIds]=useState<string[]>((recovered?.snapshot.removeContentEntryIds as string[]|undefined)??[]);
  const [includeTemplates,setIncludeTemplates]=useState((recovered?.snapshot.includeTemplates as boolean|undefined)??false);
  const [includeForms,setIncludeForms]=useState((recovered?.snapshot.includeForms as boolean|undefined)??false);
  const [includeRedirects,setIncludeRedirects]=useState((recovered?.snapshot.includeRedirects as boolean|undefined)??false);
  const [includeCatalog,setIncludeCatalog]=useState((recovered?.snapshot.includeCatalog as boolean|undefined)??false);
  const [includeLayout,setIncludeLayout]=useState((recovered?.snapshot.includeLayout as boolean|undefined)??false);
  const [includeCode,setIncludeCode]=useState((recovered?.snapshot.includeCode as boolean|undefined)??false);
  const [includeTheme,setIncludeTheme]=useState((recovered?.snapshot.includeTheme as boolean|undefined)??(!entryId&&!activeReleaseId));
  const [includeSettings,setIncludeSettings]=useState((recovered?.snapshot.includeSettings as boolean|undefined)??(!entryId&&!activeReleaseId));
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false), [error,setError]=useState('');
  const scope={title,pageIds,productIds,removePageIds,removeProductIds,sharedBlockIds,removeSharedBlockIds,contentModelIds,contentEntryIds,removeContentModelIds,removeContentEntryIds,includeTheme,includeSettings,includeTemplates,includeForms,includeRedirects,includeCatalog,includeLayout,includeCode};
  const requestKey=JSON.stringify(scope);
  // 文章内的检查不覆盖用户尚未完成的全站发布选择。
  useEffect(()=>{if(!entryId)storeLocalRecovery(runtime.actor.id,'publish-scope','releases','未完成的发布范围选择',scope);},[runtime.actor.id,requestKey,entryId]);
  const close=()=>{if(!entryId)clearLocalRecovery(runtime.actor.id,'publish-scope');onClose();};
  const checked=!!check&&check.requestKey===requestKey&&check.expectedRevision===runtime.envelope.revision&&check.baseReleaseId===activeReleaseId;
  // 只把当前范围对应的入口交给用户，另一个标签页浏览时仍由服务端复核版本和权限。
  const publicationPreview = checked ? check.preview : undefined;
  const current = state.releases.find(r => r.status === 'current')?.snapshot;
  const oldPages = (current?.pages || []) as { id: string; title: string }[];
  const oldProducts = (current?.products || []) as { id: string; name: string }[];
  const oldBlocks = (current?.sharedBlocks || []) as { id: string; name: string }[];
  const blocks = state.sharedBlocks || [];
  const models = state.contentModels || [], entries = state.contentEntries || [];
  const oldModels = (current?.contentModels || []) as { id: string; name: string }[];
  const oldEntries = (current?.contentEntries || []) as { id: string; title: string }[];
  const deletedModels = oldModels.filter(item => !models.some(draft => draft.id === item.id));
  const deletedEntries = oldEntries.filter(item => !entries.some(draft => draft.id === item.id));
  const deletedPages = oldPages.filter(p => !state.pages.some(d => d.id === p.id));
  const deletedProducts = oldProducts.filter(p => !state.products.some(d => d.id === p.id));
  const deletedBlocks = oldBlocks.filter(block => !blocks.some(draft => draft.id === block.id));
  const knownIds={pageIds:new Set(state.pages.map(p=>p.id)),productIds:new Set(state.products.map(p=>p.id)),sharedBlockIds:new Set(blocks.map(p=>p.id)),contentModelIds:new Set(models.map(p=>p.id)),contentEntryIds:new Set(entries.map(p=>p.id)),removePageIds:new Set(oldPages.map(p=>p.id)),removeProductIds:new Set(oldProducts.map(p=>p.id)),removeSharedBlockIds:new Set(oldBlocks.map(p=>p.id)),removeContentModelIds:new Set(oldModels.map(p=>p.id)),removeContentEntryIds:new Set(oldEntries.map(p=>p.id))};
  const missing=scopeArrays.flatMap(key=>scope[key].filter(id=>!knownIds[key].has(id)));
  function clearMissing(){setPageIds(v=>v.filter(id=>knownIds.pageIds.has(id)));setProductIds(v=>v.filter(id=>knownIds.productIds.has(id)));setSharedBlockIds(v=>v.filter(id=>knownIds.sharedBlockIds.has(id)));setContentModelIds(v=>v.filter(id=>knownIds.contentModelIds.has(id)));setContentEntryIds(v=>v.filter(id=>knownIds.contentEntryIds.has(id)));setRemovePageIds(v=>v.filter(id=>knownIds.removePageIds.has(id)));setRemoveProductIds(v=>v.filter(id=>knownIds.removeProductIds.has(id)));setRemoveSharedBlockIds(v=>v.filter(id=>knownIds.removeSharedBlockIds.has(id)));setRemoveContentModelIds(v=>v.filter(id=>knownIds.removeContentModelIds.has(id)));setRemoveContentEntryIds(v=>v.filter(id=>knownIds.removeContentEntryIds.has(id)));setCheck(null);}
  const invalidate = (action: () => void) => { setCheck(null); action(); };
  async function submit(publish: boolean) {
    setBusy(true);setError('');
    try {
      await runtime.flush();
      const current = runtime.getEnvelope();
      const payload={...scope,expectedRevision:current.revision,baseReleaseId:current.activeReleaseId};
      if (!publish) {const result=await request<CheckResult>('/api/releases/preview',{method:'POST',body:JSON.stringify(payload)});setCheck({...result,requestKey});}
      else {
        if(!check||!checked||check.expectedRevision!==current.revision||check.baseReleaseId!==current.activeReleaseId)throw new RequestError(409,'草稿、公开版本或发布范围已变化，请重新检查；尚未发布');
        await runtime.mutate(env => {if(env.revision!==check.expectedRevision||env.activeReleaseId!==check.baseReleaseId)throw new RequestError(409,'等待期间内容已变化，请重新检查');return request<StudioEnvelope>('/api/releases',{method:'POST',body:JSON.stringify({...scope,expectedRevision:check.expectedRevision,baseReleaseId:check.baseReleaseId})});});
        if(!entryId)clearLocalRecovery(runtime.actor.id,'publish-scope');message.success('新版本已发布，公开网站现在读取此版本'); onPublished(); onClose();
      }
    } catch (error) { setError((error as Error).message); setCheck(null); }
    finally { setBusy(false); }
  }
  function includeDependencies(deps:Dependency[]) {
    const ids=(kind:Dependency['kind'])=>deps.filter(d=>d.kind===kind).map(d=>d.id),merge=(prev:string[],next:string[])=>[...new Set([...prev,...next])];
    setPageIds(v=>merge(v,ids('page')));setRemovePageIds(v=>v.filter(id=>!ids('page').includes(id)));setProductIds(v=>merge(v,ids('product')));setRemoveProductIds(v=>v.filter(id=>!ids('product').includes(id)));setContentEntryIds(v=>merge(v,ids('entry')));setRemoveContentEntryIds(v=>v.filter(id=>!ids('entry').includes(id)));setContentModelIds(v=>merge(v,ids('model')));setRemoveContentModelIds(v=>v.filter(id=>!ids('model').includes(id)));setSharedBlockIds(v=>merge(v,ids('block')));setRemoveSharedBlockIds(v=>v.filter(id=>!ids('block').includes(id)));
    if(deps.some(d=>d.kind==='layout'))setIncludeLayout(true);if(deps.some(d=>d.kind==='forms'))setIncludeForms(true);if(deps.some(d=>d.kind==='theme'))setIncludeTheme(true);if(deps.some(d=>d.kind==='catalog'))setIncludeCatalog(true);if(deps.some(d=>d.kind==='settings'))setIncludeSettings(true);setCheck(null);setError('');message.info('建议依赖已勾选，尚未发布；请重新检查最终组合。');
  }
  const checklist = (items: { id: string; label: string; path?: string }[], value: string[], set: (v: string[]) => void) => items.map(item => <div className="shell-publish-row" key={item.id}><Checkbox checked={value.includes(item.id)} onChange={event => invalidate(() => set(event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id)))}>{item.label}</Checkbox><span>{item.path}</span></div>);
  // 仅调整范围的呈现方式；默认选择、依赖预检、权限和过期检查保持原规则。
  const selectedSettings=[includeTheme&&'网站外观',includeSettings&&'网站资料与搜索设置',includeLayout&&'页眉页脚与菜单',includeForms&&'询盘表单',includeCatalog&&'分类标签',includeTemplates&&'页面模板',includeRedirects&&'旧网址跳转',includeCode&&'自定义代码'].filter(Boolean);
  return <Modal rootClassName="admin-app shell-modal" title="发布网站更新" open onCancel={()=>!busy&&close()} width={960} styles={{body:{maxHeight:'74vh',overflowY:'auto'}}} footer={<Space wrap><Button disabled={busy} onClick={close}>取消</Button><Button loading={busy} onClick={()=>submit(false)}>检查所选内容</Button><Button type="primary" loading={busy} disabled={!checked||!!check?.errors.length||runtime.actor.role!=='admin'} onClick={()=>submit(true)}>确认更新网站</Button></Space>}>
    <Steps size="small" current={checked&&!check?.errors.length?2:check?1:0} items={[{title:'选择内容'},{title:'检查问题'},{title:'确认更新'}]} style={{marginBottom:20}}/>
    {recovered&&<Alert type="warning" title="已恢复上次选择，需要重新检查；尚未发布"/>}
    {!!missing.length&&<Alert type="warning" title={`${missing.length}项选择已经失效`} description="原选择仍保留，请移除失效项后重新检查。" action={<Button disabled={busy} onClick={clearMissing}>移除失效选择</Button>}/>}
    {error&&<Alert type="error" showIcon title={error}/>}
    {check&&!checked&&<Alert type="warning" title="内容或范围有变化，请重新检查"/>}
    <Typography.Paragraph type="secondary">只更新这次勾选的内容，未勾选的部分保持原公开版本。点击检查不会发布，最后还需确认。</Typography.Paragraph>
    <label className="shell-field-label" htmlFor="release-title">更新备注（方便以后找回）</label><Input id="release-title" value={title} maxLength={80} onChange={event=>invalidate(()=>setTitle(event.target.value))} style={{marginBottom:16}}/>
    <Space wrap style={{marginBottom:16}}><Tag>页面 {pageIds.length}</Tag><Tag>产品 {productIds.length}</Tag><Tag>其他内容 {contentEntryIds.length}</Tag><Tag>公共区块 {sharedBlockIds.length}</Tag><Tag>栏目设置 {contentModelIds.length}</Tag></Space>
    <MoreSettings title={`页面 · 已选 ${pageIds.length} / ${state.pages.length}`} defaultOpen>
      {state.pages.length?checklist(state.pages.map(p=>({id:p.id,label:`${p.title} · ${localeOf(state.settings,p)}`,path:`${p.slug}${p.status==='draft'?' · 待发布':''}`})),pageIds,setPageIds):<Empty description="还没有页面"/>}
    </MoreSettings>
    <MoreSettings title={`产品资料 · 已选 ${productIds.length} / ${state.products.length}`} defaultOpen={!!productIds.length} description="新产品或修改过的产品也要勾选，才会在网站上更新。">
      {state.products.length?checklist(state.products.map(p=>({id:p.id,label:`${p.name} · ${localeOf(state.settings,p)}`,path:p.sku})),productIds,setProductIds):<Typography.Text type="secondary">还没有产品</Typography.Text>}
    </MoreSettings>
    <MoreSettings title={`案例与其他内容 · 已选 ${contentEntryIds.length} / ${entries.length}`} defaultOpen={!!contentEntryIds.length}>
      {entries.length?checklist(entries.map(entry=>({id:entry.id,label:`${entry.title} · ${localeOf(state.settings,entry)}`,path:models.find(model=>model.id===entry.modelId)?.name||'未找到栏目'})),contentEntryIds,setContentEntryIds):<Typography.Paragraph type="secondary">还没有案例、团队等独立内容</Typography.Paragraph>}
      <MoreSettings title={`栏目与填写项目 · 已选 ${contentModelIds.length} / ${models.length}`} defaultOpen={!!contentModelIds.length} description="首次使用或调整过填写项目的栏目，需要和内容一起发布。检查结果会提示缺少的项目。">
        {models.length?checklist(models.map(model=>({id:model.id,label:model.name,path:`${model.target==='product'?'产品参数':'内容栏目'} · ${model.fields.length}个填写项`})),contentModelIds,setContentModelIds):<Typography.Text type="secondary">暂无栏目设置</Typography.Text>}
      </MoreSettings>
    </MoreSettings>
    <MoreSettings title={`网站公共内容 · 已选 ${sharedBlockIds.length}份区块${includeLayout?' · 含页眉页脚':''}`} defaultOpen={!!sharedBlockIds.length||includeLayout} description="公共内容更新后，所有使用它的页面都会同步变化。检查后可以查看影响范围。">
      {blocks.length?checklist(blocks.map(block=>({id:block.id,label:block.name,path:oldBlocks.some(old=>old.id===block.id)?'更新已有公共内容':'首次发布'})),sharedBlockIds,setSharedBlockIds):<Typography.Paragraph type="secondary">还没有公共区块</Typography.Paragraph>}
      <Checkbox checked={includeLayout} onChange={event=>invalidate(()=>setIncludeLayout(event.target.checked))}>网站页眉、页脚与导航菜单设置</Checkbox>
    </MoreSettings>
    <Typography.Title level={5}>网站资料与外观</Typography.Title>
    <Space orientation="vertical" style={{marginBottom:16}}><Checkbox checked={includeTheme} onChange={e=>invalidate(()=>setIncludeTheme(e.target.checked))}>网站颜色、字体等外观{!activeReleaseId&&'（首次发布必选）'}</Checkbox><Checkbox checked={includeSettings} onChange={e=>invalidate(()=>setIncludeSettings(e.target.checked))}>网站资料、语言及搜索设置{!activeReleaseId&&'（首次发布必选）'}</Checkbox></Space>
    <MoreSettings title="其他全站设置（按需选择）" description="只勾选本次需要更新的设置。这些修改可能同时影响多个页面。">
      <Space orientation="vertical"><Checkbox checked={includeForms} onChange={event=>invalidate(()=>setIncludeForms(event.target.checked))}>询盘表单的字段和按钮</Checkbox><Checkbox checked={includeCatalog} onChange={event=>invalidate(()=>setIncludeCatalog(event.target.checked))}>分类与标签</Checkbox><Checkbox checked={includeTemplates} onChange={event=>invalidate(()=>setIncludeTemplates(event.target.checked))}>保存的页面模板与使用规则</Checkbox><Checkbox checked={includeRedirects} onChange={event=>invalidate(()=>setIncludeRedirects(event.target.checked))}>旧网址跳转设置</Checkbox><Checkbox checked={includeCode} disabled={runtime.actor.role!=='admin'} onChange={event=>invalidate(()=>setIncludeCode(event.target.checked))}>自定义CSS / JS代码（管理员）</Checkbox></Space>
    </MoreSettings>
    <Typography.Paragraph type="secondary">同时更新的设置：{selectedSettings.length?selectedSettings.join('、'):'未选择'}</Typography.Paragraph>
    {!!check?.suggestedRedirects?.length&&<Alert type="info" title="旧网址需要跳转到新网址吗？" description={<Space orientation="vertical">{check.suggestedRedirects.map(rule=><Space key={rule.id}><Typography.Text code>{rule.from}</Typography.Text><Typography.Text>→ 当前网址</Typography.Text><Button size="small" disabled={busy} onClick={async()=>{try{await runtime.mutate(env=>request<StudioEnvelope>('/api/studio',{method:'PATCH',body:JSON.stringify({expectedRevision:env.revision,patch:{redirects:[...(env.state.redirects||[]).filter(item=>item.from!==rule.from),rule]}})}));setIncludeRedirects(true);setCheck(null);message.success('跳转已保存为草稿，请重新检查并确认发布');}catch(e){message.error((e as Error).message);}}}>采用建议</Button></Space>)}</Space>}/>}
    {(deletedPages.length>0||deletedProducts.length>0||deletedBlocks.length>0||deletedModels.length>0||deletedEntries.length>0)&&<MoreSettings title="需要从网站移除的内容（请逐项确认）" defaultOpen description="只勾选需要从公开网站下架的内容，未勾选的内容会继续保留。">
      {checklist(deletedPages.map(p=>({id:p.id,label:p.title,path:'页面'})),removePageIds,setRemovePageIds)}{checklist(deletedProducts.map(p=>({id:p.id,label:p.name,path:'产品'})),removeProductIds,setRemoveProductIds)}{checklist(deletedBlocks.map(block=>({id:block.id,label:block.name,path:'公共区块'})),removeSharedBlockIds,setRemoveSharedBlockIds)}{checklist(deletedModels.map(item=>({id:item.id,label:item.name,path:'栏目设置'})),removeContentModelIds,setRemoveContentModelIds)}{checklist(deletedEntries.map(item=>({id:item.id,label:item.title,path:'其他内容'})),removeContentEntryIds,setRemoveContentEntryIds)}
    </MoreSettings>}
    {check&&<PublicationCheckDetails data={check.diagnostics} onDependencies={includeDependencies} onRepair={onRepair} />}
    {check && <div style={{ marginTop: 20 }}><Alert type={check.errors.length ? 'error' : 'success'} showIcon title={check.errors.length ? '还有问题需要处理' : '所选内容检查通过'} description={<><p>最终公开版本：{check.summary.totalPages} 个页面、{check.summary.totalProducts} 件产品、{check.summary.totalSharedBlocks || 0} 个公共区块、{check.summary.totalContentModels || 0} 个栏目、{check.summary.totalContentEntries || 0} 条内容记录。</p>{!!check.summary.affectedPages?.length && <div><p>此次资产变更可能影响以下页面：</p><Space wrap>{check.summary.affectedPages.map(page => <Tag key={page.id}>{page.title}</Tag>)}</Space></div>}{check.errors.map((e,i) => <p key={i}>{e}</p>)}{check.warnings.map((e,i) => <p key={i}><Tag color="gold">提示</Tag>{e}</p>)}{publicationPreview && <Space orientation="vertical" size={4}>
      <Button href={publicationPreview.href} target="_blank" rel="noopener noreferrer" disabled={busy} onClick={event => {
        if (Date.parse(publicationPreview.expiresAt) > Date.now()) return;
        event.preventDefault(); setCheck(null); setError('发布范围预览已过期，请重新检查所选内容。');
      }}>预览本次发布内容</Button>
      <Typography.Text type="secondary">可在新标签页查看本次已检查的范围。需要改选时，回到发布窗口重新检查。</Typography.Text>
    </Space>}</>} /></div>}
  </Modal>;
}
