import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';
import type { LaunchCheckAction, LaunchCheckItem, LaunchCheckKind, LaunchCheckReport, LaunchCheckRequest } from '../lib/launch-check-types';
import { diagnoseSeo } from '../lib/seo-diagnostics';
import { publicSiteOrigin } from '../lib/site-seo';
import { indexableRoutes } from '../lib/discovery';
import type { DraftContent, SiteSnapshot } from './types';
import { getDraftRecord, getActiveReleaseId, readRelease } from './studio';
import { getDatabase } from './database';
import { getAuthEnvironment } from './env';
import { classifyAiAddress, getAiProviderSummary } from './ai-provider';
import { mailRuntimeSummary } from './mail-settings';
import { readMailTestEvidence } from './mail-test-evidence';
import { readAiTestEvidence } from './service-test-evidence';
import { ApiError } from './http';
import { object, revision } from './validation';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';
import { readLaunchPage, validateLaunchOrigin, type LaunchPageReader, type LaunchPageResponse } from './launch-check-http';

type Row = { id: string; base_revision: number; release_id: string | null; public_url: string; payload_json: string; created_at: string; expires_at: string };
type Saved = { checks: LaunchCheckKind[]; items: LaunchCheckItem[] };
const CHECK_LIFETIME_MS = 10 * 60 * 1000;
const SERVICE_TEST_LIFETIME_MS = 24 * 60 * 60 * 1000;
const NETWORK_IDS = new Set(['public-home', 'public-robots', 'public-sitemap', 'public-indexing', 'public-canonical']);
const action = (screen: LaunchCheckAction['screen'], label: string, settingsTab?: LaunchCheckAction['settingsTab']): LaunchCheckAction => ({ screen, label, ...(settingsTab ? { settingsTab } : {}) });
const settings = (tab: NonNullable<LaunchCheckAction['settingsTab']>, label: string) => action('settings', label, tab);

function administrator(actor: Actor): Actor {
  requirePermission(actor, 'manage');
  const row = getDatabase().prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow | undefined;
  if (!row || isMemberDisabled(row)) throw new ApiError(401, '账号已停用或会话已失效');
  if (row.role !== 'admin') throw new ApiError(403, '上线检查仅管理员可用');
  return { id: row.id, name: row.name, email: row.email, role: 'admin' };
}
function state() {
  const draft = getDraftRecord(), releaseId = getActiveReleaseId(), active = releaseId ? readRelease(releaseId) : null;
  // 正式探测始终针对当前公开快照的地址；草稿填了新域名不会冒充线上已经迁移。
  return { ...draft, releaseId, active, publicUrl: active ? publicSiteOrigin(active.settings.publicUrl) || null : null, draftUrl: publicSiteOrigin(draft.content.settings.publicUrl) || null };
}
type Current = ReturnType<typeof state>;
function summary(items: LaunchCheckItem[]): LaunchCheckReport['summary'] {
  const count = (states: LaunchCheckItem['status'][]) => items.filter(item => states.includes(item.status)).length;
  return { passed: count(['passed']), configured: count(['configured']), needsAttention: count(['attention', 'failed']), unverified: count(['unverified']), notApplicable: count(['not-applicable']), total: items.length };
}
function item(value: LaunchCheckItem): LaunchCheckItem { return value; }

/** 只比较公开内容字段；显示未发布差异不意味着要求把全部私有草稿都发布。 */
function contentProjection(content: DraftContent | SiteSnapshot) {
  const clean = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !['status', 'updated'].includes(key)));
  const records = (values: unknown[] | undefined) => (values || []).map(value => clean(value as Record<string, unknown>));
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, next]) => [key, stable(next)])) : value;
  return JSON.stringify(stable({ pages: records(content.pages), products: records(content.products), entries: records(content.contentEntries), editorData: content.editorData, theme: content.theme, siteLayout: content.siteLayout,
    sharedBlocks: records(content.sharedBlocks), models: records(content.contentModels), templates: records(content.pageTemplates), forms: content.forms || [], taxonomies: content.taxonomies || [], redirects: content.redirects || [], customCode: content.customCode,
    settings: Object.fromEntries(['name', 'description', 'email', 'language', 'locales', 'publicUrl', 'discovery'].map(key => [key, content.settings[key as keyof typeof content.settings]])) }));
}
function date(value: unknown): string | undefined { return typeof value === 'string' && value.length <= 50 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined; }
// 本机演示的HTTP/内网地址保留为未验证，不要求为本机预览购买域名或证书。
function demoOrigin(value: string | null) { if (!value) return false; const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase(); return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || !!isIP(hostname) && classifyAiAddress(hostname) !== 'public'; }

