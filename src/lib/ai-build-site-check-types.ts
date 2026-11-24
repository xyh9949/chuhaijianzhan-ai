export type AiBuildCheckStatus = 'checked' | 'warning' | 'skipped';

export type AiBuildCheckEditorTarget = { kind: 'page' | 'template' | 'block'; id: string; nodeId: string };

export interface AiBuildCheckLocation {
  pageId: string;
  path: string;
  previewPath: string;
  /** 预览内实际渲染的标识，复用区块实例可能与编辑器原始 ID 不同。 */
  nodeId: string;
  viewportWidth: number;
  target?: AiBuildCheckEditorTarget;
}

export type AiBuildCheckIssueCode = 'overflow' | 'heading-count' | 'split-heading' | 'small-button' | 'broken-image' | 'pending-image' | 'disabled-button' | 'unvisited-link' | 'form';

export interface AiBuildCheckIssue {
  code: AiBuildCheckIssueCode;
  message: string;
  widths: number[];
  location?: AiBuildCheckLocation;
}

export interface AiBuildMobileMeasurement {
  width: number;
  overflow: number;
  headings: number;
  splitWords: number;
  smallActions: number;
  brokenImages: number;
  pendingImages: number;
}

export interface AiBuildCheckPage {
  pageId: string;
  title: string;
  path?: string;
  previewPath?: string;
  dynamic: boolean;
  status: AiBuildCheckStatus;
  mobile: AiBuildMobileMeasurement[];
  notes: string[];
  issues: AiBuildCheckIssue[];
}

export interface AiBuildCheckJourney {
  entry: 'home' | 'product';
  status: AiBuildCheckStatus | 'form-only';
  steps: { from: string; to: string; label: string }[];
  form?: { path: string; fields: number; unlabelled: number };
  note: string;
  location?: AiBuildCheckLocation;
}

export interface AiBuildSiteCheckReport {
  source: 'build' | 'draft';
  previewId?: string;
  checkedAt: string;
  baseRevision: number;
  pages: AiBuildCheckPage[];
  journeys: AiBuildCheckJourney[];
  pageLimit: number;
  /** 未纳入抽查的真实路径按语言计数，避免误称整个目录和语言均已检查。 */
  languages: { code: string; notSampled: number }[];
  coverage: string[];
}
