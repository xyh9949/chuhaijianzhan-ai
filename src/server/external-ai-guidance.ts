import { captureDesignGuidance, readAiDesignGuidance, type DesignGuidanceCapture } from './ai-design-guidance';
import { revalidateExternalAiGrant, type ExternalAiGrant } from './external-ai-tokens';
import { ApiError } from './http';

export const DESIGN_GUIDANCE_SCOPE = 'design-guidance:read' as const;

/** 模型摘要也可能转述约定；撤权后整份guided候选拒绝读取，不能只删版本戳假装已脱敏。 */
export function assertExternalGuidedViewAccess(grant: ExternalAiGrant, view: { designGuidance?: { active: boolean; privateInputUsed?: boolean } }) {
  if (view.designGuidance?.active || view.designGuidance?.privateInputUsed) revalidateExternalAiGrant(grant, DESIGN_GUIDANCE_SCOPE);
}

/** 全站设计约定是独立显式授权，不随页面读取或整站设计权限自动外发。 */
export function externalAiDesignGuidance(grant: ExternalAiGrant) {
  grant = revalidateExternalAiGrant(grant, DESIGN_GUIDANCE_SCOPE);
  const profile = readAiDesignGuidance(grant.actor);
  revalidateExternalAiGrant(grant, DESIGN_GUIDANCE_SCOPE);
  return { revision: profile.revision, enabled: profile.enabled, preferredStyle: profile.preferredStyle, preserveNotes: profile.preserveNotes, avoidStyles: profile.avoidStyles, feedback: profile.feedback.map(item => item.text), advisory: true,
    policy: 'Design references only; the current explicit task overrides preferences. Native locks, preserveText, device and resource scopes remain mandatory. Saving feedback requires the user in the administrator interface; this tool cannot learn or write preferences.' };
}

/** 提交重试先读取已成功回执；只有新提案才核对当前约定版本，避免旧回执因偏好更新失去幂等性。 */
export function checkExternalGuidanceField(grant: ExternalAiGrant, input: Record<string, unknown>) {
  if (!grant.scopes.includes(DESIGN_GUIDANCE_SCOPE) && Object.hasOwn(input, 'guidanceRevision')) throw new ApiError(422, '当前连接未获设计约定读取权限，请移除约定版本字段');
}

export function externalGuidanceForRequest(grant: ExternalAiGrant, input: Record<string, unknown>, requireVersion = false): { guidance?: DesignGuidanceCapture } {
  checkExternalGuidanceField(grant, input);
  if (!grant.scopes.includes(DESIGN_GUIDANCE_SCOPE)) return {};
  grant = revalidateExternalAiGrant(grant, DESIGN_GUIDANCE_SCOPE);
  const present = Object.hasOwn(input, 'guidanceRevision');
  if (requireVersion && !present) throw new ApiError(422, '请先读取设计上下文，并原样带回其中的设计约定版本');
  if (present && (!Number.isSafeInteger(input.guidanceRevision) || Number(input.guidanceRevision) < 0)) throw new ApiError(422, '设计约定版本无效');
  const guidance = captureDesignGuidance(grant.actor);
  if (present && input.guidanceRevision !== guidance.revision) throw new ApiError(409, '设计约定已更新，请重新读取上下文后准备方案');
  return { guidance };
}
