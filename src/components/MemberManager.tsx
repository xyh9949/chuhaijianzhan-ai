"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import { LockOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { Actor, Role } from "@/server/permissions";
import { request } from "@/lib/studio-client";

type Member = Actor & { disabled: boolean; createdAt: number | string };
type MemberForm = { name: string; email: string; role: Role; password?: string };
const roles = [{ value: "admin", label: "管理员" }, { value: "editor", label: "编辑者" }, { value: "viewer", label: "只读成员" }];
const roleNames = { admin: "管理员", editor: "编辑者", viewer: "只读成员" };
const passwordRules = [{ required: true, message: "请输入密码" }, { min: 12, max: 128, message: "密码需为 12 至 128 个字符" }];

export function AccountSecurity() {
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string; confirmPassword: string }>();
  const [saving, setSaving] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  async function save() {
    try {
      const values = await form.validateFields();
      setSaving(true);
      // 本人改密要求原密码，库负责更新凭据并撤销其他设备会话。
      await request("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword, revokeOtherSessions: true }) });
      form.resetFields();
      messageApi.success("密码已修改，其他设备的登录会话已退出");
    } catch (error) {
      if (error instanceof Error) messageApi.error(error.message);
    } finally { setSaving(false); }
  }
  return <div>
    {contextHolder}
    <Alert type="info" showIcon title="账户安全" description="修改自己的密码需要验证当前密码。系统不会通过邮件发送或重置密码。" style={{ marginBottom: 20 }} />
    <Form form={form} layout="vertical" style={{ maxWidth: 480 }}>
      <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}><Input.Password autoComplete="current-password" /></Form.Item>
      <Form.Item name="newPassword" label="新密码" rules={passwordRules}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      <Form.Item name="confirmPassword" label="再次输入新密码" dependencies={["newPassword"]} rules={[{ required: true, message: "请再次输入新密码" }, ({ getFieldValue }) => ({ validator: (_, value) => value === getFieldValue("newPassword") ? Promise.resolve() : Promise.reject(new Error("两次密码不一致")) })]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      <Button type="primary" icon={<LockOutlined />} loading={saving} onClick={() => { void save(); }}>更新密码</Button>
    </Form>
  </div>;
}

