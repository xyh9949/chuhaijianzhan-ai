import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDatabase } from './database';
import { getDraftRecord } from './studio';
import { ApiError } from './http';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';
import { recordAudit } from './audit';
import { getAuthEnvironment } from './env';

export type ExternalAiScope = 'read' | 'propose' | 'content:read' | 'content:propose' | 'seo:read' | 'seo:propose' | 'design-guidance:read';
/** null明确授权整类（含新建）；空数组明确拒绝，旧连接升级时保持空范围。 */
export interface ExternalAiRecordIds { productIds: string[] | null; entryIds: string[] | null; }
export interface ExternalAiTokenSummary {
  id: string; name: string; hint: string; scopes: ExternalAiScope[]; pageIds: string[] | null; recordIds: ExternalAiRecordIds; templateIds: string[] | null;
  createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null;
}
/** 只能由服务端认证函数产生；actor供共享业务校验，不得作为MCP结果返回账号资料。 */
export interface ExternalAiGrant {
  tokenId: string; actor: Actor; scopes: ExternalAiScope[]; pageIds: string[] | null; recordIds: ExternalAiRecordIds; templateIds: string[] | null; expiresAt: string;
}
export interface ExternalAiAccess { pageIds?: string[]; global?: boolean; productIds?: string[]; entryIds?: string[]; templateIds?: string[]; createKind?: 'product' | 'entry'; }
interface TokenRow {
  id: string; actor_id: string; name: string; token_hash: string; token_hint: string;
  scopes_json: string; page_ids_json: string; record_ids_json: string; template_ids_json: string; created_at: string; expires_at: string;
  revoked_at: string | null; last_used_at: string | null;
}
const SELECT = 'SELECT id,actor_id,name,token_hash,token_hint,scopes_json,page_ids_json,record_ids_json,template_ids_json,created_at,expires_at,revoked_at,last_used_at FROM cms_external_ai_token';
const TOKEN_PATTERN = /^Bearer (fsai_[A-Za-z0-9_-]{43})$/i;

function currentAdministrator(actor: Actor): Actor {
  requirePermission(actor, 'manage');
  const row = getDatabase().prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow | undefined;
  if (!row || isMemberDisabled(row)) throw new ApiError(401, '账号已停用或会话已失效');
  if (row.role !== 'admin') throw new ApiError(403, '外部AI连接仅管理员可管理');
  return { id: row.id, name: row.name, email: row.email, role: 'admin' };
}
function scopes(value: unknown): ExternalAiScope[] {
  const known: ExternalAiScope[] = ['read', 'propose', 'content:read', 'content:propose', 'seo:read', 'seo:propose', 'design-guidance:read'];
  if (!Array.isArray(value) || !value.includes('read') || value.length > known.length || value.some(scope => !known.includes(scope)) || new Set(value).size !== value.length || ['content', 'seo'].some(domain => value.includes(`${domain}:propose`) && !value.includes(`${domain}:read`))) throw new ApiError(422, '连接权限无效；提交文案或搜索建议时需同时允许读取该类资料');
  return known.filter(scope => value.includes(scope));
}
function recordIds(value: unknown, validateExisting = false): ExternalAiRecordIds {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['productIds', 'entryIds'].includes(key))) throw new ApiError(422, '请明确选择产品和内容的可访问范围');
  const input = value as Record<string, unknown>, content = validateExisting ? getDraftRecord().content : undefined;
  for (const key of ['productIds', 'entryIds'] as const) {
    const ids = input[key];
    if (ids === null) continue;
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(ids).size !== ids.length) throw new ApiError(422, '产品或内容范围需为明确的ID列表或整类授权');
    const available = content && new Set((key === 'productIds' ? content.products : content.contentEntries || []).map(item => item.id));
    if (available && ids.some(id => !available.has(id))) throw new ApiError(422, '所选产品或内容已不存在，请重新选择');
  }
  return { productIds: input.productIds === null ? null : [...input.productIds as string[]], entryIds: input.entryIds === null ? null : [...input.entryIds as string[]] };
}
function pageIds(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length) throw new ApiError(422, '请选择1–100个页面，或明确允许整个网站');
  const existing = new Set(getDraftRecord().content.pages.map(page => page.id));
  if (value.some(id => !existing.has(id))) throw new ApiError(422, '所选页面已不存在，请重新选择');
  return [...value] as string[];
}
/** 模板授权独立于页面；空集合不会因页面全站授权而升级，删除模板也不扩大旧范围。 */
function templateIds(value: unknown, validateExisting = false): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(value).size !== value.length) throw new ApiError(422, '详情模板范围需为明确的ID列表或全部详情模板');
  if (validateExisting) {
    const available = new Set((getDraftRecord().content.pageTemplates || []).filter(item => item.kind === 'product' || item.kind === 'entry').map(item => item.id));
    if (value.some(id => !available.has(id))) throw new ApiError(422, '所选详情模板已不存在，请重新选择');
  }
  return [...value] as string[];
}
function policy(row: TokenRow): Pick<ExternalAiGrant, 'scopes' | 'pageIds' | 'recordIds' | 'templateIds'> {
  try {
    const allowedScopes = scopes(JSON.parse(row.scopes_json));
    const allowedPages: unknown = JSON.parse(row.page_ids_json);
    // 存量凭据里的已删除页面仍是原范围，不能因页面删减将限定凭据升级成全站。
    if (allowedPages !== null && (!Array.isArray(allowedPages) || !allowedPages.length || allowedPages.length > 100 || allowedPages.some(id => typeof id !== 'string') || new Set(allowedPages).size !== allowedPages.length)) throw Error();
    return { scopes: allowedScopes, pageIds: allowedPages as string[] | null, recordIds: recordIds(JSON.parse(row.record_ids_json)), templateIds: templateIds(JSON.parse(row.template_ids_json)) };
  } catch { throw new ApiError(401, '外部AI连接已失效，请重新创建连接'); }
}
function summary(row: TokenRow): ExternalAiTokenSummary {
  return { id: row.id, name: row.name, hint: row.token_hint, ...policy(row), createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at };
}
function credentialId(value: unknown): string {
  if (typeof value !== 'string' || !/^eait-[a-f0-9-]{36}$/.test(value)) throw new ApiError(422, '连接标识无效');
  return value;
}

