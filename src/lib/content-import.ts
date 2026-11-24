export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 500;
export interface ContentImportSpec { format: 'csv' | 'json'; content: string; target: 'product' | 'entry'; modelId?: string; mapping: Record<string, string>; }
export interface ImportIssue { row: number; field: string; message: string; }
export interface ImportPreview { revision: number; rowCount: number; headers: string[]; rows: { row: number; key: string; title: string; sku: string; slug: string; values: Record<string, unknown> }[]; errors: ImportIssue[]; warnings: string[]; confirmation?: string; }
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function headersFor(values: unknown[]): string[] {
  if (!values.length || values.length > 110 || values.some(v => typeof v !== 'string' || !v.trim() || v.length > 120 || forbidden.has(v.trim()) || /[\u0000-\u001f]/.test(v))) throw new Error('列名需为1–120字符，最多110列，不得为空或使用保留名称');
  const headers = values.map(v => String(v).trim());
  if (new Set(headers.map(h => h.toLowerCase())).size !== headers.length) throw new Error('列名不能重复（不区分大小写）');
  return headers;
}
/** 严格CSV：UTF-8、逗号分隔、双引号转义，支持引号内换行；错误行不猜测或截断。 */
export function parseImportFile(format: ContentImportSpec['format'], content: string, target: ContentImportSpec['target']) {
  const input = content.replace(/^\uFEFF/, '');
  if (format === 'json') {
    const data = JSON.parse(input);
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.schemaVersion !== 1 || data.kind !== target || Object.keys(data).some(k => !['schemaVersion', 'kind', 'rows'].includes(k)) || !Array.isArray(data.rows) || !data.rows.length || data.rows.length > IMPORT_MAX_ROWS) throw new Error('JSON需为schemaVersion=1、kind与目标一致、rows含1–500行的导入对象');
    const columns = new Set<string>();
    for (const row of data.rows) { if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('JSON每行必须是对象'); for (const [k, v] of Object.entries(row)) { columns.add(k); if (v !== null && typeof v === 'object' && (!Array.isArray(v) || v.some(x => typeof x !== 'string'))) throw new Error('JSON值只支持文本、数字、布尔、null及文本数组'); } }
    const headers = headersFor([...columns]); if ([...columns].some((h, i) => h !== headers[i])) throw new Error('JSON列名不能包含首尾空格');
    return { headers, rows: data.rows as Record<string, unknown>[], lineNumbers: data.rows.map((_: unknown, i: number) => i + 1) as number[] };
  }
  const table: string[][] = [], lineNumbers: number[] = []; let row: string[] = [], cell = '', quoted = false, closed = false, physicalLine = 1, rowStart = 1;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; if (row.length > 110) throw new Error('CSV最多110列'); };
  const finishRow = () => { finishCell(); if (row.some(v => v !== '')) { table.push(row); lineNumbers.push(rowStart); } row = []; if (table.length > IMPORT_MAX_ROWS + 1) throw new Error('单次最多导入500行'); };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (c === '\n' || c === '\r' && input[i + 1] !== '\n') physicalLine++; if (c === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === ',') finishCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i++; finishRow(); physicalLine++; rowStart = physicalLine; }
    else if (c === '"' && !cell && !closed) quoted = true;
    else { if (c === '"' || closed) throw new Error(`CSV第${rowStart}行引号格式无效`); cell += c; }
    if (cell.length > 100000) throw new Error('单元格过长，请拆分内容');
  }
  if (quoted) throw new Error('CSV引号未闭合'); if (cell || closed || row.length) finishRow();
  if (table.length < 2) throw new Error('CSV需包含列名和至少一行数据');
  const headers = headersFor(table.shift()!); lineNumbers.shift();
  const rows = table.map((r, i) => { if (r.length !== headers.length) throw new Error(`CSV第${lineNumbers[i]}行列数与表头不一致`); return Object.fromEntries(headers.map((h, j) => [h, r[j]])); });
  return { headers, rows, lineNumbers };
}