export default function MemberManager() {
  const [members, setMembers] = useState<Member[]>([]);
  const [actor, setActor] = useState<Actor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Member | null>(null);
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState<Member | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<MemberForm>();
  const [passwordForm] = Form.useForm<{ password: string }>();
  const [messageApi, contextHolder] = message.useMessage();

  async function load() {
    setLoading(true); setError("");
    try {
      const me = await request<{ actor: Actor }>("/api/members/me");
      setActor(me.actor);
      if (me.actor.role !== "admin") { setMembers([]); return; }
      setMembers((await request<{ members: Member[] }>("/api/members")).members);
    } catch (cause) { setActor(null); setMembers([]); setError(cause instanceof Error ? cause.message : "成员加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  function edit(member?: Member) {
    setEditing(member ?? null);
    form.resetFields();
    form.setFieldsValue(member ? { name: member.name, email: member.email, role: member.role } : { role: "editor" });
    setOpen(true);
  }

  async function save() {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await request(editing ? `/api/members/${editing.id}` : "/api/members", { method: editing ? "PATCH" : "POST", body: JSON.stringify(editing ? { name: values.name, role: values.role } : values) });
      setOpen(false); form.resetFields();
      messageApi.success(editing ? "成员资料已更新；角色变化会使其原会话失效" : "成员已创建，可使用所设密码登录；未发送邀请邮件");
      await load();
    } catch (cause) { if (cause instanceof Error) messageApi.error(cause.message); }
    finally { setSaving(false); }
  }

  async function toggle(member: Member) {
    try {
      await request(`/api/members/${member.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !member.disabled }) });
      messageApi.success(member.disabled ? "成员已启用，可以重新登录" : "成员已停用，旧会话已撤销");
      await load();
    } catch (cause) { messageApi.error(cause instanceof Error ? cause.message : "状态更新失败"); }
  }

  async function resetPassword() {
    if (!resetting) return;
    try {
      const values = await passwordForm.validateFields();
      setSaving(true);
      await request(`/api/members/${resetting.id}/password`, { method: "POST", body: JSON.stringify(values) });
      setResetting(null); passwordForm.resetFields();
      messageApi.success("密码已重置，该成员的旧会话已退出；未发送邮件");
    } catch (cause) { if (cause instanceof Error) messageApi.error(cause.message); }
    finally { setSaving(false); }
  }

  return <div>
    {contextHolder}
    <Space orientation="vertical" size={20} style={{ width: "100%" }}>
      <Alert type="info" showIcon title="成员权限" description="管理员管理成员、设置与发布；编辑者可编辑内容；只读成员只能查看。至少保留一名可用管理员。" />
      {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => { void load(); }}>重试</Button>} />}
      {actor && actor.role !== "admin" ? <Alert type="warning" title="只有管理员可以管理成员；你仍可在下方修改自己的密码。" /> : <>
        <Space wrap><Button type="primary" icon={<PlusOutlined />} onClick={() => edit()} disabled={!actor}>新建成员</Button><Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void load(); }}>刷新</Button></Space>
        <Table<Member> rowKey="id" loading={loading} dataSource={members} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 720 }} columns={[
          { title: "成员", key: "member", render: (_, member) => <div><Typography.Text strong>{member.name}{member.id === actor?.id ? "（我）" : ""}</Typography.Text><div><Typography.Text type="secondary">{member.email}</Typography.Text></div></div> },
          { title: "角色", dataIndex: "role", width: 110, render: (role: Role) => roleNames[role] },
          { title: "状态", dataIndex: "disabled", width: 100, render: (disabled: boolean) => <Tag color={disabled ? "default" : "green"}>{disabled ? "已停用" : "正常"}</Tag> },
          { title: "操作", key: "actions", width: 260, render: (_, member) => <Space size={0} wrap><Button type="link" onClick={() => edit(member)}>编辑</Button><Popconfirm title={member.disabled ? "启用该成员？" : "停用该成员并退出其所有设备？"} onConfirm={() => toggle(member)} okText="确认" cancelText="取消"><Button type="link" danger={!member.disabled}>{member.disabled ? "启用" : "停用"}</Button></Popconfirm><Button type="link" disabled={member.id === actor?.id} onClick={() => { passwordForm.resetFields(); setResetting(member); }}>重置密码</Button></Space> },
        ]} />
      </>}
      <AccountSecurity />
    </Space>
    <Modal title={editing ? "编辑成员" : "新建成员"} open={open} confirmLoading={saving} onOk={() => { void save(); }} onCancel={() => { setOpen(false); form.resetFields(); }} okText="保存" cancelText="取消">
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="姓名" rules={[{ required: true, whitespace: true, message: "请输入姓名" }, { max: 100, message: "姓名最多 100 个字符" }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="email" label="登录邮箱" rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}><Input disabled={Boolean(editing)} autoComplete="off" /></Form.Item>
        <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}><Select options={roles} /></Form.Item>
        {!editing && <Form.Item name="password" label="初始密码" rules={passwordRules} extra="不会发送邮件，请通过可信渠道将账号信息交给成员。"><Input.Password maxLength={128} autoComplete="new-password" /></Form.Item>}
      </Form>
    </Modal>
    <Modal title={`重置 ${resetting?.name ?? ""} 的密码`} open={Boolean(resetting)} confirmLoading={saving} onOk={() => { void resetPassword(); }} onCancel={() => { setResetting(null); passwordForm.resetFields(); }} okText="重置密码" cancelText="取消">
      <Form form={passwordForm} layout="vertical"><Form.Item name="password" label="新密码" rules={passwordRules} extra="重置后该成员所有旧会话立即退出。"><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item></Form>
    </Modal>
  </div>;
}
