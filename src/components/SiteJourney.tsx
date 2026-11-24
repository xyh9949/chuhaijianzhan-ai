'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, Flex, Grid, List, Select, Space, Steps, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, EditOutlined, EyeOutlined, FileTextOutlined, ReloadOutlined, SettingOutlined, ThunderboltOutlined, UploadOutlined } from '@ant-design/icons';
import type { Screen, ScreenProps } from '@/lib/types';
import { request, useStudioRuntime } from '@/lib/studio-client';
import { SITE_JOURNEY_STEPS, deriveSiteJourneyFacts, type SiteJourneyIntent, type SiteJourneyStep } from '@/lib/site-journey';
import type { AiBuildRunsResponse } from '@/lib/ai-build-resume-types';
import type { SeoDiagnosticReport } from '@/lib/seo-types';
import './site-journey.css';
import { useAiSettings } from './AiProviderSettings';
import LaunchCheck from './LaunchCheck';

const { Title, Paragraph, Text } = Typography;
type Props = ScreenProps & {
  onStep: (step: SiteJourneyStep) => void;
  onTask: (action: SiteJourneyIntent['action'], runId?: string) => void;
  onScreen: (screen: Screen, step?: SiteJourneyStep) => void;
  onSelectPage: (id: string) => void;
  onEdit: (id: string, ai?: boolean) => void;
  onPreview: (id: string) => void;
  onPublish: () => void;
  onPause: () => void;
};
type ProviderState = { enabled: boolean; model: string };

