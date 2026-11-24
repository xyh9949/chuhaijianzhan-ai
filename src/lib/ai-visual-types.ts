/** 视觉检查只引用本人已有候选；截图和建议不授予采用、发布或任意页面访问权限。 */
export type AiVisualDevice = 'desktop' | 'tablet' | 'mobile';
export type AiVisualCaptureMode = 'viewport' | 'page';
export interface AiVisualSection { number: number; from: number; to: number; pageHeight: number; }
export interface AiVisualInteractionState { kind: 'menu' | 'accordion' | 'tabs' | 'carousel'; label: string; }
export interface AiVisualPageCoverage {
  device: AiVisualDevice; mode: AiVisualCaptureMode; viewportHeight: number; pageHeight: number;
  startSection: number; endSection: number; totalSections: number; complete: boolean;
  /** 每个区间均为实际截图时测得的文档坐标；只覆盖首段或预算截断时不能冒称整页。 */
  intervals: { from: number; to: number }[]; nextStartSection?: number; reason?: string;
}
export interface AiVisualObservation {
  id: string; device: AiVisualDevice; kind: 'navigation' | 'anchor' | 'menu' | 'accordion' | 'tabs' | 'carousel' | 'form' | 'coverage';
  status: 'checked' | 'warning' | 'skipped'; title: string; detail: string; nodeId?: string; imageId?: string;
}
export interface AiVisualTarget {
  kind: 'page-edit' | 'site-design' | 'detail-design' | 'site-build';
  id: string;
  pageId?: string;
}
export interface AiVisualStatus {
  available: boolean;
  reason?: string;
  providerReady: boolean;
  visionModel?: string;
}
export interface AiVisualCaptureImage {
  id: string;
  device: AiVisualDevice;
  width: number;
  height: number;
  url: string;
  coverage: 'viewport' | 'page-segment' | 'interaction';
  section?: AiVisualSection;
  state?: AiVisualInteractionState;
  warnings: string[];
  fileSha256?: string;
}
export interface AiVisualCapture {
  id: string;
  target: AiVisualTarget;
  baseRevision?: number;
  createdAt: string;
  expiresAt: string;
  images: AiVisualCaptureImage[];
  warnings: string[];
  pageCoverage?: AiVisualPageCoverage[];
  observations?: AiVisualObservation[];
}
export interface AiVisualCaptureRequest { target: AiVisualTarget; devices: AiVisualDevice[]; mode?: AiVisualCaptureMode; startSection?: number; maxSections?: number; inspectInteractions?: boolean; }
export interface AiVisualIssue {
  id: string;
  device: AiVisualDevice;
  severity: 'warning' | 'suggestion';
  title: string;
  description: string;
  /** 只有服务端核对属于当前候选的真实节点才可返回；前端不会根据模型文字猜测节点。 */
  nodeId?: string;
  imageId?: string;
  suggestion: string;
}
export interface AiVisualReview {
  id: string;
  target: AiVisualTarget;
  captureId: string;
  imageIds?: string[];
  model?: string;
  summary: string;
  issues: AiVisualIssue[];
  suggestedInstruction: string;
  warnings: string[];
  createdAt: string;
  expiresAt: string;
}
export interface AiVisualReviewRequest { captureId: string; imageIds: string[]; instruction: string; }
export interface AiVisualReviewHistory { items: AiVisualReview[]; }
export interface AiVisualCaptureHistory { items: AiVisualCapture[]; }
