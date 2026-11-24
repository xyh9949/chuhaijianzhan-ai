import type { AiPageEditChange, AiPageEditIntent } from './ai-page-edit-types';
import type { AiDesignGuidanceStamp } from './ai-design-guidance-types';
import type { AiDesignTreeUnit } from './ai-design-asset-details';

/** 详情布局只选已有模板和真实样本；模板规则及业务记录不由设计请求改写。 */
export interface AiDetailDesignRequest {
  expectedRevision: number;
  templateId: string;
  recordId?: string;
  instruction: string;
  preserveText: boolean;
  targetId?: string;
  viewport?: 'all' | 'desktop' | 'tablet' | 'mobile';
  baseDesignId?: string;
}
export interface AiDetailDesignTemplate { id: string; name: string; kind: 'product' | 'entry'; modelId?: string; }
/** matched=false只表示强制查看此布局，不改变实际选用规则。 */
export interface AiDetailDesignSample {
  kind: 'product' | 'entry'; id: string; label: string; url: string;
  matched: boolean; reason: string;
}
export interface AiDetailDesignScope {
  templateId: string; templateName: string; kind: 'product' | 'entry'; modelId?: string;
  nodeCount: number; lockedIds: string[]; targetId?: string;
}
export interface AiDetailDesignPreview {
  designGuidance?: AiDesignGuidanceStamp;
  designId: string; templateId: string; baseRevision: number;
  createdAt: string; expiresAt: string; appliedRevision: number | null; undoneRevision: number | null;
  request: AiDetailDesignRequest; template: AiDetailDesignTemplate; scope: AiDetailDesignScope;
  summary: string; intent?: AiPageEditIntent; changes: AiPageEditChange[]; warnings: string[];
  sample: AiDetailDesignSample | null; previewAvailable: boolean; beforeUrl: string; afterUrl: string;
  unavailableReason?: string; refinement?: { baseDesignId: string; round: number };
  canUndo?: boolean; undoReason?: string;
  /** 旧预览可缺省；选择只创建真实派生预览，仍需本人确认采用。 */
  selectionUnits?: AiDesignTreeUnit[];
  selectionUnavailableReason?: string;
  selection?: { sourceDesignId: string; unitIds: string[] };
}
