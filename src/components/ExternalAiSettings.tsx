'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Descriptions, Empty, Flex, Form, Grid, Input, InputNumber, List, Modal, Radio, Select, Space, Tag, Typography } from 'antd';
import { DownloadOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { request, useStudioRuntime } from '@/lib/studio-client';
import type { ExternalAiTokenSummary } from '@/server/external-ai-tokens';
import { useLocalDraftGuard } from './useLocalDraftGuard';

const { Text, Paragraph } = Typography;
type CreateValues = { name: string; propose: boolean; content: boolean; seo: boolean; templates: boolean; guidance: boolean; templateRange: 'all' | 'selected'; templateIds?: string[]; range: 'all' | 'pages'; pageIds?: string[]; recordsRange: 'all' | 'selected'; productIds?: string[]; entryIds?: string[]; expiresInDays: number };
type Created = { credential: ExternalAiTokenSummary; token: string };
const when = (value: string | null) => value ? new Date(value).toLocaleString() : '尚未使用';

/** 外部连接独立授权；明文凭据只放当前弹窗内存，不进入网站资料或任何恢复存储。 */
export default function ExternalAiSettings() {
  const runtime = useStudioRuntime(), screens = Grid.useBreakpoint(), { message, modal } = App.useApp();
  const [items, setItems] = useState<ExternalAiTokenSummary[]>([]), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false), [created, setCreated] = useState<Created>();
  const [form] = Form.useForm<CreateValues>();
  const range = Form.useWatch('range', form);
  const content = Form.useWatch('content', form), seo = Form.useWatch('seo', form), templates = Form.useWatch('templates', form), templateRange = Form.useWatch('templateRange', form), recordsRange = Form.useWatch('recordsRange', form);
  const mounted = useRef(true), lock = useRef(false);
  const admin = runtime.actor.role === 'admin', endpoint = typeof location === 'undefined' ? '/api/mcp' : `${location.origin}/api/mcp`;
  // 只阻止创建/撤销进行中切走；snapshot始终为空，不把一次性密钥交给恢复机制。
  const guard = useLocalDraftGuard({ actorId: runtime.actor.id, scope: 'external-ai-connection', screen: 'settings', title: '外部AI连接', dirty: false, busy: !!busy, snapshot: {}, discard: () => {} });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function load() { const value = await request<{ items: ExternalAiTokenSummary[] }>('/api/external-ai/tokens'); if (mounted.current) setItems(value.items); }
  async function run(name: string, action: () => Promise<void>) {
    if (!admin || lock.current) return;
    lock.current = true; setBusy(name); setError('');
    try { await action(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '连接操作未完成，请稍后重试'); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  }
  useEffect(() => { if (admin) void run('读取连接', load); }, [admin]); // 只读本人连接，不因进入设置调用任何模型。
  function openCreate() { form.resetFields(); setCreateOpen(true); }
  async function create() {
    let value: CreateValues;
    try { value = await form.validateFields(); } catch { return; }
    await run('创建连接', async () => {
      // 指定范围为空时显式拒绝，不能省略pageIds而意外使用服务端的全站默认范围。
      const scopes = ['read', ...(value.propose ? ['propose'] : []), ...(value.content ? ['content:read', 'content:propose'] : []), ...(value.seo ? ['seo:read', 'seo:propose'] : []), ...(value.guidance ? ['design-guidance:read'] : [])];
      const recordIds = !value.content && !value.seo && !value.templates ? { productIds: [], entryIds: [] } : value.recordsRange === 'all' ? { productIds: null, entryIds: null } : { productIds: value.productIds || [], entryIds: value.entryIds || [] };
      const next = await request<Created>('/api/external-ai/tokens', { method: 'POST', body: JSON.stringify({ name: value.name.trim(), scopes, pageIds: value.range === 'all' ? null : value.pageIds || [], recordIds, templateIds: !value.templates ? [] : value.templateRange === 'all' ? null : value.templateIds || [], expiresInDays: value.expiresInDays }) });
      if (!mounted.current) return;
      // 先展示唯一一次明文；后续列表读取即使失败，也不能丢失本次凭据或重试创建。
      setCreated(next); setCreateOpen(false); form.resetFields();
      setItems(current => [next.credential, ...current.filter(item => item.id !== next.credential.id)]);
    });
  }
  function revoke(item: ExternalAiTokenSummary) {
    modal.confirm({ title: `撤销「${item.name}」连接？`, content: '此AI客户端将立即失去访问权限。网站草稿、已采用设计和其他连接保持。', okText: '撤销连接', cancelText: '保留连接', okButtonProps: { danger: true }, onOk: () => run(`撤销 ${item.id}`, async () => {
      const value = await request<{ credential: ExternalAiTokenSummary }>(`/api/external-ai/tokens/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      setItems(current => current.map(row => row.id === item.id ? value.credential : row)); message.success('连接已撤销');
    }) });
  }
  if (!admin) return <Alert type="info" showIcon title="仅管理员可管理外部AI连接" />;
  const bodyPadding = screens.md ? 24 : 16;
  return <>{guard.dialog}<Space orientation="vertical" size={20} style={{ width: '100%', maxWidth: 1040, minWidth: 0 }}>
    <Alert type="info" showIcon title="让你自己的AI帮助设计和写内容" description="按需授权页面与详情模板设计、文章与产品文案、搜索优化。AI只提交可预览建议，你在后台确认保存或撤销；连接不能发布网站，也不能代替你确认。旧连接不会自动获得新增权限。" />
    {error && <Alert type="error" showIcon title={error} />}
    <Card title="用网站地址连接（OAuth）"><Space orientation="vertical"><Paragraph>支持OAuth的MCP客户端填写下方地址，连接时会打开本后台，由你选择权限与页面范围。默认只允许读取选中页面；允许提交建议后，仍需在后台确认采用。</Paragraph><Text copyable>{endpoint}</Text><Text type="secondary">本机地址供同一台电脑的客户端使用；远程AI客户端需要后续部署的HTTPS域名。也可继续使用下面的独立Bearer凭据和Skill。</Text></Space></Card>
    <Card title="我的AI连接" styles={{ body: { padding: bodyPadding } }} extra={<Button type="text" icon={<ReloadOutlined aria-hidden="true" />} aria-label="刷新外部AI连接" disabled={!!busy} onClick={() => void run('读取连接', load)} />}>
      <Flex justify="space-between" align="center" gap={16} wrap style={{ marginBottom: 16 }}><Text type="secondary">每个AI客户端单独创建，随时撤销。密钥只在创建时显示一次。</Text><Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={!!busy} onClick={openCreate}>创建AI连接</Button></Flex>
      <List loading={busy === '读取连接'} dataSource={items} locale={{ emptyText: <Empty description="还没有外部AI连接" /> }} renderItem={item => {
        const expired = Date.parse(item.expiresAt) <= Date.now(), inactive = !!item.revokedAt || expired;
        return <List.Item style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }} actions={[<Button key="revoke" danger disabled={!!busy || inactive} loading={busy === `撤销 ${item.id}`} onClick={() => revoke(item)}>撤销连接</Button>]}>
          <List.Item.Meta style={{ minWidth: 180, flex: 1 }} title={<Space wrap><Text strong style={{ overflowWrap: 'anywhere' }}>{item.name}</Text><Tag>{item.revokedAt ? '已撤销' : expired ? '已过期' : '可用'}</Tag></Space>} description={<Space orientation="vertical" size={8} style={{ width: '100%' }}><Text code>{item.hint}</Text><Space wrap><Tag>读取网站</Tag>{item.scopes.includes('design-guidance:read') && <Tag color="blue">读取全站设计约定</Tag>}{item.scopes.includes('propose') && <Tag color="blue">生成设计方案</Tag>}{item.scopes.includes('content:read') && <Tag color="blue">文章与产品{item.scopes.includes('content:propose') ? '创作' : '只读'}</Tag>}{item.scopes.includes('seo:read') && <Tag color="blue">搜索优化{item.scopes.includes('seo:propose') ? '' : '只读'}</Tag>}{(item.templateIds === null || item.templateIds.length > 0) && <Tag>{item.templateIds === null ? '全部详情模板' : `${item.templateIds.length} 个详情模板`}</Tag>}<Tag>{item.pageIds === null ? '整个网站' : `${item.pageIds.length} 个指定页面`}</Tag></Space><Text type="secondary">到期：{when(item.expiresAt)} · 最近使用：{when(item.lastUsedAt)}</Text>{(item.scopes.includes('content:read') || item.scopes.includes('seo:read') || item.templateIds === null || item.templateIds.length > 0) && <Text type="secondary">产品：{item.recordIds.productIds === null ? (item.scopes.includes('content:propose') ? '全部，含新建' : '全部') : `${item.recordIds.productIds.length} 条指定记录`} · 内容：{item.recordIds.entryIds === null ? (item.scopes.includes('content:propose') ? '全部，含新建' : '全部') : `${item.recordIds.entryIds.length} 条指定记录`}</Text>}{item.pageIds !== null && <Text type="secondary" style={{ overflowWrap: 'anywhere' }}>页面：{item.pageIds.map(id => runtime.envelope.state.pages.find(page => page.id === id)?.title || '已删除页面').join('、')}</Text>}</Space>} />
        </List.Item>;
      }} />
    </Card>
    <Card title="连接到AI客户端" styles={{ body: { padding: bodyPadding } }}>
      <Space orientation="vertical" size={16} style={{ width: '100%', minWidth: 0 }}>
        <div><Text strong>MCP地址</Text><Paragraph copyable={{ text: endpoint }} style={{ marginTop: 8, marginBottom: 0, overflowWrap: 'anywhere' }}>{endpoint}</Paragraph></div>
        <Paragraph style={{ marginBottom: 0 }}>支持自定义请求头的客户端可选择 Streamable HTTP，并在客户端私密配置中设置 Authorization: Bearer 加连接密钥。此处不读取或替你配置外部AI的模型。</Paragraph>
        <Space wrap><Button icon={<DownloadOutlined aria-hidden="true" />} href="/api/external-ai/skill">下载网站助手 Skill</Button><Text type="secondary">包含设计、文章、产品文案和SEO。放到客户端的 form-studio-site-design 技能目录。</Text></Space>
        <Collapse items={[{ key: 'stdio', label: '只支持本地命令的客户端（可选）', children: <Space orientation="vertical" size={12} style={{ width: '100%' }}><Paragraph style={{ marginBottom: 0 }}>使用项目附带的 scripts/mcp-bridge.mjs。命令为 node 加此脚本的绝对路径，并在客户端私密环境中设置下面两个变量。密钥不要放进命令行、聊天记录或公开配置。</Paragraph><Descriptions column={1} size="small" items={[{ key: 'url', label: 'FORM_STUDIO_MCP_URL', children: <Text style={{ overflowWrap: 'anywhere' }}>{endpoint}</Text> }, { key: 'token', label: 'FORM_STUDIO_MCP_TOKEN', children: '创建连接时显示的密钥' }]} /><Text type="secondary">项目需已安装依赖；本机地址只对同一电脑有效。云端AI客户端需要能访问的HTTPS站点地址。当前为独立密钥连接，尚未提供OAuth自动登录。</Text></Space> }]} />
      </Space>
    </Card>
    <Modal title="创建AI连接" open={createOpen} onCancel={() => !busy && setCreateOpen(false)} onOk={() => void create()} confirmLoading={busy === '创建连接'} okText="创建连接" cancelText="取消" destroyOnHidden>
      {/* 独立Form名称让Ant生成唯一字段ID，避免label指向设置页其他仍挂载的name输入框。 */}
      <Form name="external-ai-connection-create" form={form} layout="vertical" initialValues={{ name: '', propose: true, content: false, seo: false, templates: false, guidance: false, templateRange: 'all', templateIds: [], range: 'all', pageIds: [], recordsRange: 'all', productIds: [], entryIds: [], expiresInDays: 30 }} preserve={false}>
        <Form.Item name="name" label="连接名称" rules={[{ required: true, whitespace: true, message: '填写名称，方便以后识别和撤销' }]}><Input maxLength={100} placeholder="例如：我的桌面AI助手" autoComplete="off" /></Form.Item>
        <Form.Item label="允许做什么"><Space orientation="vertical"><Checkbox checked disabled>读取授权页面</Checkbox><Form.Item name="propose" valuePropName="checked" noStyle><Checkbox>生成可预览的设计方案</Checkbox></Form.Item><Form.Item name="guidance" valuePropName="checked" noStyle><Checkbox>读取全站AI设计约定和已确认反馈</Checkbox></Form.Item><Form.Item name="templates" valuePropName="checked" noStyle><Checkbox>允许访问详情模板</Checkbox></Form.Item><Form.Item name="content" valuePropName="checked" noStyle><Checkbox>读取并创作文章、产品文案</Checkbox></Form.Item><Form.Item name="seo" valuePropName="checked" noStyle><Checkbox>读取并提交搜索优化建议</Checkbox></Form.Item><Text type="secondary">应用和撤销仍由你登录后台确认，连接不拥有此权限。</Text></Space></Form.Item>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>设计约定是独立的全站参考文字；即使只选择部分页面，勾选后也允许读取整份约定。不会因此获得其他页面、私有企业资料或修改约定的权限。</Typography.Paragraph>
        <Form.Item name="range" label="可访问范围"><Radio.Group options={[{ value: 'all', label: '整个网站' }, { value: 'pages', label: '指定页面' }]} /></Form.Item>
        {range === 'pages' && <Form.Item name="pageIds" label="选择页面" rules={[{ required: true, type: 'array', min: 1, max: 100, message: '选择1–100个页面' }]} extra="指定页面的连接不能修改全站页眉页脚、导航或默认风格。"><Select mode="multiple" aria-label="外部AI可访问页面" optionFilterProp="label" maxTagCount="responsive" options={runtime.envelope.state.pages.map(page => ({ value: page.id, label: `${page.title} · ${page.slug}` }))} /></Form.Item>}
        {templates && <><Form.Item name="templateRange" label="允许使用哪些详情模板" extra="模板会影响使用它的详情页；产品和内容的可读取范围在下方选择。"><Radio.Group options={[{ value: 'all', label: '全部详情模板' }, { value: 'selected', label: '指定模板' }]} /></Form.Item>{templateRange === 'selected' && <Form.Item name="templateIds" label="选择详情模板" rules={[{ required: true, type: 'array', min: 1, max: 1000, message: '选择至少一个详情模板' }]}><Select mode="multiple" aria-label="外部AI可访问详情模板" optionFilterProp="label" maxTagCount="responsive" options={(runtime.envelope.state.pageTemplates || []).filter(item => item.kind === 'product' || item.kind === 'entry').map(item => ({ value: item.id, label: item.name }))} /></Form.Item>}</>}{(content || seo || templates) && <><Form.Item name="recordsRange" label="可使用的产品和内容" extra="用于已授权的文案、SEO和模板预览。只有另行允许文案创作时，全部范围才包含新建；模板设计不会改动产品或文章资料。"><Radio.Group options={[{ value: 'all', label: '全部产品和内容' }, { value: 'selected', label: '指定记录' }]} /></Form.Item>{recordsRange === 'selected' && <><Form.Item name="productIds" label="选择产品"><Select mode="multiple" aria-label="外部AI可访问产品" optionFilterProp="label" maxTagCount="responsive" options={runtime.envelope.state.products.map(item => ({ value: item.id, label: item.name }))} /></Form.Item><Form.Item name="entryIds" label="选择内容" extra="留空表示不允许访问该类记录，不会自动变成全部。"><Select mode="multiple" aria-label="外部AI可访问内容" optionFilterProp="label" maxTagCount="responsive" options={(runtime.envelope.state.contentEntries || []).map(item => ({ value: item.id, label: item.title }))} /></Form.Item></>}</>}
        <Form.Item name="expiresInDays" label="多少天后到期" rules={[{ required: true, type: 'integer', min: 1, max: 365, message: '填写1–365的整数' }]}><InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="保存你的连接密钥" open={!!created} onCancel={() => setCreated(undefined)} footer={<Button type="primary" onClick={() => setCreated(undefined)}>我已保存，关闭</Button>} destroyOnHidden>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}><Alert type="warning" showIcon title="仅显示这一次" description="关闭后无法再次查看。若丢失，请撤销此连接后重新创建。" /><Text strong>{created?.credential.name}</Text><Input.Password aria-label="新创建的外部AI连接密钥" readOnly value={created?.token || ''} autoComplete="off" /><Paragraph copyable={{ text: created?.token || '' }} style={{ marginBottom: 0 }}>复制连接密钥</Paragraph><Text type="secondary">把它保存在AI客户端的私密连接配置中，不要放进网站内容或发送给其他人。</Text></Space>
    </Modal>
  </Space></>;
}
