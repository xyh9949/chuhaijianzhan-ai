'use client';

import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { Alert, Button, Collapse, Drawer, Flex, Form, Input, Popconfirm, Segmented, Select, Space, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, PlusOutlined } from '@ant-design/icons';
import { normalizeAiSitePlan } from '@/lib/ai-site-generator';
import type { AiSiteBrief, AiSitePagePlan, AiSitePlan, AiSiteSection } from '@/lib/ai-builder-types';
import { readLocalRecovery } from '@/lib/local-recovery';
import { useLocalDraftGuard } from './useLocalDraftGuard';

const { Text } = Typography;
const sectionNames = { hero: '主标题', text: '文字', features: '特点', products: '产品列表', contact: '询盘表单' };
export const planEditorRecoveryScope = 'ai-build-plan-editor';
type PlanEditorRecovery = { planId: string; pages: AiSitePagePlan[] };

// 本地恢复允许尚未填完的输入；真正保存时仍执行原方案校验。
function validPlanDraft(value: unknown): value is PlanEditorRecovery {
  const draft = value as PlanEditorRecovery;
  return typeof draft?.planId === 'string' && Array.isArray(draft.pages) && draft.pages.length >= 1 && draft.pages.length <= 8 &&
    draft.pages.every(page => page && [page.key, page.title, page.path, page.purpose, page.seoTitle, page.seoDescription].every(field => typeof field === 'string') &&
      Array.isArray(page.sections) && page.sections.length >= 1 && page.sections.length <= 8 &&
      page.sections.every(section => section && Object.hasOwn(sectionNames, section.kind) && typeof section.heading === 'string' && typeof section.body === 'string' &&
        (section.items === undefined || Array.isArray(section.items) && section.items.every(item => typeof item?.title === 'string' && typeof item.body === 'string')) &&
        (section.cta == null || typeof section.cta.label === 'string' && typeof section.cta.pageKey === 'string')));
}
export function readPlanEditorRecovery(actorId: string) {
  return readLocalRecovery<PlanEditorRecovery>(actorId, planEditorRecoveryScope, validPlanDraft)?.snapshot;
}

function PlanField({ label, value, onChange, maxLength, required = false, multiline = false, disabled = false, placeholder, error }: {
  label: string; value: string; onChange: (value: string) => void; maxLength: number;
  required?: boolean; multiline?: boolean; disabled?: boolean; placeholder?: string; error?: string;
}) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const hint = touched ? required && !value.trim() ? `请填写${label}` : error : undefined;
  const props = {
    id, value, maxLength, disabled, placeholder,
    'aria-required': required, 'aria-invalid': Boolean(hint), 'aria-describedby': hint ? `${id}-error` : undefined,
    onBlur: () => setTouched(true),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return <Form.Item label={label} htmlFor={id} required={required} help={hint ? <span id={`${id}-error`}>{hint}</span> : undefined} validateStatus={hint ? 'error' : undefined}>
    {multiline ? <Input.TextArea {...props} autoSize={{ minRows: 2, maxRows: 7 }} /> : <Input {...props} />}
  </Form.Item>;
}

function isFixedPath(path: string, plan: AiSitePlan): boolean {
  return ['/', '/contact', '/products/:slug'].includes(path) ||
    (!plan.intent && path === '/products') ||
    (plan.intent?.siteType === 'professional-services' && path === '/services');
}

function usesCatalogue(page: AiSitePagePlan) {
  return !['/', '/contact', '/products/:slug'].includes(page.path) && page.sections.some(section => section.kind === 'products');
}

