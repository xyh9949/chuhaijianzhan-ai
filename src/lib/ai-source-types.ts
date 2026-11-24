import type { FieldValue } from './types';

/** SKU 只作为匹配键。历史回执保存字段级差异，不保存原上传文件。 */
export const EXCEL_UPDATE_PARAMETER_TYPES = ['text', 'textarea', 'number', 'boolean', 'date', 'select', 'multiselect', 'url'] as const;
export interface ExcelSkuChange { field: string; label: string; before: FieldValue; beforePresent: boolean; after: FieldValue; }
export interface ExcelSkuRow { row: number; productId: string; sku: string; title: string; modelId?: string; changes: ExcelSkuChange[]; }
export interface ExcelSkuReceipt { id: string; fileName: string; rowCount: number; appliedAt: string; expiresAt: string; undone: boolean; }

/** 资料提取只产生待核对文字，不包含原始文件地址、公开素材或模型调用凭据。 */
export interface AiSourcePdfPage {
  pageNumber: number;
  text: string;
  /** 无可用文字层时保留页面，不把扫描页误当成企业没有资料。 */
  needsOcr: boolean;
  originalText?: string;
  /** OCR文字是本地识别的待核对稿；保留原文字层，不能当成已确认企业事实。 */
  ocr?: { text: string; confidence: number; language: 'eng' | 'chi_sim' | 'eng+chi_sim'; createdAt: string; needsReview: true };
}
export interface AiSourceSheetRow {
  rowNumber: number;
  hidden?: boolean;
  /** 以零为起点的连续列数组，空单元格保留为空串，0/false不丢失。 */
  cells: string[];
  /** 一起点列号；仅使用文件内缓存结果，不计算公式。 */
  formulaColumns: number[];
}
export interface AiSourceSheet {
  /** Excel原工作表顺序，从1开始；不以可能重复/空白的表头作为标识。 */
  index: number;
  name: string;
  hidden: boolean;
  /** 一起点列号；默认导入/发送范围应排除隐藏行列，用户可在核对阶段显式选择。 */
  hiddenColumns?: number[];
  rowCount: number;
  columnCount: number;
  rows: AiSourceSheetRow[];
}
export interface AiExtractedSource {
  kind: 'pdf' | 'xlsx';
  fileName: string;
  mime: string;
  bytes: number;
  sha256: string;
  textChars: number;
  warnings: string[];
  pages?: AiSourcePdfPage[];
  sheets?: AiSourceSheet[];
  /** 仅新上传的来源可再次离线处理；私有文件路径与二进制不返回浏览器。 */
  enhancementAvailable?: boolean;
  images?: AiSourceImage[];
  enhancementWarnings?: string[];
}

/** 这里只是文档实际嵌入的位图，不能把PDF整页渲染图冒充产品原图。 */
export interface AiSourceImage {
  id: string;
  mime: 'image/webp';
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  adoptedMediaId?: string;
  source: { kind: 'pdf'; pageNumber: number; objectIndex: number; possiblePageScan: boolean } | { kind: 'xlsx'; sheetIndex: number; sheetName: string; row: number; column: number; endRow?: number; hidden: boolean };
}
export interface AiSourceEnhanceRequest { pageNumbers?: number[]; ocr: boolean; images: boolean; language: 'eng' | 'chi_sim' | 'eng+chi_sim'; }

export const AI_SOURCE_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxPdfPages: 100,
  maxPdfTextChars: 150_000,
  maxSheets: 10,
  maxRows: 1_000,
  maxColumns: 64,
  maxCellChars: 6_000,
  maxWorkbookTextChars: 300_000,
  maxZipEntries: 2_048,
  maxZipEntryBytes: 16 * 1024 * 1024,
  maxZipExpandedBytes: 32 * 1024 * 1024,
  maxZipRatio: 200,
  parserTimeoutMs: 15_000,
} as const;
