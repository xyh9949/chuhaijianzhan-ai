import { Alert, Collapse, Descriptions, List, Space, Tag, Typography } from 'antd';
import type { AiBuildDeviceLayout, AiBuildLayoutInspection, AiBuildPageLayout } from '@/lib/ai-builder-types';
import { aiLayoutFlowLabel, matchAiInspectionPage } from '@/lib/ai-build-layout-inspection';
import type { Device } from '@/lib/responsive-style';
const { Text } = Typography;
const fields: Record<string,string> = {'builtin:name':'名称','builtin:description':'介绍','builtin:image':'图片','builtin:url':'详情链接','builtin:sku':'型号'};
/** 网格轨道用于宽度比例，不等于文字栏数；依据实际跨度向站长说明内容分区。 */
export const aiLayoutColumnLabel=(value:AiBuildDeviceLayout)=>{
  if(!value.visible)return '本尺寸隐藏';
  const inner=[...new Set(value.innerGrids.map(grid=>{
    const spans=grid.spans.map(span=>Math.max(1,Math.min(grid.columns,span)));
    if(spans.length&&spans.every(span=>span===grid.columns))return '通栏排列';
    if(spans.length&&spans.every(span=>span===spans[0])&&grid.columns%spans[0]===0)return `${grid.columns/spans[0]}列`;
    return spans.some(span=>span>1)?'宽窄分区':`${grid.columns}列`;
  }))];
  return `${value.columns===null?'按内容排列':`主区${value.columns}列`}${inner.length?` · 内部${inner.join('、')}`:''}`;
};
/** 手机专属条目索引也属于实际布局，不能只看桌面便声称整份方案没有编号。 */
export const aiLayoutNumberedLabel=(inspection:AiBuildLayoutInspection)=>{
  const pages=inspection.pages.filter(page=>page.kind==='page').map(page=>({page:page.title,desktop:page.sections.reduce((sum,section)=>sum+section.desktop.numberedItems,0),mobile:page.sections.reduce((sum,section)=>sum+section.mobile.numberedItems,0)})).filter(page=>page.desktop>0||page.mobile>0);
  return pages.length?`编号条目位于：${pages.map(page=>`${page.page}（桌面${page.desktop}项 / 手机${page.mobile}项）`).join('、')}`:'本方案未生成编号条目';
};
function DeviceFacts({value,label,compact=false}:{value:AiBuildDeviceLayout;label:string;compact?:boolean}){
  if(compact)return <Space orientation="vertical" size={4} style={{width:'100%'}}><Text strong>{label} · {aiLayoutColumnLabel(value)}</Text><Text>{aiLayoutFlowLabel(value.flow)}</Text>{value.actions[0]&&<Text type="secondary">{value.actions[0].label} → {value.actions[0].path||(value.actions[0].dynamic?'动态目标':'未指定目标')}</Text>}</Space>;
  return <Space orientation="vertical" size={4} style={{width:'100%'}}><Text strong>{label} · {aiLayoutColumnLabel(value)}</Text><Text>{aiLayoutFlowLabel(value.flow)}</Text>{value.productIdentityFirst&&<Text type="secondary">详情组件：{value.productDetailOrder==='specifications-first'?'先显示产品信息和图集，再看规格和说明。':value.productDetailOrder==='overview-first'?'先显示产品信息和说明，再看图集与规格。':'手机优先展示产品信息，具体字段随当前记录。'}</Text>}{value.numberedItems>0&&<Text type="secondary">已生成{value.numberedItems}个条目编号</Text>}{value.lists.map((list,index)=><Text type="secondary" key={index}>动态{list.source==='entry'?'内容':'产品'}列表：{list.columns===null?'随内容排列':`${list.columns}列`}{list.fields.length?` · ${list.fields.map(field=>fields[field]||field).join(' / ')}`:''}</Text>)}{value.actions.length>0&&<Text type="secondary">{value.actions.map(action=>`${action.label} → ${action.path||(action.dynamic?'动态目标':'未指定目标')}`).join('；')}</Text>}</Space>;
}
/** 仅渲染由原生Data得出的事实；创意方向名和模型rationale不参与任何列数、顺序或能力判定。 */
export function AiBuildDirectionFacts({inspection}:{inspection:AiBuildLayoutInspection}){
  const page=inspection.pages.filter(page=>page.kind==='page'&&!page.path.includes(':')).sort((a,b)=>a.path.split('/').filter(Boolean).length-b.path.split('/').filter(Boolean).length)[0];
  if(!page)return <Text type="secondary">没有可核对的普通页面，请打开真实预览。</Text>;
  const first=(device:Device)=>page.sections.filter(section=>section.role==='content'&&section[device].visible).map((section,index)=>({section,index})).sort((a,b)=>a.section[device].order-b.section[device].order||a.index-b.index)[0]?.section;
  const desktop=first('desktop'),mobile=first('mobile');
  const lists=inspection.pages.filter(page=>page.kind==='page').flatMap(p=>p.sections.flatMap(section=>section.desktop.lists.map(list=>({page:p.title,list,phone:section.mobile.lists.find(phone=>phone.id===list.id)}))));
  return <Space orientation="vertical" size={10} style={{width:'100%'}}><Text strong>{page.title} · 首个内容区</Text>{desktop?<DeviceFacts compact label="桌面" value={desktop.desktop}/>:<Text>桌面没有可见内容区</Text>}{mobile?<DeviceFacts compact label="手机" value={mobile.mobile}/>:<Text>手机没有可见内容区</Text>}<Collapse size="small" items={[{key:'other-pages',label:'更多页面排版',children:<Space orientation="vertical" size={8}>{lists.map((item,index)=><Text key={index} type="secondary">{item.page}的动态列表：桌面{item.list.columns===null?'按内容排列':`${item.list.columns}列`} / 手机{!item.phone?'未展示':item.phone.columns===null?'按内容排列':`${item.phone.columns}列`}</Text>)}<Text type="secondary">{aiLayoutNumberedLabel(inspection)}</Text></Space>}]}/><Text type="secondary">{page.sections.filter(section=>section.role==='content').length}个内容区 · {inspection.pages.filter(page=>page.kind==='page').length}个页面{inspection.pages.some(page=>page.kind==='template')?' · 另有待采用模板':''}</Text></Space>;
}
export function AiBuildPageFacts({inspection,path,device='desktop'}:{inspection?:AiBuildLayoutInspection;path:string;device?:Device}){
  if(!inspection)return <Alert type="info" showIcon title="这份预览未返回布局核对信息" description="保留原预览与采用流程，可重新读取本人预览记录获取原生结构核对。"/>;
  const page=matchAiInspectionPage(inspection,path);
  if(!page)return <Alert type="info" showIcon title="当前页面不在本次生成页面中" description="从页面选择中打开本次生成的页面，再核对它的排版。"/>;
  return <Space orientation="vertical" size={12} style={{width:'100%'}}><Text strong>原生布局核对 · {page.title} · {device==='mobile'?'手机':device==='tablet'?'平板':'桌面'}</Text><Descriptions size="small" column={1} items={[{key:'path',label:'页面地址',children:<Text code>{path}</Text>}]}/><PageSections page={page} device={device}/><Text type="secondary">来自当前预览保存的组件和继承后的样式。实际首屏位置、文字换行和图片加载请在下方页面核对。</Text></Space>;
}
function PageSections({page,device}:{page:AiBuildPageLayout;device:Device}){
  const sections=page.sections.map((section,index)=>({section,index})).sort((a,b)=>a.section[device].order-b.section[device].order||a.index-b.index);
  return <List size="small" dataSource={sections} renderItem={({section},index)=><List.Item><Space orientation="vertical" size={8} style={{width:'100%'}}><Space wrap><Tag>{index+1}</Tag><Text strong>{section.title}</Text>{section.role!=='content'&&<Text type="secondary">{section.role==='navigation'?'页内导航':'页内页脚'}</Text>}</Space><DeviceFacts label={device==='mobile'?'手机':device==='tablet'?'平板':'桌面'} value={section[device]}/></Space></List.Item>}/>;
}