/** 一次性返回256位随机凭据；数据库与列表仅保留hash和尾号，独立于后台Cookie及AI服务密钥。 */
export function createExternalAiToken(value: unknown, actor: Actor): { credential: ExternalAiTokenSummary; token: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, '连接设置需为对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['name', 'scopes', 'pageIds', 'recordIds', 'templateIds', 'expiresInDays'].includes(key))) throw new ApiError(422, '连接设置包含不支持字段');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new ApiError(422, '连接名称需为1–100个字符');
  const days = input.expiresInDays === undefined ? 30 : input.expiresInDays;
  if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > 365) throw new ApiError(422, '连接有效期需为1–365天');
  const allowedScopes = scopes(input.scopes === undefined ? ['read', 'propose'] : input.scopes);
  return getDatabase().transaction(() => {
    const owner = currentAdministrator(actor), allowedPages = pageIds(input.pageIds === undefined ? null : input.pageIds);
    const allowedTemplates = templateIds(input.templateIds === undefined ? [] : input.templateIds, true);
    // 新的内容域必须显式选择范围；旧设计连接永远不会因默认值获得产品或文章权限。
    const hasContentDomain = allowedScopes.some(scope => scope.startsWith('content:') || scope.startsWith('seo:')) || allowedTemplates === null || allowedTemplates.length > 0;
    const allowedRecords = recordIds(input.recordIds === undefined && !hasContentDomain ? { productIds: [], entryIds: [] } : input.recordIds, true);
    const now = new Date(), stamp = now.toISOString();
    const count = getDatabase().prepare('SELECT count(*) n FROM cms_external_ai_token WHERE actor_id=? AND revoked_at IS NULL AND expires_at>?').get(owner.id, stamp) as { n: number };
    if (count.n >= 50) throw new ApiError(429, '可用连接已达50个，请先撤销不再使用的连接');
    const id = `eait-${randomUUID()}`, token = `fsai_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(token).digest('hex'), expiresAt = new Date(now.getTime() + (days as number) * 86400000).toISOString();
    getDatabase().prepare('INSERT INTO cms_external_ai_token(id,actor_id,name,token_hash,token_hint,scopes_json,page_ids_json,record_ids_json,template_ids_json,created_at,expires_at,revoked_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run(id, owner.id, name, hash, `fsai_••••${token.slice(-4)}`, JSON.stringify(allowedScopes), JSON.stringify(allowedPages), JSON.stringify(allowedRecords), JSON.stringify(allowedTemplates), stamp, expiresAt);
    recordAudit(owner, 'external.ai.token.create', 'success', { objectIds: [id], fields: allowedScopes });
    return { credential: summary(getDatabase().prepare(`${SELECT} WHERE id=?`).get(id) as TokenRow), token };
  }).immediate();
}

export function listExternalAiTokens(actor: Actor): ExternalAiTokenSummary[] {
  const owner = currentAdministrator(actor);
  // 可用连接最多50条，优先全部展示，不能被较新的撤销历史挤出而失去撤销入口。
  const rows = getDatabase().prepare(`${SELECT} WHERE actor_id=? ORDER BY CASE WHEN revoked_at IS NULL AND expires_at>? THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 100`).all(owner.id, new Date().toISOString()) as TokenRow[];
  return rows.map(summary);
}

/** 撤销与审计同事务；重复撤销返回同一结果，不重复产出审计事件。 */
export function revokeExternalAiToken(value: unknown, actor: Actor): ExternalAiTokenSummary {
  const id = credentialId(value);
  return getDatabase().transaction(() => {
    const owner = currentAdministrator(actor), row = getDatabase().prepare(`${SELECT} WHERE id=? AND actor_id=?`).get(id, owner.id) as TokenRow | undefined;
    if (!row) throw new ApiError(404, '找不到当前账号的连接');
    if (!row.revoked_at) {
      row.revoked_at = new Date().toISOString();
      getDatabase().prepare('UPDATE cms_external_ai_token SET revoked_at=? WHERE id=? AND actor_id=?').run(row.revoked_at, id, owner.id);
      recordAudit(owner, 'external.ai.token.revoke', 'success', { objectIds: [id] });
    }
    return summary(row);
  }).immediate();
}

function checkedGrant(row: TokenRow | undefined, scope: ExternalAiScope, access: ExternalAiAccess = {}): ExternalAiGrant {
  if (!row || row.revoked_at || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()) throw new ApiError(401, '外部AI连接已过期、撤销或无效');
  const member = getDatabase().prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(row.actor_id) as MemberRow | undefined;
  if (!member || isMemberDisabled(member)) throw new ApiError(401, '外部AI连接的负责人已停用');
  if (member.role !== 'admin') throw new ApiError(403, '外部AI连接的负责人已没有管理权限');
  const allowed = policy(row);
  if (!allowed.scopes.includes(scope)) throw new ApiError(403, '这条连接没有此类操作的权限，请在站点设置中创建具备相应权限的连接');
  if (allowed.pageIds !== null && (access.global || access.pageIds?.some(id => !allowed.pageIds!.includes(id)))) throw new ApiError(403, '操作超出了这条连接允许的页面范围');
  if (allowed.templateIds !== null && access.templateIds?.some(id => !allowed.templateIds!.includes(id))) throw new ApiError(403, '操作超出了这条连接允许的详情模板范围');
  for (const [kind, key] of [['product', 'productIds'], ['entry', 'entryIds']] as const) {
    const ids = allowed.recordIds[key];
    if (ids !== null && (access.createKind === kind || access[key]?.some(id => !ids.includes(id)))) throw new ApiError(403, '操作超出了这条连接允许的产品或内容范围；新建需明确授权整类内容');
  }
  return { tokenId: row.id, actor: { id: member.id, name: member.name, email: member.email, role: 'admin' }, ...allowed, expiresAt: row.expires_at };
}

/** 机器入口只认Authorization，不回退Cookie、查询参数或后台会话。 */
export function requireExternalAiGrant(request: Request, scope: ExternalAiScope = 'read'): ExternalAiGrant {
  const match = TOKEN_PATTERN.exec(request.headers.get('authorization') || '');
  if (!match) throw new ApiError(401, '请在Authorization中提供有效的Bearer连接凭据');
  const hash = createHash('sha256').update(match[1]).digest('hex');
  const row = getDatabase().prepare(`${SELECT} WHERE token_hash=?`).get(hash) as TokenRow | undefined;
  const grant = checkedGrant(row, scope);
  // OAuth是单resource凭据；手工Bearer保持原权限，OAuth不能借其他API绕过MCP范围。
  const audience=getDatabase().prepare('SELECT resource FROM cms_mcp_oauth_access WHERE token_id=?').get(grant.tokenId) as {resource:string}|undefined;
  if (audience) {
    const expected = new URL('/api/mcp', getAuthEnvironment().baseURL), target = new URL(request.url), host = request.headers.get('host');
    // Next可将URL来源重建为内部localhost；公开resource和Host仍须精确绑定当前配置，不能只凭路径放行。
    const trustedHost = host === null ? target.origin === expected.origin : host.toLowerCase() === expected.host.toLowerCase();
    if (audience.resource !== expected.href || !trustedHost || !['http:', 'https:'].includes(target.protocol) || target.pathname !== '/api/mcp' || request.url.includes('?') || request.url.includes('#')) throw new ApiError(401, 'OAuth连接只能用于获授权的MCP入口');
  }
  // 私有最近使用时间最多每分钟更新一次，不把机器调用正文或凭据带入审计。
  if (!row!.last_used_at || Date.parse(row!.last_used_at) < Date.now() - 60000) getDatabase().prepare('UPDATE cms_external_ai_token SET last_used_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(), row!.id);
  return grant;
}

/** 长任务提交前再次调用；不能使用首次认证后缓存的角色、吊销状态或页面授权。 */
export function revalidateExternalAiGrant(grant: ExternalAiGrant, scope: ExternalAiScope = 'read', access: ExternalAiAccess = {}): ExternalAiGrant {
  const id = credentialId(grant.tokenId);
  const row = getDatabase().prepare(`${SELECT} WHERE id=? AND actor_id=?`).get(id, grant.actor.id) as TokenRow | undefined;
  return checkedGrant(row, scope, access);
}