/** 备份状态只读取有限安全字段；成功写出备份不等于已经完成恢复演练。 */
function backupItems(now: number): LaunchCheckItem[] {
  const automatic = process.env.FORM_STUDIO_AUTOMATIC_BACKUP === '1', rawHours = Number(process.env.FORM_STUDIO_BACKUP_INTERVAL_HOURS || 24), hours = Number.isInteger(rawHours) && rawHours >= 1 && rawHours <= 8760 ? rawHours : 24;
  let status: 'success' | 'failure' | undefined, at: string | undefined;
  try { const file = join(resolve(/* turbopackIgnore: true */ process.env.FORM_STUDIO_BACKUP_DIR || 'backups'), 'STATUS.json'); if (statSync(file).size <= 4096) { const saved = JSON.parse(readFileSync(file, 'utf8')); if (saved.status === 'success' || saved.status === 'failure') status = saved.status; at = date(saved.createdAt || saved.at); } } catch { /* 缺失与无效记录保留未验证，不生成成功时间。 */ }
  const future = !!at && Date.parse(at) > now + 5 * 60 * 1000, expired = !!at && now - Date.parse(at) > hours * 1.5 * 3600000;
  return [item({ id: 'backup-schedule', category: 'operations', title: '自动备份', status: automatic ? 'configured' : 'attention', message: automatic ? `此启动方式已启用自动备份，计划间隔${hours}小时；执行结果另行核对。` : '当前启动方式没有启用自动备份。已有手工备份工具，可按部署说明启用计划。', action: settings('backup', '查看备份与导出') }),
    item({ id: 'backup-latest', category: 'operations', title: '最近备份结果', status: status === 'failure' ? 'failed' : !status || !at || future ? 'unverified' : expired ? 'attention' : status === 'success' ? 'passed' : 'unverified', message: status === 'failure' ? '最近自动备份记录为失败，请核对磁盘空间和目录权限。' : !status || !at || future ? '没有可核对的近期自动备份执行记录；这不代表没有手工副本，请单独验证。' : expired ? '最近备份成功记录已超过计划间隔，请核对调度是否仍在运行。' : '状态文件记录最近备份执行成功，尚不能据此证明副本能够完整恢复。', ...(at && !future ? { checkedAt: at } : {}), action: settings('backup', '核对备份状态') }),
    item({ id: 'backup-recoverability', category: 'operations', title: '完整校验与恢复演练', status: 'unverified', message: '现有备份状态没有完整校验和恢复演练回执。请在隔离目录验证数据库、媒体、固定密钥及登录，不能用内容JSON导出代替完整备份。', action: settings('backup', '查看恢复说明') })];
}

