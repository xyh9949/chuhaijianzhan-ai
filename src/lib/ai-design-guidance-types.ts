/** 设计约定是可被本次需求覆盖的参考，不替代组件锁定、保留文字和授权范围。 */
export interface AiDesignFeedback { id: string; text: string; }
export interface AiDesignGuidance {
  revision: number; enabled: boolean; preferredStyle: string; preserveNotes: string; avoidStyles: string;
  feedback: AiDesignFeedback[]; updatedAt: string;
}
export interface AiDesignGuidanceInput extends Omit<AiDesignGuidance, 'revision' | 'updatedAt'> { expectedRevision: number; }
/** 候选只对外显示生成时的版本与是否参考；不把私有约定正文塞进普通候选回执。 */
export interface AiDesignGuidanceStamp { revision: number; active: boolean; stale?: boolean; privateInputUsed?: boolean; }
export const AI_DESIGN_GUIDANCE_LIMITS = { field: 1200, feedbackText: 600, feedbackCount: 8 } as const;
