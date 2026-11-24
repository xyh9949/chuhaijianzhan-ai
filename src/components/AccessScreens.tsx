"use client";

import { useRef, useState } from "react";
import {
  Alert, App, Button, Card, Descriptions, Form, Image, Input,
  Radio, Select, Steps, Tag, Typography,
} from "antd";
import {
  ArrowLeftOutlined, ArrowRightOutlined, CheckCircleFilled, CheckOutlined,
  FileTextOutlined, LayoutOutlined, LockOutlined, MailOutlined,
  PlusOutlined, SafetyOutlined,
} from "@ant-design/icons";
import type { PageItem, ScreenProps } from "../lib/types";
import { createPageData } from "../lib/page-data";
import "./access.css";
import { request, RequestError } from "@/lib/studio-client";

const { Text } = Typography;

export function AccessBrand({ light = false }: { light?: boolean }) {
  return <div className={`as-brand${light ? " is-light" : ""}`} aria-label="Form Studio">
    <span className="as-brand-symbol" aria-hidden="true"><i /><i /><i /><i /></span>
    <span>Form Studio</span>
  </div>;
}

export function LoginScreen({ onLoggedIn, onForgotPassword }: { onLoggedIn: () => Promise<void>; onForgotPassword?: () => void }) {
  const [form] = Form.useForm<{ email: string; password: string }>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const { message } = App.useApp();
  async function signIn() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      // 密码只交给认证服务；会话由 HttpOnly Cookie 管理。
      await request('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ ...values, rememberMe: true }) });
      await onLoggedIn(); form.resetFields();
    } catch (error) {
      // 账号不存在与密码不正确使用同一提示，不暴露账号是否已注册。
      if (error instanceof RequestError && error.status === 401) message.error('邮箱或密码不正确');
      else if (error instanceof RequestError && error.status === 429) message.error('尝试次数过多，请稍后再试');
      else if (error instanceof Error) message.error(error.message);
    } finally { submittingRef.current = false; setSubmitting(false); }
  }

  return <main className="as-login">
    <section className="as-login-visual" aria-label="网站管理工作区介绍">
      <div className="as-login-visual-top"><AccessBrand light /><span className="as-edition">网站管理工作区</span></div>
      <div className="as-login-story">
        <span className="as-light-eyebrow">FORM STUDIO</span>
        <h1>网站运营，<br />从这里开始。</h1>
        <p>集中维护页面、产品与站点信息，<br />让日常内容更新有条不紊。</p>
        <div className="as-login-flow">
          <div><span className="as-login-flow-icon"><FileTextOutlined /></span><div><strong>维护内容</strong><p>管理页面、产品与素材</p></div></div>
          <div><span className="as-login-flow-icon"><LayoutOutlined /></span><div><strong>调整设计</strong><p>使用可视化编辑器组织网站</p></div></div>
          <div><span className="as-login-flow-icon"><CheckCircleFilled /></span><div><strong>检查草稿</strong><p>确认变更范围，再进入发布流程</p></div></div>
        </div>
      </div>
      <div className="as-login-visual-bottom"><span>FORM STUDIO</span><span>独立网站管理</span></div>
    </section>
    <section className="as-login-panel">
      <div className="as-login-panel-top"><span>工作空间</span><Tag>安全登录</Tag></div>
      <div className="as-login-form-wrap">
        <div className="as-login-greeting">WELCOME BACK</div>
        <h2>欢迎回到工作区</h2>
        <p className="as-login-intro">继续维护内容与网站设计。</p>
        <div className="as-login-demo-note"><SafetyOutlined /><p>使用管理员为你创建的账号登录。网站草稿仅对已授权成员开放。</p></div>
        <Form disabled={submitting || undefined} form={form} layout="vertical" requiredMark={false} onFinish={signIn} className="as-login-form">
          <Form.Item name="email" label="登录邮箱" rules={[{ required: true, message: "请填写登录邮箱" }, { type: "email", message: "请输入正确的邮箱格式，例如 admin@example.com" }]}>
            <Input size="large" prefix={<MailOutlined />} placeholder="admin@example.com" autoComplete="username" aria-label="登录邮箱" />
          </Form.Item>
          <Form.Item name="password" label="登录密码" rules={[{ required: true, message: "请填写登录密码" }, { min: 12, message: "密码至少12个字符" }]}>
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="请输入账号密码" autoComplete="current-password" aria-label="登录密码" />
          </Form.Item>
          <Button className="as-login-submit" type="primary" size="large" htmlType="submit" loading={submitting} block>登录工作区 <ArrowRightOutlined /></Button>
        </Form>
        <p className="as-login-start">首次安装请在服务器运行初始化命令。{onForgotPassword && <Button type="link" disabled={submitting} onClick={onForgotPassword}>忘记密码？</Button>}</p>
      </div>
      <div className="as-login-panel-bottom"><span>仅授权成员可以访问工作区。</span><span>FORM STUDIO</span></div>
    </section>
  </main>;
}