function localItems(current: Current, now: number): LaunchCheckItem[] {
  const at = new Date(now).toISOString(), { content, active, publicUrl, draftUrl } = current, changed = !!active && contentProjection(content) !== contentProjection(active), demo = demoOrigin(publicUrl);
  const items: LaunchCheckItem[] = [item({ id: 'publication', category: 'content', title: '公开网站版本', status: active ? 'passed' : 'attention', message: active ? '本实例有正在使用的公开快照。下面的正式网站探测以这个版本为准。' : '还没有公开版本。先预览并确认本次发布范围，草稿不会自动对外显示。', checkedAt: at, action: action('releases', '打开发布管理') }),
    item({ id: 'draft-changes', category: 'content', title: '草稿与公开版本', status: !active ? 'unverified' : changed ? 'attention' : 'passed', message: !active ? `当前草稿修订为${current.revision}，尚无公开版本可比较。` : changed ? '草稿与公开快照存在差异。请核对本次需要发布的范围；不要求把所有未发布资料一起公开。' : '按公开内容字段比较，当前草稿与公开快照未发现差异。', checkedAt: at, action: action('releases', '核对发布差异') }),
    item({ id: 'public-url', category: 'website', title: '正式网站地址', status: demo || demoOrigin(draftUrl) && !publicUrl ? 'unverified' : !draftUrl ? 'attention' : !publicUrl ? 'configured' : publicUrl !== draftUrl ? 'attention' : 'configured', message: demo ? '当前地址用于本机或内网演示，尚未验证公网。可以继续预览和编辑，部署正式域名后再检查。' : !draftUrl ? '网站资料里尚未填写有效正式网址。' : !publicUrl ? '草稿已经填写网址，但公开快照尚未包含该设置；本机预览不受影响，部署正式域名后再检查。' : publicUrl !== draftUrl ? '草稿正式网址与当前公开版本不同，本次网络检查仍只使用公开版本的地址。' : '公开快照已记录正式网址；记录地址不等于DNS和证书已经连通。', evidence: [...(draftUrl ? [`草稿地址：${draftUrl}`] : []), ...(publicUrl ? [`公开地址：${publicUrl}`] : [])], action: settings('general', '填写网站正式网址') }),
    item({ id: 'https-config', category: 'website', title: 'HTTPS配置', status: !publicUrl || demo ? 'unverified' : publicUrl.startsWith('https:') ? 'configured' : 'attention', message: demo ? '本机或内网演示尚未验证公网HTTPS；本机预览不要求正式证书。' : !publicUrl ? '尚无公开正式地址可核对。' : publicUrl.startsWith('https:') ? '已记录HTTPS地址，证书有效性需要主动执行正式网站检查。' : '当前公开地址仍为HTTP，请在服务器部署证书并核对正式网址。', action: settings('domain', '查看域名连接说明') })];
  const authOrigin = getAuthEnvironment().baseURL;
  items.push(item({ id: 'admin-origin', category: 'website', title: '后台登录来源', status: !publicUrl || demo ? 'unverified' : authOrigin === publicUrl ? 'configured' : 'attention', message: !publicUrl || demo ? '当前仅核对本机演示配置；部署正式站点后，再核对后台登录来源与反向代理。' : authOrigin === publicUrl ? '部署配置中的后台登录来源与公开网站地址一致，仍需在实际域名验证登录和HTTPS。' : '部署配置中的后台登录来源与公开网站不同。请核对服务器与代理；分离域名部署需要单独验证，不能据此认定连通。', action: settings('domain', '查看部署来源说明') }));
  const ai = getAiProviderSummary();
  const aiReady = ai.enabled && !!ai.baseUrl && !!ai.model && (ai.hasApiKey || ai.allowLocal);
  const generated = getDatabase().prepare("SELECT max(created_at) at,count(*) n FROM cms_ai_build WHERE json_extract(payload_json,'$.pending') IS NOT 1").get() as { at: string | null; n: number };
  items.push(item({ id: 'ai-config', category: 'services', title: '自己的AI服务', status: !ai.enabled ? 'not-applicable' : aiReady ? 'configured' : 'attention', message: !ai.enabled ? '未启用站内AI；仍可使用案例或手工建站。外部AI连接也使用客户端自己的模型。' : aiReady ? `模型配置已保存（配置版本${ai.revision}），尚不能据此认定连接、额度和生成质量已验证。` : 'AI已启用，但服务地址、模型或所需密钥不完整。', action: settings('ai', '查看AI服务与测试') }),
    item({ id: 'ai-generation', category: 'services', title: '实际AI生成记录', status: !ai.enabled ? 'not-applicable' : 'unverified', message: generated.n > 0 ? '本实例有已完成的建站方案记录，但旧记录没有绑定当前AI配置版本，不能把它当作当前模型连接或设计满意度证明。' : '尚无可用的已完成建站方案记录。请用自己的资料和模型主动生成并预览，检查不会替你调用模型。', ...(date(generated.at) ? { checkedAt: date(generated.at) } : {}), action: action('site-journey', '进入建站流程试跑') }));
  try {
    const evidence = readAiTestEvidence(), testedAt = evidence && date(evidence.checkedAt), fresh = testedAt && Date.parse(testedAt) <= now + 5 * 60 * 1000 && now - Date.parse(testedAt) <= SERVICE_TEST_LIFETIME_MS;
    const matches = evidence && evidence.configurationRevision === ai.revision && fresh && ['passed', 'failed'].includes(evidence.status);
    items.push(item({ id: 'ai-connection', category: 'services', title: '最近AI连接测试', status: !matches ? !ai.enabled && !evidence ? 'not-applicable' : 'unverified' : evidence.status === 'failed' ? 'failed' : 'passed', message: !matches ? '没有与当前配置匹配且24小时内的连接测试证据。可到原AI服务入口主动测试，检查不会调用模型或扣额度。' : evidence.status === 'failed' ? '当前AI配置最近一次连接测试失败，请到原设置入口核对。' : '当前配置最近24小时内通过一次连接协议测试；这不证明生成质量、余额或连接持续可用。', ...(testedAt ? { checkedAt: testedAt } : {}), action: settings('ai', '主动测试AI连接') }));
  } catch { items.push(item({ id: 'ai-connection', category: 'services', title: '最近AI连接测试', status: 'unverified', message: '暂时无法核对AI测试证据，请到原设置入口读取；没有把未知结果记为成功。', action: settings('ai', '核对AI连接状态') })); }
  const mail = mailRuntimeSummary();
  items.push(item({ id: 'mail-config', category: 'services', title: '邮件服务资料', status: mail.mode === 'mock' ? 'unverified' : mail.configured ? 'configured' : mail.enabled ? 'attention' : 'not-applicable', message: mail.mode === 'mock' ? '当前为JSON模拟模式，不会给真实邮箱投递，不能用作正式邮件验收。' : mail.configured ? '邮件服务字段已经齐全；测试是否被服务接受另行核对，接收询盘的自动通知开关独立生效。' : mail.enabled ? '自动通知已开启，但邮件服务资料不完整。' : '未启用询盘自动通知，询盘仍保存在后台；需要邮件找回密码时仍须配置真实可用的发信服务。', action: settings('mail', '配置邮件通知') }));
  try {
    const evidence = readMailTestEvidence();
    const testedAt = evidence && date(evidence.checkedAt), fresh = testedAt && Date.parse(testedAt) <= now + 5 * 60 * 1000 && now - Date.parse(testedAt) <= SERVICE_TEST_LIFETIME_MS;
    // 关闭的是询盘自动通知，完整SMTP仍可测试/用于账号恢复，不能把mode=none误当测试失效。
    const matches = evidence && evidence.configurationRevision === mail.revision && evidence.configurationSource === mail.source && fresh && ['sent', 'mock_sent', 'failed'].includes(evidence.status);
    items.push(item({ id: 'mail-test', category: 'services', title: '最近邮件测试', status: !matches ? 'unverified' : evidence.status === 'failed' ? 'failed' : evidence.status === 'mock_sent' ? 'unverified' : 'passed', message: !matches ? '当前邮件配置没有匹配且24小时内的测试回执。修改配置后需重新主动测试，检查不会发送邮件。' : evidence.status === 'failed' ? '当前配置最近一次测试失败，请到邮件设置核对；错误详情以原测试入口为准。' : evidence.status === 'mock_sent' ? '最近一次只完成本机模拟，不代表真实发信或收件箱收到。' : '当前配置最近24小时内的测试已被邮件服务接受；仍需到测试邮箱及垃圾邮件中确认实际收到。', ...(testedAt ? { checkedAt: testedAt } : {}), action: settings('mail', '发送已保存配置的测试') }));
  } catch { items.push(item({ id: 'mail-test', category: 'services', title: '最近邮件测试', status: 'unverified', message: '暂时无法核对邮件测试回执，请到邮件设置读取状态；没有把未知结果记为成功。', action: settings('mail', '核对邮件设置') })); }
  const queue = getDatabase().prepare("SELECT sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,sum(CASE WHEN status='unconfigured' THEN 1 ELSE 0 END) unconfigured FROM cms_notification_job").get() as { failed: number | null; unconfigured: number | null };
  items.push(item({ id: 'notification-queue', category: 'services', title: '询盘通知待处理', status: (queue.failed || 0) > 0 ? 'attention' : (queue.unconfigured || 0) > 0 ? 'attention' : 'passed', message: (queue.failed || 0) > 0 || (queue.unconfigured || 0) > 0 ? `有${queue.failed || 0}条失败、${queue.unconfigured || 0}条历史未配置通知待核对；询盘记录仍保留，启用邮件不会静默补发历史未配置任务。` : '没有发现失败或历史未配置通知。这不证明未来邮件已经送达。', checkedAt: at, action: action('inquiries', '查看询盘与通知结果') }));
  try {
    const seo = diagnoseSeo(content), errors = seo.issues.filter(issue => issue.severity === 'error').length, warnings = seo.issues.filter(issue => issue.severity === 'warning').length;
    items.push(item({ id: 'draft-seo', category: 'content', title: '草稿基础搜索检查', status: errors || warnings ? 'attention' : seo.coverage.truncated ? 'unverified' : 'passed', message: `${errors}项错误、${warnings}项建议检查。仅检查当前草稿的可解析内容，未查询Google收录或排名。`, checkedAt: at, evidence: [`已检查${seo.coverage.checkedTargets}/${seo.coverage.totalTargets}个目标${seo.coverage.truncated ? '，仍有未覆盖内容' : ''}。`], action: action('seo', '查看搜索检查依据') }));
  } catch { items.push(item({ id: 'draft-seo', category: 'content', title: '草稿基础搜索检查', status: 'failed', message: '本次未能完成草稿解析，请到搜索检查核对；其他上线状态仍分别保留。', checkedAt: at, action: action('seo', '核对搜索检查') })); }
  let indexed = 0, indexError = false; try { if (active) indexed = indexableRoutes(active).length; } catch { indexError = true; }
  items.push(item({ id: 'published-search-content', category: 'content', title: '公开内容的收录意图', status: !active || indexError ? 'unverified' : indexed ? 'configured' : 'attention', message: !active ? '尚未发布，不能把草稿的搜索设置当作线上状态。' : indexError ? '当前公开快照的地址未能完整解析，请人工核对，没有把未检查当作没有问题。' : indexed ? `公开快照中有${indexed}个可解析且未设noindex的地址；是否实际抓取和收录仍由搜索平台决定。` : '未找到可解析且允许索引的公开地址，请核对页面和收录意图，不会自动修改noindex。', action: settings('discovery', '核对搜索与AI可见性') }));
  return [...items, ...backupItems(now)];
}

