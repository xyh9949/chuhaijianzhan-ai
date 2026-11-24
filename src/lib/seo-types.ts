/** 搜索数据始终带来源、时间和覆盖；Google实绩与供应商估算不能混作同一指标。 */
export interface SeoReportSource { name: string; url: string; sourceMock: boolean; }
export interface SeoReportScope {
  property?: string; startDate: string; endDate: string; timeZone: string;
  country?: string; device?: string; locationCode?: number; languageCode?: string; currency?: string;
}
export interface SeoReportCoverage { partial: boolean; reasons: string[]; rowCount: number; pagesFetched?: number; maxRows?: number; }
export interface SeoSearchRow { rowNumber: number; page: string; query: string; clicks: number; impressions: number; ctr: number; position: number; }
export interface SeoKeywordRow { rowNumber: number; keyword: string; searchVolume: number | null; cpc: number | null; competition: string | null; competitionIndex: number | null; monthlySearches: { year: number; month: number; searchVolume: number | null }[]; }
interface SeoReportBase { id: string; connectionRevision: number; createdAt: string; source: SeoReportSource; scope: SeoReportScope; coverage: SeoReportCoverage; warnings: string[]; }
export interface SeoSearchReport extends SeoReportBase { kind: 'search'; provider: 'gsc'; rows: SeoSearchRow[]; }
export interface SeoKeywordReport extends SeoReportBase { kind: 'keywords'; provider: 'dataforseo' | 'csv'; rows: SeoKeywordRow[]; }
export type SeoDataReport = SeoSearchReport | SeoKeywordReport;
export type SeoReportSummary = Omit<SeoDataReport, 'rows'>;
export interface SeoGscConnection { revision: number; clientId: string; hasClientSecret: boolean; connected: boolean; property: string; redirectUri: string; scope: string; expiresAt?: string; }
export interface SeoKeywordConnection { revision: number; login: string; hasPassword: boolean; }
export interface SeoSourceSummary { gsc: SeoGscConnection; keywords: SeoKeywordConnection; mockMode: boolean; }

export interface SeoTarget { kind: 'page' | 'product' | 'entry'; id: string; url: string | null; label: string; }
export interface SeoEvidence {
  source: 'site' | 'rule' | 'gsc' | 'dataforseo' | 'csv';
  reportId?: string; rowNumbers?: number[]; description: string;
  startDate?: string; endDate?: string; timeZone?: string; country?: string; languageCode?: string; partial?: boolean;
}
export interface SeoMetadata { seoTitle: string; seoDescription: string; }
export interface SeoDiagnosticIssue {
  id: string; target?: SeoTarget; code: string; severity: 'error' | 'warning' | 'opportunity' | 'info';
  message: string; action: 'metadata' | 'content' | 'settings' | 'review'; evidence: SeoEvidence[];
  current?: { title: string; description: string };
}
export interface SeoDiagnosticReport {
  issues: SeoDiagnosticIssue[]; targets: SeoTarget[];
  coverage: { checkedTargets: number; totalTargets: number; truncated: boolean; notes: string[] }; generatedAt?: string;
}

/** 只允许标题和描述预览；地址、索引开关、正文和动态绑定继续走原编辑入口。 */
export interface SeoProposalRequest {
  target: Pick<SeoTarget, 'kind' | 'id'>; expectedRevision: number;
  seoTitle?: string; seoDescription?: string;
  useAi: boolean; instruction?: string; reportIds: string[];
}
export interface SeoProposalEvidence { reportId: string; rowNumbers: number[]; }
export interface SeoProposalPreview {
  proposalId: string; baseRevision: number; target: SeoTarget;
  before: SeoMetadata; after: SeoMetadata; summary: string;
  beforeDisplay?: SeoMetadata; afterDisplay?: SeoMetadata;
  changes: { field: 'seoTitle' | 'seoDescription'; label: string; before: string; after: string }[];
  evidence: SeoEvidence[]; warnings: string[]; sourceMock: boolean;
  beforeUrl?: string; afterUrl?: string; expiresAt: string;
  appliedRevision: number | null; undoneRevision: number | null; canUndo?: boolean;
}
