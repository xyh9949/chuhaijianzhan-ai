'use client';
import { useState } from 'react';
import { Alert, Button, Modal, Space, Table, Typography } from 'antd';
import { request, RequestError, useStudioRuntime } from '@/lib/studio-client';
import type { AiWritingSaveAttempt } from '@/lib/ai-writing-types';
import { writingRecordDifferences, writingTargetRecord, type PendingWritingSave, type WritingRecord } from '@/lib/ai-writing-save-client';
import type { StudioEnvelope } from '@/lib/studio-client';

const showValue = (value:unknown) => value === undefined ? '未填写' : typeof value === 'string' ? value : JSON.stringify(value);
/** 核对仅发GET；完成标记证明那次保存，内容比较决定能否安全继续，二者不能互相替代。 */
export default function WritingSaveCheck({ pending, current, onConfirmed }: { pending:PendingWritingSave; current:()=>WritingRecord; onConfirmed:(saved:WritingRecord)=>void }) {
  const runtime = useStudioRuntime(), [open,setOpen] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [result,setResult] = useState<{ attempt?:AiWritingSaveAttempt; env:StudioEnvelope; notice:string }>();
  async function check() {
    setOpen(true);setBusy(true);setError('');setResult(undefined);
    try {
      let attempt:AiWritingSaveAttempt|undefined, notice='';
      try { attempt=await request<AiWritingSaveAttempt>(`/api/ai/writing/saves/${encodeURIComponent(pending.id)}`); }
      catch(cause) { if(cause instanceof RequestError && [404,410].includes(cause.status)) notice=cause.status===410?'保存核对记录已过期，无法确认那次请求是否完成。':'暂未找到保存完成记录，无法确认那次请求是否完成。'; else throw cause; }
      if(attempt && !attempt.targets.some(target=>target.kind===pending.target.kind && target.id===pending.target.id)) throw new Error('保存记录与当前内容不一致，请保留输入并重新核对。');
      const env=await request<StudioEnvelope>('/api/studio');setResult({attempt,env,notice});
    } catch(cause) {setError(cause instanceof Error?cause.message:'核对失败，当前输入保持。');} finally {setBusy(false);}
  }
  const server=result?writingTargetRecord(result.env,pending.target):undefined, differences=result?writingRecordDifferences(current(),server):[];
  async function confirm() {
    if(!result?.attempt || differences.length)return;
    setBusy(true);setError('');
    try {
      // 再读并检查当前记录；比较后有人修改时仍阻止采用，不用旧GET覆盖新版本。
      await runtime.confirmMutationByReading(env=>!!writingTargetRecord(env,pending.target)&&writingRecordDifferences(current(),writingTargetRecord(env,pending.target)).length===0);
      const saved=writingTargetRecord(runtime.getEnvelope(),pending.target);if(!saved)throw new Error('内容已不存在，当前输入保持。');onConfirmed(saved);setOpen(false);
    } catch(cause) {setError(cause instanceof Error?cause.message:'读取未完成，当前输入保持。');} finally {setBusy(false);}
  }
  // 核对发生时全局同步提示仍在1100层；弹窗及遮罩必须位于其上，手机端才能实际点击。
  return <><Alert type="warning" showIcon title="保存结果尚未确认，输入已保留" description="先读取服务器核对，不会重复保存或重新调用AI。" action={<Button onClick={()=>void check()}>核对保存结果</Button>}/><Modal title="核对保存结果" open={open} zIndex={1400} onCancel={()=>!busy&&setOpen(false)} closable={!busy} mask={{closable:!busy}} footer={<Space wrap><Button disabled={busy} onClick={()=>setOpen(false)}>返回编辑，保留输入</Button><Button loading={busy} onClick={()=>void check()}>重新核对</Button><Button type="primary" disabled={busy||!result?.attempt||!!differences.length} onClick={()=>void confirm()}>确认已保存并继续</Button></Space>}>
    {busy&&<Typography.Paragraph>正在读取服务器记录…</Typography.Paragraph>}{error&&<Alert type="error" showIcon title={error}/>}
    {result&&<Space orientation="vertical" size={16} style={{width:'100%',marginTop:16}}><Alert showIcon type={result.attempt?'success':'warning'} title={result.attempt?`这次保存已完成（保存版本${result.attempt.savedRevision}）`:result.notice} description={differences.length?'服务器当前内容与编辑区有差异。请保留输入，核对后再处理；这里不会覆盖任何一方。':result.attempt?'服务器当前内容与编辑区一致，可以确认保存状态。':'当前内容相同也不能证明那次请求已完成。'}/>{!!differences.length&&<Table size="small" pagination={false} rowKey="key" dataSource={differences} scroll={{x:580}} columns={[{title:'存在差异的项目',dataIndex:'label',width:120},{title:'当前编辑区',dataIndex:'local',render:value=><Typography.Paragraph ellipsis={{rows:3,expandable:true}}>{showValue(value)}</Typography.Paragraph>},{title:'服务器当前内容',dataIndex:'server',render:value=><Typography.Paragraph ellipsis={{rows:3,expandable:true}}>{showValue(value)}</Typography.Paragraph>}]}/>}</Space>}
  </Modal></>;
}
