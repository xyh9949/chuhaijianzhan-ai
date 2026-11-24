import type { SeoSearchReport, SeoKeywordReport } from '../../src/lib/seo-types';
import type { UiAudit } from './fixtures';

// 仅替换只读报告DTO，明确标记合成来源；不配置真实Google/关键词接口或写入报告库。
export function installSeoReports(ui: UiAudit) {
  const common = { connectionRevision: 0, createdAt: '2026-01-01T10:00:00.000Z', coverage: { partial: true, reasons: ['UI自动回归合成资料，仅用于检查排版和0/缺失含义'], rowCount: 17 }, warnings: ['此报告是本机UI夹具，不代表真实Google或供应商数据。'] };
  const search: SeoSearchReport = { ...common, id: 'ui-report-search', kind: 'search', provider: 'gsc', source: { name: 'UI_SEARCH_REPORT 合成报告', url: 'https://example.invalid/report', sourceMock: true }, scope: { property: 'https://ui-regression.example.invalid/', startDate: '2025-12-01', endDate: '2025-12-28', timeZone: 'America/Los_Angeles', country: 'usa', device: 'MOBILE' }, rows: Array.from({ length: 17 }, (_, index) => ({ rowNumber: index + 1, page: 'https://ui-regression.example.invalid/products/ui-product-1', query: `UI_SEARCH_QUERY_${index + 1}_` + 'LongSearchPhrase'.repeat(7), clicks: index === 15 ? 0 : index + 1, impressions: index === 15 ? 0 : (index + 1) * 10, ctr: index === 15 ? 0 : 0.1, position: index === 15 ? 0 : 4.25 })) };
  const keyword: SeoKeywordReport = { ...common, id: 'ui-report-keywords', kind: 'keywords', provider: 'dataforseo', source: { name: 'UI_KEYWORD_REPORT 合成报告', url: 'https://example.invalid/report', sourceMock: true }, scope: { startDate: '2025-12-01', endDate: '2025-12-31', timeZone: '供应商未提供', languageCode: 'en', locationCode: 2840, currency: 'USD' }, rows: Array.from({ length: 17 }, (_, index) => ({ rowNumber: index + 1, keyword: `UI_KEYWORD_${index + 1}_` + 'LongKeyword'.repeat(8), searchVolume: index === 15 ? 0 : null, cpc: index === 15 ? 0 : null, competition: index === 15 ? 'LOW' : null, competitionIndex: index === 15 ? 0 : null, monthlySearches: [{ year: 2025, month: 12, searchVolume: index === 15 ? 0 : null }, { year: 2025, month: 11, searchVolume: null }] })) };
  ui.jsonGet('/api/seo/sources', { mockMode: true, gsc: { revision: 0, clientId: '', hasClientSecret: false, connected: false, property: '', redirectUri: '', scope: 'https://www.googleapis.com/auth/webmasters.readonly' }, keywords: { revision: 0, login: '', hasPassword: false } });
  ui.jsonGet('/api/seo/sources/reports', { items: [search, keyword].map(({ rows: _rows, ...summary }) => summary) });
  ui.jsonGet(`/api/seo/sources/reports/${search.id}`, search);
  ui.jsonGet(`/api/seo/sources/reports/${keyword.id}`, keyword);
  return { search, keyword };
}