/** 流程只串联已存在的动作；阶段位置不等同于AI已生成、内容已审核或网站已上线。 */
export default function SiteJourney(props: Props) {
  const { state, journey, onStep, onTask, onScreen, onSelectPage, onEdit, onPreview, onPublish, onPause } = props;
  const aiSettings = useAiSettings();
  const runtime = useStudioRuntime(), screens = Grid.useBreakpoint();
  const [provider, setProvider] = useState<ProviderState>();
  const [runs, setRuns] = useState<AiBuildRunsResponse>();
  const [readErrors, setReadErrors] = useState<string[]>([]), [loading, setLoading] = useState(false);
  const [diagnostic, setDiagnostic] = useState<SeoDiagnosticReport & { revision: number }>();
  const [seoBusy, setSeoBusy] = useState(false), [seoError, setSeoError] = useState('');
  const facts = deriveSiteJourneyFacts(state), step = journey?.session.step || 'materials';
  const position = SITE_JOURNEY_STEPS.findIndex(item => item.key === step);
  const pageId = facts.editablePages.some(page => page.id === journey?.session.pageId) ? journey?.session.pageId : facts.preferredPageId;
  const currentRelease = state.releases.find(item => item.id === facts.currentReleaseId);
  const localSeoCurrent = diagnostic?.revision === runtime.envelope.revision && runtime.saveState === 'saved' && !runtime.isMutating;

  useEffect(() => {
    let live = true; setLoading(true);
    // 打开流程或全站配置保存后只读本机状态和本人记录，不测试连接或调用模型。
    Promise.allSettled([request<ProviderState>('/api/ai/provider'), request<AiBuildRunsResponse>('/api/ai/build/runs')]).then(results => {
      if (!live) return;
      if (results[0].status === 'fulfilled') setProvider(results[0].value);
      if (results[1].status === 'fulfilled') setRuns(results[1].value);
      setReadErrors(results.flatMap((result, index) => result.status === 'rejected' ? [index === 0 ? 'AI配置状态暂时未读到，可进入原配置页查看。' : '最近方案暂时未读到，可稍后刷新；不会重新生成。'] : []));
      setLoading(false);
    });
    return () => { live = false; };
  }, [aiSettings.changeVersion]);

  async function checkSeo() {
    if (seoBusy) return; setSeoBusy(true); setSeoError('');
    // 用户主动检查前先完成其已有保存；未落库的本地变化不能被标成已检查。
    try { await runtime.flush(); setDiagnostic(await request<SeoDiagnosticReport & { revision: number }>('/api/seo/diagnostics')); }
    catch (error) { setSeoError(error instanceof Error ? error.message : '检查暂未完成，请重试'); }
    finally { setSeoBusy(false); }
  }
  const cardStyles = { body: { padding: screens.md ? 24 : 16 } };
  const recentRuns = runs?.items.filter(item => item.appliedRevision === null).slice(0, 4) || [];
  // 只把确实仍可读取的上次记录作为继续入口；即使AI现已关闭，读取已有结果也无需重新配置或付费。
  const lastRun = runs?.items.find(item => item.id === journey?.session.runId && item.appliedRevision === null);
  const pagePicker = <Select aria-label="流程中要编辑的页面" value={pageId || undefined} placeholder="选择要编辑的页面" style={{ width: '100%' }} options={facts.editablePages.map(page => ({ value: page.id, label: `${page.title} · ${page.slug}` }))} onChange={onSelectPage} />;
  const controls = <div className="site-journey-step-actions"><Button disabled={position === 0} icon={<ArrowLeftOutlined />} onClick={() => onStep(SITE_JOURNEY_STEPS[Math.max(0, position - 1)].key)}>上一步</Button>{position < 4 && <Button onClick={() => onStep(SITE_JOURNEY_STEPS[position + 1].key)}>下一步：{SITE_JOURNEY_STEPS[position + 1].title} <ArrowRightOutlined /></Button>}</div>;

  return <section className="site-journey">
    <header className="page-heading"><div><Text type="secondary">从资料到可编辑的网站</Text><Title level={2}>建站流程</Title><Paragraph type="secondary">按自己的进度完成五件事。可以返回修改，也可以继续维护已有网站。</Paragraph></div><Button onClick={onPause}>暂停引导，返回工作台</Button></header>
    <Card styles={cardStyles}><Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {screens.md ? <Steps size="small" current={position} onChange={index => onStep(SITE_JOURNEY_STEPS[index].key)} items={SITE_JOURNEY_STEPS.map(item => ({ title: item.title, status: item.key === step ? 'process' : 'wait' }))} /> : <Select aria-label="建站步骤" value={step} options={SITE_JOURNEY_STEPS.map((item, index) => ({ value: item.key, label: `${index + 1}. ${item.title}` }))} onChange={onStep} style={{ width: '100%' }} />}
      <Text type="secondary">当前第{position + 1}步。这里只记录你正在做哪一步，不会替你执行导入、生成、采用或发布。</Text>
    </Space></Card>
    <div className="site-journey-facts" aria-label="当前网站真实资料"><span><strong>{facts.editablePages.length}</strong>个普通页面</span><span><strong>{facts.products}</strong>个产品</span><span><strong>{facts.images}</strong>项图片素材</span><span>{facts.currentReleaseId ? '已有公开版本' : '尚未发布'}</span></div>
    {readErrors.map(error => <Alert key={error} showIcon type="warning" title={error} />)}

    {step === 'materials' && <Card styles={cardStyles} title="1. 准备真实的公司与业务资料">
      <Space orientation="vertical" size={20} style={{ width: '100%' }}>
        <Paragraph>有公司PDF或产品Excel，可以先提取、核对并带入建站表单；没有文件也能直接填写。服务公司可以只提供服务范围和沟通目标。上传和本机提取不调用AI，整理建议与导入结果都需要你确认。</Paragraph>
        <Flex gap={12} wrap><Button type="primary" icon={<UploadOutlined />} onClick={() => onTask('import')}>上传PDF / Excel并核对</Button><Button icon={<FileTextOutlined />} onClick={() => onTask('brief')}>直接填写企业资料</Button></Flex>
        <Alert type="info" showIcon title="先准备内容，再考虑接口" description="AI服务由你选择和配置，没有内置账号或额度。暂时不配AI也能整理产品、上传图片，并用案例或手工搭建。" />
        <Flex gap={12} wrap><Button icon={<SettingOutlined />} onClick={aiSettings.open}>AI服务设置</Button><Button onClick={() => onScreen('products', 'materials')}>维护产品与图片</Button><Button onClick={() => onScreen('media', 'materials')}>打开素材中心</Button></Flex>
        <Text type="secondary">PDF提取内容不代表事实已核实；扫描件需先OCR。Excel核对并确认后保存为普通产品草稿，产品照片可在产品管理直接上传。</Text>
      </Space>
    </Card>}

    {step === 'generate' && <Card styles={cardStyles} title="2. 选择自己的建站方式">
      <Space orientation="vertical" size={20} style={{ width: '100%' }}>
        <Flex gap={8} wrap align="center"><Text strong>自己的AI服务</Text><Tag color={provider?.enabled ? 'green' : 'default'}>{loading ? '正在读取' : !provider ? '暂未读到状态' : provider.enabled ? '已启用' : '未启用'}</Tag><Text type="secondary">启用状态不代表连接测试或生成效果已经通过。</Text></Flex>
        <Paragraph>填写资料后，让自己的AI提出整站方案；核对内容并选择设计方向，再预览并确认保存。结果由普通页面和组件组成，可以继续拖拽编辑。</Paragraph>
        <Flex gap={12} wrap><Button type="primary" icon={<ThunderboltOutlined />} onClick={() => lastRun ? onTask('resume', lastRun.id) : provider?.enabled ? onTask('brief') : aiSettings.open()}>{lastRun ? '继续上次查看的方案' : provider?.enabled ? '填写资料并准备整站方案' : !provider ? '查看AI服务设置' : '先设置AI服务'}</Button>{lastRun && <Button onClick={() => onTask('brief')}>重新填写另一套资料</Button>}<Button onClick={() => onTask('examples')}>不用AI，选用整站案例</Button><Button onClick={() => onScreen('pages', 'edit')}>手工创建或编辑页面</Button></Flex>
        <Alert type="info" showIcon title="已有网站也可以继续完善" description="生成另一套草稿时会保留已有内容，网址冲突会提示。模型仅在你主动点击生成时调用，预览和恢复已有方案不会重新消耗模型额度。" />
        <div><Text strong>最近可继续查看的方案</Text>{recentRuns.length ? <List dataSource={recentRuns} renderItem={item => <List.Item actions={[<Button key="resume" size="small" onClick={() => onTask('resume', item.id)}>继续查看</Button>]}><List.Item.Meta title={item.kind === 'plan' ? '整站规划 · 查看设计方向' : '网站预览 · 核对后再确认'} description={`有效至${new Date(item.expiresAt).toLocaleString()}${item.baseRevision !== runtime.envelope.revision ? ' · 网站草稿已有变化，打开后需重新核对' : ''}`} /></List.Item>} /> : <Paragraph type="secondary">{loading ? '正在读取本人记录…' : !runs ? '最近方案暂时未读到，可稍后刷新，或进入AI建站读取本人记录；不会自动重新生成。' : '暂无未过期记录。生成记录保留40分钟；过期后输入可恢复，是否重新生成由你决定。'}</Paragraph>}</div>
      </Space>
    </Card>}

    {step === 'edit' && <Card styles={cardStyles} title="3. 把草稿改成真正属于你的网站">
      <Space orientation="vertical" size={20} style={{ width: '100%' }}>
        <Paragraph>选择一个页面，在原编辑器里改文字、换图片、拖拽布局，并分别核对桌面、平板和手机效果。AI局部调整是可选帮助，同样要先预览再采用。</Paragraph>
        {pagePicker}
        <Flex gap={12} wrap><Button type="primary" icon={<EditOutlined />} disabled={!pageId} onClick={() => pageId && onEdit(pageId)}>打开拖拽编辑器</Button><Button disabled={!pageId || !provider?.enabled} onClick={() => pageId && onEdit(pageId, true)}>用自己的AI调整这页</Button><Button disabled={!pageId} icon={<EyeOutlined />} onClick={() => pageId && onPreview(pageId)}>预览草稿</Button></Flex>
        <Alert type="info" showIcon title="先核对事实和使用体验" description="检查公司名称、产品参数、图片版权、联系方式和手机端排版。原编辑器的返回流程与搜索检查按钮会先保存当前画布；保存失败时留在原页。" />
        {!provider?.enabled && <Text type="secondary">没有AI也能完成全部手工编辑；需要局部建议时再配置自己的服务。</Text>}
        <Button onClick={() => onScreen('pages', 'edit')}>打开页面管理（含详情模板）</Button>
        <Button onClick={() => onTask('resume', journey?.session.runId)}>查看建站记录与撤销状态</Button>
      </Space>
    </Card>}

    {step === 'seo' && <Card styles={cardStyles} title="4. 先做好本地搜索检查">
      <Space orientation="vertical" size={20} style={{ width: '100%' }}>
        <Paragraph>先检查标题、介绍、图片说明和站内入口。Google与关键词接口属于可选的数据参考，没有这些接口也能检查当前草稿并手动准备优化。</Paragraph>
        <Flex gap={12} wrap><Button type="primary" onClick={() => onScreen('seo', 'seo')}>打开搜索检查与优化</Button><Button icon={<ReloadOutlined />} loading={seoBusy} onClick={() => void checkSeo()}>在此检查当前草稿（不调用AI）</Button></Flex>
        {seoError && <Alert type="error" showIcon title={seoError} />}
        {diagnostic && <Alert type={localSeoCurrent ? 'info' : 'warning'} showIcon title={localSeoCurrent ? `本次已检查${diagnostic.coverage.checkedTargets}项内容，发现${diagnostic.issues.filter(item => item.severity !== 'info').length}项待核对` : '网站草稿已变化，请重新检查'} description={`检查针对草稿，未代表公开网站已更新或已收录。${diagnostic.coverage.truncated ? '本次为部分检查范围。' : ''}`} />}
        {diagnostic && localSeoCurrent && <List size="small" dataSource={diagnostic.issues.filter(item => item.severity !== 'info').slice(0, 3)} renderItem={item => <List.Item>{item.message}</List.Item>} />}
        <Alert type="info" showIcon title="接口由你配置，修改由你确认" description="在搜索优化中可接自己的Google Search Console、关键词账号或CSV；AI建议也使用自己的模型。标题和介绍修改先预览确认，采用后7天内可安全撤销，不自动发布。" />
      </Space>
    </Card>}

    {step === 'publish' && <Card styles={cardStyles} title="5. 检查范围，再亲自确认发布">
      <Space orientation="vertical" size={20} style={{ width: '100%' }}>
        {facts.currentReleaseId && <Alert type="success" showIcon title={`已有公开版本${currentRelease?.title ? `：${currentRelease.title}` : ''}`} description="这不表示当前草稿全部公开。新改动仍需按实际范围检查并确认发布；域名、证书和搜索引擎收录需另外核实。" />}
        <LaunchCheck embedded navigate={screen => onScreen(screen, 'publish')} />
        <Paragraph>当前有{facts.draftPageCount}个页面草稿（含详情模板）。选择要发布的页面、产品和全站资料，系统会检查引用与依赖；检查通过后，还需要你点击确认发布。</Paragraph>
        <Flex gap={12} wrap><Button type="primary" onClick={onPublish}>选择范围并开始发布检查</Button><Button icon={<EyeOutlined />} disabled={!pageId} onClick={() => pageId && onPreview(pageId)}>先预览草稿</Button>{facts.currentReleaseId && <Button href="/" target="_blank" rel="noopener noreferrer">查看当前公开版本</Button>}</Flex>
        <Alert type="info" showIcon title="保存草稿与发布是两步" description="流程不会替你发布或开通外部服务。公开版本由原发布管理维护；有错误可返回修复，也可以按原机制切换历史版本。" />
        <Button onClick={() => onScreen('releases', 'publish')}>打开发布历史</Button>
      </Space>
    </Card>}
    {controls}
    <Text type="secondary">当前步骤只在本浏览器标签页按账号记住。企业资料、AI结果和搜索报告沿用各自的原有保存与期限，不进入步骤存储。</Text>
  </section>;
}

/** 普通管理页保留返回位置；编辑器使用自己的顶栏保存路径，避免撑破100dvh画布。 */
export function SiteJourneyReturn({ step, onReturn, onNext }: { step: SiteJourneyStep; onReturn: () => void; onNext: () => void }) {
  const index = SITE_JOURNEY_STEPS.findIndex(item => item.key === step);
  return <Card size="small" className="site-journey-return"><Flex justify="space-between" align="center" gap={12} wrap><Space wrap><Tag color="blue">建站流程</Tag><Text>{SITE_JOURNEY_STEPS[index].title}</Text><Text type="secondary">操作完成后，可回到流程继续。</Text></Space><Space wrap><Button onClick={onReturn}>返回建站流程</Button>{index < 4 && <Button onClick={onNext}>下一步：{SITE_JOURNEY_STEPS[index + 1].title}</Button>}</Space></Flex></Card>;
}
