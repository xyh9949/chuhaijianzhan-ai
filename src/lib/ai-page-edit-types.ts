import type { ResponsiveDesign } from './responsive-style';
import type { AiDesignDifference } from './ai-design-difference';
import type { AiDesignGuidanceStamp } from './ai-design-guidance-types';
import type { PRODUCT_DETAIL_ORDERS } from './product-detail-presentation';

/** 只接收目标标识和编辑意图；实际节点与绑定由服务器读取。 */
export interface AiPageEditRequest {
  pageId: string;
  targetId?: string;
  expectedRevision: number;
  instruction: string;
  mode: 'design' | 'copy' | 'mixed';
  preserveText: boolean;
  lockedIds: string[];
  /** 继续调整仅引用本人私有候选；服务器读取候选，不接受客户端页面JSON。 */
  baseEditId?: string;
  /** 单端修改仅写对应断点样式，结构和文案仍属于全端。 */
  viewport?: 'all' | 'desktop' | 'tablet' | 'mobile';
  previewFeedback?: import('./ai-preview-inspection').AiPreviewFeedback[];
}
export interface AiPageEditIntent { goal: string; decisions: string[]; preserve: string[]; assumptions: string[]; }
export interface AiPageEditScope { pageId: string; pageTitle: string; targetId?: string; label: string; nodeCount: number; lockedIds: string[]; }
export interface AiPageEditChange { nodeId: string; label: string; kind: string; description: string; }
export interface AiPageEditPreview {
  designGuidance?: AiDesignGuidanceStamp;
  editId: string; pageId: string; baseRevision: number; scope: AiPageEditScope;
  summary: string; changes: AiPageEditChange[]; warnings: string[];
  beforeUrl: string; afterUrl: string; expiresAt: string;
  appliedRevision: number | null; undoneRevision: number | null;
  canUndo?: boolean;
  request?: AiPageEditRequest;
  difference?: AiDesignDifference;
  intent?: AiPageEditIntent;
  refinement?: { baseEditId: string; round: number };
}
export interface AiPageEditInsertNode {
  tempId: string;
  type: 'Container' | 'Heading' | 'Text' | 'Divider' | 'Spacer' | 'Image' | 'ActionButton' | 'Accordion' | 'Gallery';
  text?: string; level?: 'h1' | 'h2' | 'h3' | 'h4'; design?: ResponsiveDesign;
  mediaId?: string; alt?: string; linkTarget?: import('./types').LinkTarget;
  /** AI新增折叠面板仅创建可拖放插槽，子树继续通过原生命令插入或移动。 */
  items?: { title?: string; titleFrom?: string }[];
  firstOpen?: boolean;
  /** 产品卡片或详情模板可选当前记录字段；数据源与兼容性由服务端核对。 */
  bindings?: Partial<Record<'text' | 'src' | 'alt' | 'href' | 'images', string>>;
}
export type AiPageEditOperation =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'design'; id: string; design: ResponsiveDesign }
  | { kind: 'navigationMode'; id: string; mobileMode: 'collapse' | 'inline' }
  | { kind: 'productDetailOrder'; id: string; order: typeof PRODUCT_DETAIL_ORDERS[number] }
  | { kind: 'accordionFree'; id: string }
  | { kind: 'expandGallery'; id: string }
  | { kind: 'layout'; id: string; layout: 'column' | 'row' | 'grid'; columns?: number; gap?: number }
  | { kind: 'reorder'; id: string; slot?: string; children: string[] }
  | { kind: 'insert'; parentId: string; slot?: string; index: number; node: AiPageEditInsertNode }
  | { kind: 'move'; id: string; parentId: string; slot?: string; index: number }
  | { kind: 'remove'; id: string }
  | { kind: 'image'; id: string; mediaId: string; alt?: string }
  | { kind: 'link'; id: string; target: import('./types').LinkTarget }
  | { kind: 'bind'; id: string; target: 'text' | 'src' | 'alt' | 'href' | 'images'; field: string }
  | { kind: 'productCard'; id: string; operations: AiPageEditOperation[] };