type Starter = "blank" | "manufacturing" | "service" | "personal";
type SetupValues = { name: string; description: string; language: string };
type DemoNode = { type: string; props: { id: string; [key: string]: unknown } };
type StarterData = { root: { props: { title?: string; brand?: string; [key: string]: unknown } }; content: DemoNode[] };

const STARTERS: { id: Starter; name: string; subtitle: string; pages: string; image?: string; style: string; heading: string }[] = [
  { id: "blank", name: "从空白开始", subtitle: "每一处布局，都由你决定", pages: "1 个空白页面", style: "blank", heading: "Your next idea." },
  { id: "manufacturing", name: "制造企业", subtitle: "产品、工艺与品牌的完整表达", pages: "首页 + 关于我们", image: "/images/interior.jpg", style: "manufacturing", heading: "Thoughtfully made." },
  { id: "service", name: "服务品牌", subtitle: "清晰介绍你的专业与合作方式", pages: "首页 + 品牌介绍", image: "/images/studio.jpg", style: "service", heading: "Ideas into impact." },
  { id: "personal", name: "个人作品", subtitle: "让作品成为你的第一句话", pages: "首页 + 关于我", image: "/images/chair.jpg", style: "personal", heading: "Selected, by me." },
];
const LANGUAGE_NAMES: Record<string, string> = { en: "英语", "zh-CN": "简体中文", es: "西班牙语", de: "德语", fr: "法语" };

function StarterPreview({ item }: { item: typeof STARTERS[number] }) {
  return <div className={`as-starter-preview as-starter-${item.style}`}>
    <div className="as-starter-browser"><i /><i /><i /><span>模板示意</span></div>
    {item.id === "blank" ? <div className="as-blank-art"><span className="as-blank-plus"><PlusOutlined /></span><span>A new beginning.</span><div><i /><i /><i /></div></div> : <>
      <div className="as-starter-nav"><strong>{item.id === "personal" ? "studio /" : "your brand."}</strong><span aria-hidden="true"><i /><i /></span></div>
      <div className="as-starter-body"><div className="as-starter-text"><span aria-hidden="true" /><strong>{item.heading}</strong><i /><i /><small aria-hidden="true" /></div><Image src={item.image} alt={`${item.name}模板示意`} preview={false} /></div>
      <div className="as-starter-art-footer"><i /><i /><i /></div>
    </>}
  </div>;
}

function makeStarterData(kind: "home" | "about" | "blank", starter: Starter, settings: SetupValues, pageId: string, pageTitle: string) {
  // 此模块复用编辑器已有模板，仅扩展根节点品牌及通用内容字段。
  const data = createPageData(kind) as StarterData;
  data.root = { ...data.root, props: { ...data.root.props, title: pageTitle, brand: settings.name } };
  if (kind === "blank") return data;

  // 模板节点使用新页面ID，避免重复导入时出现冲突；原有页面数据不参与修改。
  let headingIndex = 0;
  let textIndex = 0;
  const headline = starter === "service" ? "Ideas into\nmeaningful work."
    : starter === "personal" ? "A selection of\nwhat I make."
    : "Made with care.\nDesigned for life.";
  const storyTitle = starter === "personal" ? "A little about me." : "The story behind our work.";
  function visit(nodes: DemoNode[]): DemoNode[] {
    return nodes.map((node) => {
      const props: DemoNode["props"] = { ...node.props, id: `${pageId}-${node.props.id}` };
      if (node.type === "Heading") {
        props.text = headingIndex++ === 0 ? (kind === "about" ? storyTitle : headline) : (starter === "personal" ? "Work with intention." : "Built around your ideas.");
      }
      if (node.type === "Text") {
        const index = textIndex++;
        props.text = index === 0 && kind === "home" ? settings.name.toUpperCase() : settings.description || "这是可编辑的演示内容，请替换为自己的真实介绍与资料。";
      }
      if (node.type === "ActionButton") { props.text = starter === "personal" ? "Explore my work" : "Discover more"; props.href = "#"; }
      if (node.type === "Container" && props.image && starter !== "manufacturing") props.image = starter === "service" ? "/images/studio.jpg" : "/images/chair.jpg";
      if (Array.isArray(props.content)) props.content = visit(props.content as DemoNode[]);
      return { ...node, props };
    });
  }
  data.content = visit(data.content as DemoNode[]);
  // 服务与个人模板不自动显示原工作区的家居产品，内容仍可在编辑器里自由增添。
  if (starter !== "manufacturing") data.content = data.content.filter((node) => node.type !== "ProductList");
  return data;
}

