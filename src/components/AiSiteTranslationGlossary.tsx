'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Flex, Input, Select, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { TranslationGlossary, TranslationGlossaryEntry } from '@/lib/ai-site-translation-types';

type Props = { value: TranslationGlossary; initialDraft?: TranslationGlossary; locales: { code: string; label: string }[]; sourceLocale: string; targetLocale: string; busy: boolean; onDirty: (value: boolean, draft?: TranslationGlossary) => void; onSave: (value: TranslationGlossary) => Promise<void> };
/** 术语独立版本号避免多人覆盖；服务端冲突时不替换当前表单，用户仍可复制和修订输入。 */
export default function AiSiteTranslationGlossary({ value, initialDraft, locales, sourceLocale, targetLocale, busy, onDirty, onSave }: Props) {
  const [draft, setDraft] = useState(initialDraft || value), [dirty, setDirty] = useState(!!initialDraft);
  useEffect(() => { if (!dirty) setDraft(value); }, [value, dirty]);
  function change(entries: TranslationGlossaryEntry[]) { const next = { ...draft, entries }; setDraft(next); setDirty(true); onDirty(true, next); }
  function edit(index: number, patch: Partial<TranslationGlossaryEntry>) { change(draft.entries.map((row, i) => i === index ? { ...row, ...patch } : row)); }
  const options = locales.map(locale => ({ value: locale.code, label: locale.label }));
  return <Space orientation="vertical" size={16} style={{ display: 'flex', width: '100%' }}>
    <Alert type="info" showIcon title="统一产品和品牌的用词" description="术语按原语言和目标语言保存，整站、产品和文章翻译共用。同一语言对最多30条，总计100条；保存术语不会自动改写网站。" />
    {dirty && value.revision !== draft.revision && <Alert type="warning" title="术语库已被其他操作更新，当前输入保留" description="请复制需要保留的用词，再读取最新版本后合并。旧版本不能覆盖新术语。" />}
    {draft.entries.map((row, index) => <Card size="small" key={row.id || index} styles={{ body: { padding: 16 } }}>
      <Flex gap={12} wrap align="center"><Select aria-label={`术语${index + 1}原语言`} value={row.sourceLocale} options={options} style={{ minWidth: 150, flex: '1 1 150px' }} disabled={busy} onChange={sourceLocale => edit(index, { sourceLocale })}/><Typography.Text>→</Typography.Text><Select aria-label={`术语${index + 1}目标语言`} value={row.targetLocale} options={options} style={{ minWidth: 150, flex: '1 1 150px' }} disabled={busy} onChange={targetLocale => edit(index, { targetLocale })}/><Button aria-label={`删除术语${index + 1}`} icon={<DeleteOutlined />} disabled={busy} onClick={() => change(draft.entries.filter((_, i) => i !== index))}/></Flex>
      <Flex gap={12} wrap style={{ marginTop: 12 }}><Input aria-label={`术语${index + 1}原词`} placeholder="原术语" maxLength={100} value={row.source} style={{ flex: '1 1 180px' }} disabled={busy} onChange={event => edit(index, { source: event.target.value })}/><Input aria-label={`术语${index + 1}译词`} placeholder="固定译法" maxLength={100} value={row.target} style={{ flex: '1 1 180px' }} disabled={busy} onChange={event => edit(index, { target: event.target.value })}/></Flex>
    </Card>)}
    <Flex gap={12} wrap><Button icon={<PlusOutlined />} disabled={busy || draft.entries.length >= 100 || !targetLocale} onClick={() => change([...draft.entries, { id: `term-${crypto.randomUUID()}`, sourceLocale, targetLocale, source: '', target: '' }])}>添加术语</Button><Button type="primary" disabled={busy || !dirty} onClick={async () => { try { await onSave(draft); setDirty(false); onDirty(false); } catch { /* 父层显示保存失败，保留本地输入及未保存保护。 */ } }}>保存术语库</Button><Button disabled={busy || !dirty} onClick={() => { setDraft(value); setDirty(false); onDirty(false); }}>读取最新版本并放弃当前输入</Button></Flex>
  </Space>;
}
