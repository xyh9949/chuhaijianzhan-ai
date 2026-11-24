'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, Input, Space, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, LockOutlined, MailOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { request, RequestError } from '@/lib/studio-client';
import type { AccountRecoveryAccepted, AccountRecoveryCompleted } from '@/lib/account-recovery-types';
import { PRODUCT_NAME } from '@/lib/product-brand';
import { AccessBrand } from './AccessScreens';
import './access.css';

export type AccountRecoveryEntry = { mode: 'forgot' } | { mode: 'reset'; token?: string; invalid?: boolean };

/** 入站令牌只交给当前页面内存；进入工作区、读取会话或加载其它内容之前移除敏感地址参数。 */
export function consumeAccountRecoveryLocation(): AccountRecoveryEntry | undefined {
  const url = new URL(location.href), mode = url.searchParams.get('auth');
  if (mode !== 'reset' && mode !== 'forgot') return;
  const token = url.searchParams.get('token'), invalid = Boolean(url.searchParams.get('error')) || !token || !/^[a-zA-Z0-9_-]{16,128}$/.test(token);
  for (const name of ['auth', 'token', 'error']) url.searchParams.delete(name);
  // Next可能在路由tree中保留原查询串；同步去掉历史状态里的令牌，且保留既有后台导航字段。
  let safeHistory: Record<string, unknown> = {};
  try { safeHistory = JSON.parse(JSON.stringify(history.state || {}, (_key, value) => typeof value === 'string' && token ? value.replaceAll(token, '').replaceAll(encodeURIComponent(token), '') : value)); } catch { /* 非JSON历史状态不带入恢复页。 */ }
  history.replaceState(safeHistory, '', url.pathname + url.search + url.hash);
  return mode === 'forgot' ? { mode } : { mode, ...(invalid ? { invalid: true } : { token: token! }) };
}

