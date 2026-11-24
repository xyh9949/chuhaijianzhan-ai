'use client';

import { useEffect, useState } from 'react';
import { Tabs } from 'antd';
import { localRecoveries, requestLocalLeave } from '@/lib/local-recovery';
import { useStudioRuntime } from '@/lib/studio-client';
import AiProviderSettings from './AiProviderSettings';
import AiWritingProfile from './AiWritingProfile';
import ExternalAiSettings from './ExternalAiSettings';
import AiUsageSettings from './AiUsageSettings';
import AiGlossarySettings from './AiGlossarySettings';
import AiBatchTasks from './AiBatchTasks';

/** 连接凭据与写作依据分开维护，切换前沿用原保护，隐藏表单不继续拦截业务。 */
export default function AiServiceSettings() {
  const { actor } = useStudioRuntime();
  const [tab, setTab] = useState(() => {const pending=localRecoveries(actor.id);return pending.some(item=>item.scope==='ai-writing-profile')?'writing':pending.some(item=>item.scope==='ai-pricing')?'usage':pending.some(item=>item.scope==='ai-glossary')?'glossary':pending.some(item=>item.scope.startsWith('ai-batch-'))?'batch':'connection';});
  useEffect(() => {
    const resume = (event: Event) => {
      if ((event as CustomEvent<{ scope?: string }>).detail?.scope === 'ai-writing-profile') setTab('writing');
      if ((event as CustomEvent<{ scope?: string }>).detail?.scope === 'ai-pricing') setTab('usage');
      if((event as CustomEvent<{scope?:string}>).detail?.scope==='ai-glossary')setTab('glossary');
      if((event as CustomEvent<{scope?:string}>).detail?.scope?.startsWith('ai-batch-'))setTab('batch');
    };
    window.addEventListener('form-studio:recover-local', resume);
    return () => window.removeEventListener('form-studio:recover-local', resume);
  }, []);
  return <Tabs activeKey={tab} onChange={key => requestLocalLeave(() => setTab(key), 'ai-settings-tab')} items={[
    { key: 'connection', label: '服务连接', children: tab === 'connection' ? <AiProviderSettings /> : null },
    { key: 'writing', label: '写作资料', children: tab === 'writing' ? <AiWritingProfile /> : null },
    { key: 'usage', label: '用量与价格', children: tab === 'usage' ? <AiUsageSettings /> : null },
    { key: 'glossary', label: '翻译术语', children: tab === 'glossary' ? <AiGlossarySettings /> : null },
    { key: 'batch', label: '批量内容', children: tab === 'batch' ? <AiBatchTasks/> : null },
    { key: 'external', label: '外部AI连接', children: tab === 'external' ? <ExternalAiSettings /> : null },
  ]} />;
}