/** 只保存手工编辑的页面数据；编译、预览和真正采用继续走原有流程。 */
export default function AiBuildPlanEditor({ planId, actorId, plan, brief, imageIds, saving, onSave, onClose }: {
  planId: string; actorId: string; plan: AiSitePlan; brief: AiSiteBrief; imageIds: ReadonlySet<string>; saving: boolean; onSave: (pages: AiSitePagePlan[]) => Promise<void>; onClose: () => void;
}) {
  const [recovery] = useState(() => { const saved = readPlanEditorRecovery(actorId); return saved?.planId === planId ? saved : undefined; });
  const [pages, setPages] = useState(() => structuredClone(recovery?.pages || plan.pages));
  const [pageKey, setPageKey] = useState(() => pages.find(page => page.path === '/')?.key || pages[0].key);
  const guard = useLocalDraftGuard({ actorId, scope: planEditorRecoveryScope, screen: 'templates', title: '建站方案修改',
    dirty: JSON.stringify(pages) !== JSON.stringify(plan.pages), busy: saving, snapshot: { planId, pages }, discard: () => setPages(structuredClone(plan.pages)) });
  const [error, setError] = useState('');
  const errorSummary = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorSummary.current?.focus(); }, [error]);

  const index = pages.findIndex(page => page.key === pageKey);
  const page = pages[index];
  const parentPage = plan.pages.find(item => item.key === pageKey);
  const fixedPath = Boolean(parentPage && isFixedPath(parentPage.path, plan));
  const lastCatalogue = usesCatalogue(page) && pages.filter(usesCatalogue).length === 1;
  const cannotRemovePage = fixedPath || lastCatalogue || pages.length <= (plan.intent ? 3 : 4);
  const buttonTargets = pages.filter(item => !item.path.includes(':'));
  const targetOptions = buttonTargets.map(item => ({ value: item.key, label: `${item.title || '新页面'} · ${item.path || '未填写网址'}` }));
  const inboundButtons = pages.filter(item => item.key !== pageKey).flatMap(item => item.sections).filter(section => section.cta?.pageKey === pageKey).length;
  const pathError = fixedPath ? undefined : pages.some(item => item.key !== pageKey && item.path.trim() === page.path.trim())
    ? '这个网址已在方案中使用'
    : !/^\/[a-z0-9][a-z0-9/_-]*$/.test(page.path.trim()) || /\/\//.test(page.path) || page.path.endsWith('/')
      ? '请使用类似 /quality 的小写英文网址' : undefined;

  function updatePage(changes: Partial<AiSitePagePlan>) {
    setPages(current => current.map(item => item.key === pageKey ? { ...item, ...changes } : item));
  }
  function updateSection(sectionIndex: number, changes: Partial<AiSiteSection>) {
    setPages(current => current.map(item => item.key === pageKey
      ? { ...item, sections: item.sections.map((section, position) => position === sectionIndex ? { ...section, ...changes } : section) } : item));
  }
  function addPage() {
    if (pages.length >= 8) return;
    const key = `custom-${crypto.randomUUID().replace(/-/g, '')}`;
    const next: AiSitePagePlan = { key, title: '', path: '', purpose: '', seoTitle: '', seoDescription: '', sections: [{ kind: 'hero', heading: '', body: '' }] };
    setPages(current => [...current, next]);
    setPageKey(key);
  }
  function movePage(offset: -1 | 1) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= pages.length) return;
    setPages(current => current.map((item, position) => position === index ? current[targetIndex] : position === targetIndex ? current[index] : item));
  }
  function removePage() {
    if (cannotRemovePage) return;
    // 删除目标页要明确清除引用。使用null保留关闭意图，避免自动改指另一张页面。
    setPages(current => current.filter(item => item.key !== pageKey).map(item => ({
      ...item, sections: item.sections.map(section => section.cta?.pageKey === pageKey ? { ...section, cta: null } : section),
    })));
    setPageKey(pages[index + 1]?.key || pages[index - 1].key);
  }
  function close() {
    guard.ask(onClose);
  }
  async function save() {
    setError('');
    try {
      // 新页的可选文案为空时从用户给出的标题、首段文字回填，不生成新的业务事实。
      const withDefaults = pages.map(item => {
        if (plan.pages.some(original => original.key === item.key)) return item;
        const lead = item.sections[0];
        return {
          ...item, purpose: item.purpose.trim() || item.title, seoTitle: item.seoTitle.trim() || item.title,
          seoDescription: item.seoDescription.trim() || lead.body.trim().slice(0, 1000) || item.title,
          sections: [{ ...lead, heading: lead.heading.trim() || item.title }, ...item.sections.slice(1)],
        };
      });
      const validated = normalizeAiSitePlan({ ...plan, pages: withDefaults }, brief);
      await onSave(validated.pages);
      guard.clear();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '方案修改未保存，请核对输入后再试。');
    }
  }

  return <>{guard.dialog}<Drawer open title="修改建站方案" width="min(760px, 100vw)" onClose={close} maskClosable={false} closable={!saving}
    footer={<Flex justify="end" gap={8} wrap><Button disabled={saving} onClick={close}>取消</Button><Button type="primary" loading={saving} onClick={() => void save()}>保存方案修改</Button></Flex>}>
    <Space orientation="vertical" size={18} style={{ width: '100%' }}>
      <Text type="secondary">先选择页面，再编辑文案和按钮。保存后可重新预览，整个修改过程不消耗模型额度。</Text>
      {recovery && <Alert type="info" showIcon title="已恢复这个方案的未保存修改" />}
      {error && <div ref={errorSummary} tabIndex={-1}><Alert type="error" showIcon title={error} /></div>}
      <Form layout="vertical" disabled={saving} onFinish={() => void save()}>
        <Form.Item label="编辑页面" help="页面顺序会同步到网站导航。">
          <Select aria-label="编辑页面" value={pageKey} options={pages.map(item => ({ value: item.key, label: `${item.title || '新页面'} · ${item.path || '未填写网址'}` }))} onChange={setPageKey} />
        </Form.Item>
        <Flex gap={8} wrap style={{ marginBottom: 20 }}>
          <Button icon={<PlusOutlined />} disabled={pages.length >= 8} onClick={addPage}>新增页面</Button>
          <Button icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => movePage(-1)}>上移页面</Button>
          <Button icon={<ArrowDownOutlined />} disabled={index === pages.length - 1} onClick={() => movePage(1)}>下移页面</Button>
          <Popconfirm disabled={cannotRemovePage} title="移除此页面？" description={inboundButtons ? `其他页面有 ${inboundButtons} 个按钮指向这里，移除后会隐藏这些按钮。` : undefined} okText="移除页面" cancelText="保留页面" onConfirm={removePage}>
            <Button danger disabled={cannotRemovePage}>移除页面</Button>
          </Popconfirm>
        </Flex>
        <div key={pageKey}>
          <PlanField label="页面名称" value={page.title} required maxLength={120} onChange={title => updatePage({ title })} />
          <PlanField label="页面网址" value={page.path} required maxLength={120} disabled={fixedPath} placeholder="/quality" error={pathError} onChange={path => updatePage({ path })} />
          <Collapse items={[{
            key: 'seo', label: '页面用途与搜索设置',
            children: <>
              <PlanField label="页面用途" value={page.purpose} required={Boolean(parentPage)} maxLength={1000} onChange={purpose => updatePage({ purpose })} />
              <PlanField label="搜索标题" value={page.seoTitle} required={Boolean(parentPage)} maxLength={200} onChange={seoTitle => updatePage({ seoTitle })} />
              <PlanField label="搜索说明" value={page.seoDescription} required={Boolean(parentPage)} maxLength={1000} multiline onChange={seoDescription => updatePage({ seoDescription })} />
            </>,
          }]} />
          <Typography.Title level={5}>页面内容与按钮</Typography.Title>
          <Collapse defaultActiveKey={['section-0']} items={page.sections.map((section, sectionIndex) => {
            const kind = sectionNames[section.kind];
            const action = section.cta === undefined ? 'automatic' : section.cta === null ? 'hidden' : 'custom';
            const keepContact = page.path === '/contact' && section.kind === 'contact' && page.sections.filter(item => item.kind === 'contact').length === 1;
            const keepCatalogue = lastCatalogue && section.kind === 'products' && page.sections.filter(item => item.kind === 'products').length === 1;
            const changeMode = (mode: string) => {
              const contact = buttonTargets.find(item => item.path === '/contact') || buttonTargets[0];
              updateSection(sectionIndex, { cta: mode === 'automatic' ? undefined : mode === 'hidden' ? null : { label: contact?.title || '联系我们', pageKey: contact?.key || '' } });
            };
            return {
              key: `section-${sectionIndex}`,
              label: <Text ellipsis title={section.heading}>{kind} · {section.heading || '未填写标题'}</Text>,
              children: <>
                <PlanField label="区块标题" value={section.heading} required={Boolean(parentPage) || sectionIndex > 0} maxLength={180} onChange={heading => updateSection(sectionIndex, { heading })} />
                <PlanField label="区块文案" value={section.body} maxLength={4000} multiline onChange={body => updateSection(sectionIndex, { body })} />
                {/* 长期方案保留原选择。素材被删除后，允许只移除失效引用，保留已核对的内容。 */}
                {section.mediaId && !imageIds.has(section.mediaId) && <Alert type="warning" showIcon title="这个区块引用的图片已不可用" action={<Button size="small" onClick={() => updateSection(sectionIndex, { mediaId: undefined })}>移除失效图片</Button>} />}
                {section.items?.map((item, itemIndex) => <div key={itemIndex}>
                  <PlanField label={`条目 ${itemIndex + 1} 标题`} value={item.title} required maxLength={120} onChange={title => updateSection(sectionIndex, { items: section.items?.map((entry, i) => i === itemIndex ? { ...entry, title } : entry) })} />
                  <PlanField label={`条目 ${itemIndex + 1} 文案`} value={item.body} maxLength={1500} multiline onChange={body => updateSection(sectionIndex, { items: section.items?.map((entry, i) => i === itemIndex ? { ...entry, body } : entry) })} />
                  <Button type="link" danger disabled={section.kind === 'features' && section.items?.length === 1} onClick={() => {
                    const entries = section.items?.filter((_, i) => itemIndex !== i);
                    updateSection(sectionIndex, { items: entries?.length ? entries : undefined });
                  }}>移除此条目</Button>
                </div>)}
                {(section.kind === 'features' || Boolean(section.items?.length)) && <Button size="small" type="dashed" disabled={(section.items?.length || 0) >= 6} onClick={() => updateSection(sectionIndex, { items: [...(section.items || []), { title: '', body: '' }] })}>新增特点条目</Button>}
                <Form.Item label="区块按钮" style={{ marginTop: 16 }}>
                  <Segmented aria-label="区块按钮" value={action} options={[
                    { value: 'automatic', label: '默认' }, { value: 'custom', label: '自定义' }, { value: 'hidden', label: '隐藏' },
                  ]} onChange={changeMode} />
                </Form.Item>
                {section.cta && <>
                  <PlanField label="按钮文案" value={section.cta.label} required maxLength={80} onChange={label => updateSection(sectionIndex, { cta: { ...section.cta!, label } })} />
                  <Form.Item label="按钮目标页面" required>
                    <Select aria-label="按钮目标页面" value={section.cta.pageKey} options={targetOptions} onChange={pageKey => updateSection(sectionIndex, { cta: { ...section.cta!, pageKey } })} />
                  </Form.Item>
                </>}
                {sectionIndex > 0 && !keepContact && !keepCatalogue && <Button danger onClick={() => updatePage({ sections: page.sections.filter((_, i) => i !== sectionIndex) })}>移除区块</Button>}
              </>,
            };
          })} />
          <Flex gap={8} wrap style={{ marginTop: 12 }}>
            <Button type="dashed" disabled={page.sections.length >= 8} icon={<PlusOutlined />} onClick={() => updatePage({ sections: [...page.sections, { kind: 'text', heading: '', body: '' }] })}>新增文字区块</Button>
            <Button type="dashed" disabled={page.sections.length >= 8} icon={<PlusOutlined />} onClick={() => updatePage({ sections: [...page.sections, { kind: 'features', heading: '', body: '', items: [{ title: '', body: '' }] }] })}>新增特点区块</Button>
          </Flex>
        </div>
      </Form>
    </Space>
  </Drawer></>;
}