/** 账号恢复使用原登录视觉与原生表单；密码/令牌不进入草稿恢复、浏览器存储或普通工作区。 */
export default function AccountRecovery({ entry, onBack, onForgot }: { entry: AccountRecoveryEntry; onBack: () => void; onForgot: () => void }) {
  const { modal } = App.useApp(), [form] = Form.useForm<{ email: string; newPassword: string; confirmPassword: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState('');
  const [invalid, setInvalid] = useState(entry.mode === 'reset' && Boolean(entry.invalid)), [dirty, setDirty] = useState(false);
  const lock = useRef(false), live = useRef(true), dirtyRef = useRef(false); dirtyRef.current = dirty;
  const resetting = entry.mode === 'reset';
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (lock.current || dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload);
  }, []);
  function back() {
    if (lock.current) return;
    if (!dirty || receipt || invalid) { onBack(); return; }
    modal.confirm({ title: '放弃尚未提交的账号恢复输入？', content: '离开会清除当前输入，已经保存的账号资料不受影响。', okText: '放弃输入并返回', cancelText: '继续填写', onOk: onBack });
  }
  async function submit() {
    if (lock.current || invalid) return;
    let values: { email: string; newPassword: string; confirmPassword: string };
    try { values = await form.validateFields(); } catch { return; }
    lock.current = true; setBusy(true); setError('');
    try {
      if (resetting && entry.token) {
        const result = await request<AccountRecoveryCompleted>('/api/account-recovery/reset', { method: 'POST', body: JSON.stringify({ token: entry.token, newPassword: values.newPassword }) });
        if (live.current) { setReceipt(result.message); form.resetFields(); setDirty(false); }
      } else {
        const result = await request<AccountRecoveryAccepted>('/api/account-recovery/request', { method: 'POST', body: JSON.stringify({ email: values.email.trim() }) });
        if (live.current) { setReceipt(result.message); form.resetFields(); setDirty(false); }
      }
    } catch (cause) {
      if (live.current) {
        if (resetting && cause instanceof RequestError && cause.status === 400) { setInvalid(true); form.resetFields(); setDirty(false); setError('重置链接已过期、无效或已使用，请重新申请。'); }
        else setError(cause instanceof RequestError && cause.status === 429 ? '操作过于频繁，请稍后再试。' : cause instanceof Error ? cause.message : '请求暂未完成，请稍后再试。');
      }
    } finally { lock.current = false; if (live.current) setBusy(false); }
  }
  return <main className="as-login">
    <section className="as-login-visual" aria-label="账号恢复说明">
      <div className="as-login-visual-top"><AccessBrand light /><span className="as-edition">网站管理工作区</span></div>
      <div className="as-login-story"><span className="as-light-eyebrow">ACCOUNT RECOVERY</span><h1>重新连接，<br />继续你的工作。</h1><p>通过账号邮箱重置密码。<br />网站页面、产品和询盘保持原状。</p></div>
      <div className="as-login-visual-bottom"><span>出海建站工作区</span><span>独立网站管理</span></div>
    </section>
    <section className="as-login-panel">
      <div className="as-login-panel-top"><span>账号恢复</span><Tag>安全验证</Tag></div>
      <div className="as-login-form-wrap">
        <div className="as-login-greeting">{resetting ? 'RESET PASSWORD' : 'RECOVER ACCESS'}</div>
        <h2>{receipt && resetting ? '密码已更新' : resetting ? '设置新密码' : '找回登录密码'}</h2>
        <p className="as-login-intro">{resetting ? '重置成功后，旧登录会话会失效，请使用新密码重新登录。' : '填写账号邮箱，系统会按已配置的邮件服务处理恢复请求。'}</p>
        <Space orientation="vertical" size={20} style={{ width: '100%', marginTop: 24 }}>
          {error && <Alert type="error" showIcon title={error} />}
          {receipt ? <><Alert type="success" showIcon title={receipt} /><Button type="primary" size="large" block onClick={back}>返回登录</Button></> : invalid ? <><Alert type="warning" showIcon title="这个重置链接暂不可用" description="链接有效期为15分钟，并且只能使用一次。请重新申请恢复邮件。" /><Button type="primary" size="large" block onClick={onForgot}>重新申请恢复邮件</Button></> : <Form form={form} disabled={busy} layout="vertical" requiredMark={false} onFinish={submit} onValuesChange={() => setDirty(true)} className="as-login-form">
            {resetting ? <>
              <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请填写新密码' }, { min: 12, max: 128, message: '新密码需为12至128个字符' }]}><Input.Password size="large" prefix={<LockOutlined />} aria-label="恢复账号的新密码" autoComplete="new-password" maxLength={128} /></Form.Item>
              <Form.Item name="confirmPassword" label="再次输入新密码" dependencies={['newPassword']} rules={[{ required: true, message: '请再次输入新密码' }, ({ getFieldValue }) => ({ validator: (_, value) => !value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')) })]}><Input.Password size="large" prefix={<LockOutlined />} aria-label="再次输入恢复密码" autoComplete="new-password" maxLength={128} /></Form.Item>
            </> : <Form.Item name="email" label="账号邮箱" rules={[{ required: true, message: '请填写账号邮箱' }, { type: 'email', message: '请填写有效的邮箱地址' }]}><Input size="large" prefix={<MailOutlined />} aria-label="恢复账号的邮箱" autoComplete="username" maxLength={254} /></Form.Item>}
            <Button type="primary" size="large" block htmlType="submit" loading={busy}>{resetting ? '确认更新密码' : '申请恢复邮件'}</Button>
          </Form>}
          {!resetting && <Alert type="info" showIcon icon={<SafetyCertificateOutlined />} title="没有收到邮件？" description="先检查垃圾邮件，也可以请其他管理员重置密码。唯一管理员且邮件无法使用时，请联系服务器维护人员执行本机账号恢复。" />}
          {resetting && !receipt && <Typography.Text type="secondary">链接只用于本次密码重置，不会自动登录、修改网站内容或发布网站。</Typography.Text>}
          {!receipt && <Button icon={<ArrowLeftOutlined />} disabled={busy} onClick={back}>返回登录</Button>}
        </Space>
      </div>
      <div className="as-login-panel-bottom"><span>请勿转发密码恢复邮件。</span><span>{PRODUCT_NAME}</span></div>
    </section>
  </main>;
}
