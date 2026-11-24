'use client';
import { Alert,Button,Space,Table,Tabs,Tag,Typography } from 'antd';
import type { PublicationDiagnostics,Dependency,ChangeScope } from '@/server/publication-diagnostics';
import type { Screen } from '@/lib/types';
const scopes:Record<ChangeScope,string>={page:'页面',product:'产品',model:'栏目设置',entry:'内容资料',block:'公共区块与卡片',theme:'网站外观',layout:'页眉页脚与菜单',code:'自定义代码',catalog:'分类标签',redirects:'旧网址跳转',forms:'询盘表单',templates:'保存的页面模板',settings:'网站资料与搜索设置'};
/** 显式建议仅调整选择范围，不保存草稿/发布；所有影响和数量都来自服务端同一候选版本。 */
export default function PublicationCheckDetails({data,onDependencies,onRepair}:{data:PublicationDiagnostics;onDependencies:(deps:Dependency[])=>void;onRepair?:(screen:Screen,pageId?:string)=>void}){
 // 检查失败时先展示可处理的问题；依赖建议仍须主动选择，不能替用户扩大发布范围。
 return <Tabs defaultActiveKey={data.dependencies.length||data.issues.length?'dependencies':'changes'} items={[
  {key:'changes',label:`这次会更新 · ${data.changes.length}`,children:<Space orientation="vertical" style={{width:'100%'}}>
   <Alert type="info" title={`${data.pendingDraftCount}项草稿修改暂未包含在本次更新中`} description="未勾选的内容会保留在草稿，网站继续使用之前的版本；数量按内容或整组设置统计。"/>
   <Table rowKey={r=>`${r.scope}:${r.id}`} size="small" pagination={{pageSize:8}} scroll={{x:500}} dataSource={data.changes} columns={[{title:'分类',dataIndex:'scope',render:v=>scopes[v as ChangeScope]},{title:'内容或设置',dataIndex:'label'},{title:'更新方式',dataIndex:'change',render:v=><Tag color={v==='add'?'green':v==='remove'?'red':'blue'}>{v==='add'?'新增':v==='remove'?'从网站下架':'修改'}</Tag>}]} locale={{emptyText:'所选内容与当前网站相同，无需更新'}}/>
  </Space>},
  {key:'dependencies',label:`还需选择或修正 · ${data.dependencies.length+data.issues.length}`,children:<Space orientation="vertical" style={{width:'100%'}}>
   {data.dependencies.length>0&&<><Alert type="warning" title="这些内容需要一起发布" description="例如页面使用的表单、产品资料或公共区块。全站设置可能包含其他草稿修改，请先核对列表。下方按钮只调整选择范围，不会发布。"/><Table rowKey={r=>`${r.kind}:${r.id}`} size="small" scroll={{x:500}} pagination={{pageSize:8}} dataSource={data.dependencies} columns={[{title:'需要同时选择',dataIndex:'label'},{title:'原因',dataIndex:'reason'}]}/><Button onClick={()=>onDependencies(data.dependencies)}>同时选择这些内容，再检查</Button></>}
   {data.issues.map((issue,i)=><Alert key={i} type="error" showIcon title={issue.message} action={onRepair&&<Button size="small" onClick={()=>onRepair(issue.screen,issue.pageId)}>去修改</Button>}/>)}
   {!data.dependencies.length&&!data.issues.length&&<Typography.Text type="secondary">目前没有发现缺少的资料或需要修正的问题。</Typography.Text>}
  </Space>},
  {key:'impact',label:`影响哪些页面 · ${data.impact.pages.length}`,children:<Space orientation="vertical" style={{width:'100%'}}>
   <Alert type="info" title={data.impact.mode==='conservative'?'可能受到影响的页面':'将受影响的页面'} description={data.impact.reason}/>
   <Space wrap>{data.impact.pages.map(p=><Tag key={p.id} color={p.removed?'red':undefined}>{p.title}{p.removed?' · 下架':''}</Tag>)}{!data.impact.pages.length&&<Typography.Text type="secondary">没有直接更新公开页面，模板修改不会覆盖已复制的页面。</Typography.Text>}</Space>
   {data.lists.length>0&&<><Typography.Paragraph type="secondary">下表是列表显示数量的估算，不包含访客搜索和翻页后的变化；显示“无法估算”的列表请到预览中核对。</Typography.Paragraph><Table rowKey={r=>`${r.pageId}:${r.nodeId}`} size="small" pagination={{pageSize:8}} scroll={{x:550}} dataSource={data.lists} columns={[{title:'页面',dataIndex:'pageTitle'},{title:'检查编号',render:(_,__,i)=>`列表 ${i+1}`},{title:'更新前数量',render:(_,r)=>r.before??(r.beforeState==='absent'?'无此列表':'无法估算')},{title:'更新后数量',render:(_,r)=>r.after??(r.afterState==='absent'?'无此列表':'无法估算')}]} expandable={{expandedRowRender:r=><Typography.Text>技术信息 · 列表节点：<Typography.Text code>{r.nodeId}</Typography.Text></Typography.Text>}}/></>}
  </Space>},
 ]}/>;
}