export function SetupScreen({ state, update, navigate }: ScreenProps) {
  const [step, setStep] = useState(0);
  const [starter, setStarter] = useState<Starter>("manufacturing");
  const [values, setValues] = useState<SetupValues>({ name: "", description: "", language: "en" });
  const [form] = Form.useForm<SetupValues>();
  const creating = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const target = useRef<{ homeId: string; aboutId: string; path: string } | null>(null);
  const { message } = App.useApp();
  const chosen = STARTERS.find((item) => item.id === starter)!;
  const draftCount = starter === "blank" ? 1 : 2;
  const stageTitles = ["设置站点基本信息", "选择网站起点", "确认并创建草稿"];
  const stageDescriptions = [
    "这些信息会成为网站的基本设置，之后也可以随时修改。",
    "使用空白页或已有模板，之后可在编辑器中继续调整。",
    "确认下面的设置，新内容将以草稿形式加入当前工作区。",
  ];

  // 新路径避开当前工作区所有页面，创建向导不会替换现有首页或草稿。
  let siteIndex = 1;
  while (state.pages.some((page) => page.slug === `/site-draft-${siteIndex}` || page.slug.startsWith(`/site-draft-${siteIndex}/`))) siteIndex += 1;
  const basePath = target.current?.path || `/site-draft-${siteIndex}`;

  async function nextStep() {
    if (step === 0) {
      try { const result = await form.validateFields(); setValues({ ...result, name: result.name.trim(), description: result.description?.trim() ?? "" }); setStep(1); }
      catch { /* 保留当前页，表单显示缺失项，不越过必填校验。 */ }
    } else setStep(2);
  }

  async function createDrafts() {
    if (creating.current) return;
    creating.current = true;
    setSubmitting(true);
    try {
    target.current ??= { homeId: `setup-${crypto.randomUUID()}`, aboutId: `setup-${crypto.randomUUID()}`, path: basePath };
    const { homeId, aboutId } = target.current;
    const pages: PageItem[] = [{ id: homeId, title: `${values.name} · 首页`, slug: basePath, status: "draft", type: starter === "blank" ? "blank" : "home", updated: "刚刚" }];
    const editorData = { ...state.editorData, [homeId]: makeStarterData(starter === "blank" ? "blank" : "home", starter, values, homeId, pages[0].title) };
    if (starter !== "blank") {
      const title = starter === "personal" ? "关于我" : starter === "service" ? "品牌介绍" : "关于我们";
      pages.push({ id: aboutId, title: `${values.name} · ${title}`, slug: `${basePath}/about`, status: "draft", type: "about", updated: "刚刚" });
      editorData[aboutId] = makeStarterData("about", starter, values, aboutId, title);
    }
    // 失败后允许原地重试并复用 ID；已有草稿不覆盖，成功确认前不离开向导。
    if (starter === 'blank') delete editorData[aboutId];
    await update({ settings: { ...state.settings, ...values }, pages: [...pages, ...state.pages.filter((page) => page.id !== homeId && page.id !== aboutId)], editorData, activePageId: homeId });
    message.success('站点资料与新草稿已保存');
    navigate("pages");
    } catch (error) { message.error(error instanceof Error ? error.message : '创建失败，填写内容已保留'); }
    finally { creating.current = false; setSubmitting(false); }
  }

  return <main className="as-setup">
    <header className="as-setup-top"><AccessBrand /><div><Tag>草稿工作区</Tag><Button disabled={submitting || undefined} type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("overview")}>返回工作区</Button></div></header>
    <div className="as-setup-progress"><Steps current={step} items={[{ title: "站点信息" }, { title: "选择起点" }, { title: "准备创建" }]} /></div>
    <div className="as-setup-heading"><span>创建站点草稿 · 0{step + 1}</span><h1>{stageTitles[step]}</h1><p>{stageDescriptions[step]}</p></div>
    <div className={`as-setup-content as-step-${step}`}>
      {step === 0 && <Card className="as-setup-form-card" styles={{ body: { padding: "34px 38px" } }}><Form form={form} layout="vertical" initialValues={values} requiredMark="optional">
        <Form.Item name="name" label="站点名称" rules={[{ required: true, whitespace: true, message: "请填写站点名称" }, { max: 50, message: "站点名称最多50个字符" }]}><Input size="large" maxLength={50} placeholder="例如：Morrow 家居、你的品牌或个人名字" /></Form.Item>
        <Form.Item name="description" label="一句话介绍" extra="先简单说明你是谁、提供什么，之后可以再完善。"><Input.TextArea rows={3} maxLength={240} showCount placeholder="描述你的产品、专业服务或创作方向。" /></Form.Item>
        <Form.Item name="language" label="前台默认语言" rules={[{ required: true, message: "请选择默认语言" }]}><Select size="large" options={Object.entries(LANGUAGE_NAMES).map(([value, label]) => ({ value, label }))} /></Form.Item>
        <div className="as-setup-hint"><FileTextOutlined /><span>本轮只保存语言设置，不会自动翻译已有页面内容。</span></div>
      </Form></Card>}
      {step === 1 && <><Radio.Group className="as-starter-grid" value={starter} onChange={(event) => setStarter(event.target.value as Starter)}>{STARTERS.map((item) => <Radio.Button key={item.id} value={item.id} className="as-starter-choice">
        <StarterPreview item={item} /><div className="as-starter-caption"><div><h2>{item.name}</h2><span className={`as-choice-dot${starter === item.id ? " is-active" : ""}`}>{starter === item.id && <CheckOutlined />}</span></div><p>{item.subtitle}</p><small>{item.pages}</small></div>
      </Radio.Button>)}</Radio.Group><div className="as-template-note"><LayoutOutlined /><span>模板仅创建可编辑的演示草稿。示意图片与文字都可以替换，已有页面会保留。</span></div></>}
      {step === 2 && <Card className="as-setup-confirm-card" styles={{ body: { padding: 0 } }}>
        <div className="as-confirm-banner"><span className="as-confirm-icon"><CheckCircleFilled /></span><div><h2>{values.name}</h2><p>请确认信息，创建后仍可继续编辑。</p></div><Tag>{chosen.name}</Tag></div>
        <div className="as-confirm-body"><div className="as-confirm-preview"><StarterPreview item={chosen} /></div><div className="as-confirm-details"><Descriptions column={1} colon={false} items={[
          { key: "name", label: "站点名称", children: values.name },
          { key: "description", label: "站点介绍", children: values.description || "暂未填写，可稍后完善" },
          { key: "language", label: "默认语言", children: LANGUAGE_NAMES[values.language] },
          { key: "pages", label: "新增草稿", children: `${draftCount} 个页面` },
          { key: "path", label: "草稿路径", children: <Text code>{basePath}</Text> },
        ]} /><Button disabled={submitting || undefined} type="link" onClick={() => { setStep(0); form.setFieldsValue(values); }}>修改站点信息 <ArrowRightOutlined /></Button></div></div>
        <div className="as-confirm-note"><Alert showIcon type="info" title="创建后会发生什么" description={`更新当前工作区的站点名称、介绍与默认语言，并新增${draftCount}个草稿。已有页面不会被覆盖，公开网站保持当前发布版本。`} /></div>
      </Card>}
    </div>
    <div className="as-setup-actions"><Button disabled={submitting || undefined} type="text" onClick={() => step === 0 ? navigate("overview") : setStep(step - 1)} icon={step > 0 ? <ArrowLeftOutlined /> : undefined}>{step === 0 ? "取消创建" : "上一步"}</Button><div className="as-step-counter">STEP {step + 1} OF 3</div>{step < 2 ? <Button type="primary" size="large" onClick={nextStep}>下一步 <ArrowRightOutlined /></Button> : <Button type="primary" size="large" loading={submitting} onClick={createDrafts}>创建站点草稿 <ArrowRightOutlined /></Button>}</div>
    <footer className="as-setup-footer"><span>FORM STUDIO</span><span>创建后保存到数据库；发布前仅成员可预览。</span><span>草稿工作区</span></footer>
  </main>;
}