function unverifiedNetwork(message: string): LaunchCheckItem[] {
  return [['public-home', '正式首页连通'], ['public-robots', '正式robots.txt'], ['public-sitemap', '正式站点地图'], ['public-indexing', '正式首页索引指令'], ['public-canonical', '正式首页规范地址']].map(([id, title]) => item({ id, title, category: 'website', status: 'unverified', message, action: settings('domain', '核对域名与部署') }));
}
function latest(current: Current, now: number, networkOnly = false): { row: Row; saved: Saved } | null {
  const row = getDatabase().prepare(`SELECT id,base_revision,release_id,public_url,payload_json,created_at,expires_at FROM cms_launch_check WHERE base_revision=? AND release_id IS ? AND public_url=? AND expires_at>? ${networkOnly ? "AND EXISTS(SELECT 1 FROM json_each(payload_json,'$.checks') WHERE value='public-website')" : ''} ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(current.revision, current.releaseId, current.publicUrl || '', new Date(now).toISOString()) as Row | undefined;
  if (!row) return null;
  try { const saved = JSON.parse(row.payload_json) as Saved; if (!Array.isArray(saved.checks) || !Array.isArray(saved.items)) return null; return { row, saved }; } catch { return null; }
}
function report(current: Current, now: number, network?: LaunchCheckItem[], last?: { row: Row; saved: Saved } | null): LaunchCheckReport {
  const prior = last === undefined ? latest(current, now) : last;
  const networkPrior = prior?.saved.checks.includes('public-website') ? prior : latest(current, now, true);
  const items = [...localItems(current, now), ...(network || networkPrior?.saved.items.filter(item => NETWORK_IDS.has(item.id)) || unverifiedNetwork('尚无与当前草稿、公开版本及正式地址匹配的近期探测。可主动检查正式网站；读取此页不会联网。'))];
  return { revision: current.revision, releaseId: current.releaseId, publicUrl: current.publicUrl, generatedAt: new Date(now).toISOString(), summary: summary(items), items, lastCheck: prior ? { id: prior.row.id, createdAt: prior.row.created_at, expiresAt: prior.row.expires_at, checks: prior.saved.checks } : null, note: '检查项按实际证据分别记录，不计算网站总分；首页/robots/站点地图只是抽样，不代表全站已检查、Google收录、邮箱送达或客户满意。' };
}

/** GET只读取本地状态和未过期的匹配回执，不做DNS、收费模型、邮件发送或备份操作。 */
export function readLaunchCheck(actor: Actor): LaunchCheckReport { administrator(actor); return report(state(), Date.now()); }
function input(value: unknown): LaunchCheckRequest {
  const raw = object(value, '上线检查');
  if (Object.keys(raw).some(key => !['expectedRevision', 'expectedReleaseId', 'checks'].includes(key)) || raw.expectedReleaseId !== null && (typeof raw.expectedReleaseId !== 'string' || !raw.expectedReleaseId.length || raw.expectedReleaseId.length > 100) || !Array.isArray(raw.checks) || !raw.checks.length || raw.checks.length > 2 || new Set(raw.checks).size !== raw.checks.length || raw.checks.some(check => !['local', 'public-website'].includes(check))) throw new ApiError(422, '请选择本地资料检查或正式网站连接检查');
  return { expectedRevision: revision(raw.expectedRevision), expectedReleaseId: raw.expectedReleaseId as string | null, checks: raw.checks as LaunchCheckKind[] };
}
function unchanged(current: Current, expected: LaunchCheckRequest) { if (current.revision !== expected.expectedRevision || current.releaseId !== expected.expectedReleaseId) throw new ApiError(409, '网站草稿或公开版本已变化，请读取最新状态后再检查'); }

function attributes(tag: string) { return Object.fromEntries([...tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(match => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? ''])); }
/** robots仅判断Googlebot的首页路径；训练机器人禁令不会被误报为全站搜索禁令。 */
export function robotsHomeBlocked(body: string): boolean | null {
  const groups: { agents: string[]; rules: { name: string; path: string }[] }[] = []; let group: typeof groups[number] | undefined;
  for (const line of body.split(/\r?\n/).slice(0, 3000)) { const pair = line.replace(/#.*$/, '').trim().match(/^([\w-]+)\s*:\s*(.*)$/); if (!pair) continue; const name = pair[1].toLowerCase(), value = pair[2].trim(); if (name === 'user-agent') { if (!group || group.rules.length) { group = { agents: [], rules: [] }; groups.push(group); } group.agents.push(value.toLowerCase()); } else if (group && ['allow', 'disallow'].includes(name)) group.rules.push({ name, path: value }); }
  const specificity = (agents: string[]) => Math.max(-1, ...agents.map(agent => agent === '*' ? 0 : agent && 'googlebot'.includes(agent) ? agent.length : -1));
  const maximum = Math.max(-1, ...groups.map(group => specificity(group.agents))); if (maximum < 0) return false;
  const rules = groups.filter(group => specificity(group.agents) === maximum).flatMap(group => group.rules).filter(rule => rule.path);
  let blocked = false, weight = -1, complex = false;
  for (const rule of rules) { if (!rule.path.startsWith('/')) { complex = true; continue; } if (!['/', '/*', '/$', '/*$'].includes(rule.path)) { if (rule.path.includes('*') && rule.path.split('*')[0] === '/') complex = true; continue; } const length = rule.path.replace(/[*$]/g, '').length; if (length > weight || length === weight && rule.name === 'allow') { weight = length; blocked = rule.name === 'disallow'; } }
  return complex ? null : blocked;
}

async function networkItems(current: Current, reader: LaunchPageReader, signal?: AbortSignal): Promise<LaunchCheckItem[]> {
  if (!current.active || !current.publicUrl) return unverifiedNetwork('尚无含正式网址的公开版本；先确认发布网站资料，再进行正式连接检查。');
  let origin: URL; try { origin = validateLaunchOrigin(current.publicUrl); } catch (error) { return unverifiedNetwork(error instanceof ApiError ? error.message : '正式网址暂时无法检查'); }
  const deadline = AbortSignal.timeout(12000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline, at = new Date().toISOString();
  const request = async (path: string): Promise<LaunchPageResponse | ApiError> => { try { return await reader(new URL(path, origin), combined); } catch (error) { return error instanceof ApiError ? error : new ApiError(combined.aborted ? 504 : 502, combined.aborted ? '本次正式网站检查已取消或超时' : '正式网站连接未完成，请核对网络和部署'); } };
  const [home, robots, sitemap] = await Promise.all(['/', '/robots.txt', '/sitemap.xml'].map(request));
  const remote = (id: string, title: string, response: LaunchPageResponse | ApiError, successful: () => LaunchCheckItem): LaunchCheckItem => response instanceof ApiError ? item({ id, category: 'website', title, status: 'failed', message: response.message, checkedAt: at, action: settings('domain', '核对域名与部署') }) : response.status >= 300 && response.status < 400 ? item({ id, category: 'website', title, status: 'attention', message: '服务器返回重定向，本次没有跟随。请核对正式网址、HTTPS和服务器转发规则。', checkedAt: at, evidence: [`HTTP ${response.status}`], action: settings('domain', '核对服务器转发') }) : successful();
  const homeItem = remote('public-home', '正式首页连通', home, () => {
    const value = home as LaunchPageResponse, marker = value.body.match(/\bdata-site-release\s*=\s*["']([^"']+)["']/i)?.[1], ok = value.status >= 200 && value.status < 300 && /text\/html/i.test(value.contentType);
    return item({ id: 'public-home', category: 'website', title: '正式首页连通', status: !ok ? 'failed' : marker === current.releaseId ? 'passed' : 'attention', message: !ok ? '首页没有返回成功的HTML响应，请核对部署。' : marker === current.releaseId ? 'HTTPS首页可访问，响应中识别到本实例当前公开版本标记。仅验证本次首页响应，不代表全部页面和交互均正常。' : '首页可以访问，但未识别到本实例当前公开版本标记；可能域名指向其他实例、缓存旧版本或使用额外代理，请人工核对。', checkedAt: at, evidence: [`HTTP ${value.status}`, 'TLS证书按正式域名校验；未跟随重定向。'], action: settings('domain', '核对域名与部署') });
  });
  const robotsItem = remote('public-robots', '正式robots.txt', robots, () => {
    const value = robots as LaunchPageResponse, block = robotsHomeBlocked(value.body);
    return item({ id: 'public-robots', category: 'website', title: '正式robots.txt', status: value.status === 404 ? 'unverified' : value.status !== 200 ? 'failed' : /text\/html/i.test(value.contentType) || !/user-agent\s*:/i.test(value.body) ? 'unverified' : block === null ? 'unverified' : block ? 'attention' : 'passed', message: value.status === 404 ? '没有取得robots.txt；文件缺失本身不等于禁止抓取，本次未核对到规则。' : value.status !== 200 ? 'robots.txt没有返回成功响应。' : /text\/html/i.test(value.contentType) || !/user-agent\s*:/i.test(value.body) ? '响应不是可识别的robots规则，本次未完成核对。' : block === null ? '已取得规则，但存在本次简化检查无法确定的复杂首页匹配，请人工核对。' : block ? '发现针对Googlebot或通配抓取器的首页禁止规则，请确认是否符合你的收录意图。' : '已读取规则，本次没有发现明确禁止Googlebot访问首页的规则；未检查全部路径或所有机器人。', checkedAt: at, evidence: [`HTTP ${value.status}`], action: settings('discovery', '核对搜索可见性') });
  });
  const sitemapItem = remote('public-sitemap', '正式站点地图', sitemap, () => {
    const value = sitemap as LaunchPageResponse, root = /<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(value.body), locations = [...value.body.matchAll(/<(?:\w+:)?loc\b[^>]*>([^<]*)<\/(?:\w+:)?loc>/gi)].slice(0, 100);
    const outside = locations.some(match => { try { return new URL(match[1].replace(/&amp;/g, '&').trim()).origin !== origin.origin; } catch { return true; } });
    return item({ id: 'public-sitemap', category: 'website', title: '正式站点地图', status: value.status !== 200 ? 'failed' : !root ? 'unverified' : !locations.length || outside ? 'attention' : 'passed', message: value.status !== 200 ? '未取得成功的站点地图响应。' : !root ? '响应中没有识别到站点地图XML根元素，本次没有把它当作有效地图。' : !locations.length ? '地图响应中没有识别到地址，请核对公开内容及收录设置。' : outside ? '本次抽查的地图地址存在其他来源或无法解析的网址，请核对正式网址。' : '已读取站点地图并抽查同源地址；未逐条访问，也不表示搜索平台已接收或收录。', checkedAt: at, evidence: [`HTTP ${value.status}`, `最多抽查100个地址，本次读取${locations.length}个。`], action: action('seo', '核对公开内容地址') });
  });
  const readyHome = !(home instanceof ApiError) && home.status >= 200 && home.status < 300 && /text\/html/i.test(home.contentType);
  if (!readyHome) return [homeItem, robotsItem, sitemapItem, ...unverifiedNetwork('首页响应尚未核对成功，未继续推断它的索引或规范地址。').filter(item => ['public-indexing', 'public-canonical'].includes(item.id))];
  const page = home as LaunchPageResponse, metas = [...page.body.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0])), noindex = /\bnoindex\b/i.test(page.robots) || metas.some(meta => ['robots', 'googlebot'].includes(String(meta.name).toLowerCase()) && /\bnoindex\b/i.test(meta.content || ''));
  const canonical = [...page.body.matchAll(/<link\b[^>]*>/gi)].map(match => attributes(match[0])).find(link => String(link.rel).toLowerCase().split(/\s+/).includes('canonical'))?.href;
  let canonicalStatus: LaunchCheckItem['status'] = 'unverified'; if (canonical) { try { const url = new URL(canonical, origin); canonicalStatus = url.origin === origin.origin && url.pathname === '/' && !url.search ? 'passed' : 'attention'; } catch { canonicalStatus = 'attention'; } }
  return [homeItem, robotsItem, sitemapItem,
    item({ id: 'public-indexing', category: 'website', title: '正式首页索引指令', status: noindex ? 'attention' : 'passed', message: noindex ? '首页响应中发现noindex指令，请确认是否是你的意图；检查不会自动解除。' : '本次首页响应未发现noindex指令，这不表示已经被Google或其他平台收录。', checkedAt: at, action: settings('discovery', '核对首页收录意图') }),
    item({ id: 'public-canonical', category: 'website', title: '正式首页规范地址', status: canonicalStatus, message: !canonical ? '本次没有从首页响应识别到规范地址，请在SEO入口核对。' : canonicalStatus === 'passed' ? '首页规范地址与本次正式首页一致；其他页面没有逐条检查。' : '首页规范地址与本次正式首页不同或无法解析，请核对语言路径、域名和预期规范页。', checkedAt: at, action: action('seo', '核对规范地址') })];
}

/** 只有明确POST才执行所选检查；依赖注入仅供调用本服务的单元测试，HTTP永不接收传输器。 */
export async function checkLaunchReadiness(value: unknown, actor: Actor, signal?: AbortSignal, dependencies: { readPage?: LaunchPageReader } = {}): Promise<LaunchCheckReport> {
  actor = administrator(actor); const request = input(value), before = state(); unchanged(before, request);
  const items = request.checks.includes('public-website') ? await networkItems(before, dependencies.readPage || readLaunchPage, signal) : undefined;
  if (signal?.aborted) throw new ApiError(499, '上线检查已取消，未保存新的检查回执');
  return getDatabase().transaction(() => {
    administrator(actor); const current = state(); unchanged(current, request);
    if (current.publicUrl !== before.publicUrl) throw new ApiError(409, '正式网址已变化，请重新检查');
    const stamp = new Date().toISOString(), id = `launch-${randomUUID()}`, expiry = new Date(Date.now() + CHECK_LIFETIME_MS).toISOString();
    const saved: Saved = { checks: request.checks, items: items || [] };
    getDatabase().prepare('DELETE FROM cms_launch_check WHERE expires_at<=?').run(stamp);
    getDatabase().prepare('INSERT INTO cms_launch_check(id,actor_id,base_revision,release_id,public_url,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id, actor.id, current.revision, current.releaseId, current.publicUrl || '', JSON.stringify(saved), stamp, expiry);
    // 同一实例只保留有限近期回执，保存检查不会改草稿修订或公开发布指针。
    getDatabase().prepare('DELETE FROM cms_launch_check WHERE id IN (SELECT id FROM cms_launch_check ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 50)').run();
    return report(current, Date.now(), items, { row: { id, base_revision: current.revision, release_id: current.releaseId, public_url: current.publicUrl || '', payload_json: JSON.stringify(saved), created_at: stamp, expires_at: expiry }, saved });
  }).immediate();
}
