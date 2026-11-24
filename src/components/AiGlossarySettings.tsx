'use client';
import { useEffect,useState } from 'react';
import { Alert,Button,Space } from 'antd';
import { request,useStudioRuntime } from '@/lib/studio-client';
import { siteLocales } from '@/lib/localization';
import { readLocalRecovery } from '@/lib/local-recovery';
import type { TranslationGlossary } from '@/lib/ai-site-translation-types';
import AiSiteTranslationGlossary from './AiSiteTranslationGlossary';
import { useLocalDraftGuard } from './useLocalDraftGuard';
/** 共用术语入口不依赖打开翻译任务；冲突和离开均保留尚未保存的输入。 */
export default function AiGlossarySettings(){
 const runtime=useStudioRuntime(),locales=siteLocales(runtime.envelope.state.settings);
 const [recovered]=useState(()=>readLocalRecovery<TranslationGlossary>(runtime.actor.id,'ai-glossary',v=>!!v&&typeof v==='object'&&Array.isArray((v as TranslationGlossary).entries)&&Number.isSafeInteger((v as TranslationGlossary).revision)));
 const [value,setValue]=useState<TranslationGlossary>(),[draft,setDraft]=useState<TranslationGlossary|undefined>(recovered?.snapshot),[dirty,setDirty]=useState(!!recovered),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
 const guard=useLocalDraftGuard({actorId:runtime.actor.id,scope:'ai-glossary',screen:'settings',title:'翻译术语',dirty,busy,snapshot:draft,discard:()=>{setDirty(false);setDraft(undefined);}});
 async function load(){try{setValue(await request('/api/ai/site-translations/glossary'));setError('');}catch(e){setError((e as Error).message);}}
 useEffect(()=>{void load();},[]);
 return <Space orientation="vertical" size={16} style={{display:'flex'}}>{guard.dialog}{error&&<Alert type="error" showIcon title={error}/ >}{success&&<Alert type="success" showIcon title={success}/ >}<Button disabled={busy} onClick={()=>void load()}>读取已保存术语</Button>{value&&<AiSiteTranslationGlossary value={value} initialDraft={draft} locales={locales} sourceLocale={locales[0]?.code||''} targetLocale={locales[1]?.code||''} busy={busy} onDirty={(changed,next)=>{setDirty(changed);setDraft(next);setSuccess('');}} onSave={async next=>{setBusy(true);setError('');try{const saved=await request<TranslationGlossary>('/api/ai/site-translations/glossary',{method:'PATCH',body:JSON.stringify({expectedRevision:next.revision,entries:next.entries})});setValue(saved);setDraft(undefined);setDirty(false);guard.clear();setSuccess('术语已保存，后续翻译会使用对应语言的用词。');}catch(e){setError((e as Error).message);throw e;}finally{setBusy(false);}}}/>}</Space>;
}
