import { randomUUID } from 'node:crypto';
import type { Inquiry, InquiryFollowUp } from '../lib/types';
import { getDatabase } from './database';
import { ApiError } from './http';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';
import { identifier, text } from './validation';

type StoredInquiry = Inquiry & { followUps?: InquiryFollowUp[] };
type AssigneeRow = Pick<MemberRow, 'id' | 'name' | 'role' | 'banned' | 'banExpires'>;
const workflowFields = ['assigneeId', 'priority', 'nextFollowUpAt', 'qualification', 'followUpNote'];

/** 负责人目录仅暴露可分配成员的最小资料，不能借询盘读取成员邮箱或管理字段。 */
export function listInquiryAssignees() {
  const db = getDatabase();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_user'").get()) return [];
  return (db.prepare("SELECT id,name,role,banned,banExpires FROM auth_user WHERE role IN ('admin','editor') ORDER BY name,id").all() as AssigneeRow[])
    .filter(member => !isMemberDisabled(member)).map(({ id, name, role }) => ({ id, name, role }));
}

/** 运行JSON保留完整历史；后台列表和普通保存回包只带摘要，避免逐次下载所有客户备注。 */
export function projectInquiry(item: StoredInquiry, revision: number, availableAssignees?: ReadonlySet<string>) {
  const { followUps, assigneeAvailable: _available, followUpCount: _count, lastFollowUpAt: _last, ...summary } = item;
  const history = Array.isArray(followUps) ? followUps : [];
  const available = item.assignee ? (availableAssignees ?? new Set(listInquiryAssignees().map(member => member.id))).has(item.assignee.id) : undefined;
  return { ...summary, revision, followUpCount: history.length, ...(history.length ? { lastFollowUpAt: history[history.length - 1].createdAt } : {}), ...(item.assignee ? { assigneeAvailable: available } : {}) };
}

/** 详情按需读取完整内部记录；revision与历史来自同一行，客户端据此识别过期的详情。 */
export function listInquiryFollowUps(id: string) {
  const row = getDatabase().prepare('SELECT revision,payload_json FROM cms_inquiry WHERE id=?').get(id) as { revision: number; payload_json: string } | undefined;
  if (!row) throw new ApiError(404, '询盘不存在');
  const item = JSON.parse(row.payload_json) as StoredInquiry;
  return { items: item.followUps ?? [], revision: row.revision };
}

/** 调用方持有询盘写事务；分配资格复核、追加记录和普通状态修改共用同一版本。 */
export function applyInquiryFollowUpPatch(item: StoredInquiry, input: Record<string, unknown>, actor?: Actor, stamp = new Date().toISOString()): StoredInquiry {
  if (actor) requirePermission(actor, 'edit');
  if (workflowFields.some(field => input[field] !== undefined) && !actor) throw new ApiError(401, '请先登录后更新询盘跟进');
  let currentActor: AssigneeRow | undefined;
  if (actor) {
    // HTTP读取请求体期间可能发生降权、停用或改名；持有写事务后再次读取当前身份。
    currentActor = getDatabase().prepare('SELECT id,name,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as AssigneeRow | undefined;
    if (!currentActor || isMemberDisabled(currentActor)) throw new ApiError(401, '账号已停用或会话已失效');
    requirePermission({ ...actor, role: currentActor.role }, 'edit');
  }
  const next = { ...item };
  // 这些字段是当前成员状态和历史的投影，绝不固化到客户运行记录中。
  delete next.assigneeAvailable; delete next.followUpCount; delete next.lastFollowUpAt;
  if (input.assigneeId !== undefined) {
    if (input.assigneeId === null) delete next.assignee;
    else {
      const id = identifier(input.assigneeId, '负责人');
      const member = listInquiryAssignees().find(candidate => candidate.id === id);
      if (!member) throw new ApiError(422, '负责人必须是当前可用的管理员或编辑成员');
      // 姓名快照保留当时负责人；成员改名、停用或未来删除都不会抹掉业务历史。
      next.assignee = { id: member.id, name: member.name };
    }
  }
  if (input.priority !== undefined) {
    if (typeof input.priority !== 'string' || !['normal', 'high', 'urgent'].includes(input.priority)) throw new ApiError(422, '询盘优先级不正确');
    next.priority = input.priority as StoredInquiry['priority'];
  }
  if (input.qualification !== undefined) {
    if (typeof input.qualification !== 'string' || !['unreviewed', 'qualified', 'invalid'].includes(input.qualification)) throw new ApiError(422, '询盘质量判断不正确');
    next.qualification = input.qualification as StoredInquiry['qualification'];
  }
  if (input.nextFollowUpAt !== undefined) {
    const value = input.nextFollowUpAt;
    // 必须提交带毫秒的UTC时间；拒绝本地无时区文本和会被Date自动纠正的无效日期。
    if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) throw new ApiError(422, '下次跟进时间必须是有效的UTC时间');
    next.nextFollowUpAt = value;
  }
  if (input.followUpNote !== undefined) {
    const note = text(input.followUpNote, '跟进记录', 2000, true).trim();
    const history = item.followUps ?? [];
    if (history.length >= 200) throw new ApiError(422, '每条询盘最多保留200条跟进记录，已有历史不会被自动删除');
    // 只追加内部备注；作者和时间由当前认证会话与服务端生成，不触发邮件或其他外发。
    next.followUps = [...history, { id: `follow-up-${randomUUID()}`, note, createdAt: stamp, actorId: currentActor!.id, actorName: currentActor!.name }];
  }
  return next;
}
