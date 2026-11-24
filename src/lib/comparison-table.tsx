import type { Config } from '@puckeditor/core';

export type ComparisonRow = { label: string; values: string[] };
export type ComparisonTableData = { title: string; modelColumns: string[]; rows: ComparisonRow[] };

export const comparisonTableLimits = { title: 160, column: 80, row: 120, cell: 500, minColumns: 2, maxColumns: 4, rows: 30 };
export const comparisonTableDefaults: ComparisonTableData = {
  title: 'Compare models',
  modelColumns: ['Model A', 'Model B'],
  rows: [{ label: 'Specification', values: ['', ''] }],
};

const text = (value: unknown, limit: number, required: boolean): value is string =>
  typeof value === 'string' && value.length <= limit && (!required || Boolean(value.trim()));

/** 型号列存为文字数组，区分通用布局的数字列数。草稿可留空标签，发布需要完整标题。 */
export function comparisonTableErrors(props: Record<string, unknown>, publishing = false): string[] {
  const { title, modelColumns, rows } = props;
  const limits = comparisonTableLimits;
  const errors: string[] = [];
  if (!text(title, limits.title, publishing)) errors.push('对比表标题无效，发布时请填写标题');
  if (!Array.isArray(modelColumns) || modelColumns.length < limits.minColumns || modelColumns.length > limits.maxColumns || modelColumns.some(column => !text(column, limits.column, publishing))) {
    errors.push('对比表需保留 2–4 列，发布时请填写每列的产品名称');
  }
  if (!Array.isArray(rows) || rows.length > limits.rows || (publishing && rows.length === 0)) {
    errors.push('对比表最多支持 30 个参数，发布时请至少填写一个');
  } else if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) ||
    Object.keys(row).some(key => key !== 'label' && key !== 'values') || !text(row.label, limits.row, publishing) ||
    !Array.isArray(row.values) || row.values.length !== (Array.isArray(modelColumns) ? modelColumns.length : 0) ||
    row.values.some((value: unknown) => !text(value, limits.cell, false)))) {
    errors.push('对比表参数名称或对比值无效，每个参数应与所有产品列对应');
  }
  return errors;
}

export const comparisonTableView: Config['components'][string] = {
  render: ({ title, modelColumns, rows }) => {
    if (comparisonTableErrors({ title, modelColumns, rows }).length) return <div className="site-comparison-table" />;
    const tableTitle = title.trim() || comparisonTableDefaults.title;

    // 语义表格在隔离预览与发布站点都可读，窄屏的焦点区域支持原生滚动。
    return <div className="site-comparison-table">
      <div className="site-comparison-scroll" role="region" aria-label={tableTitle} tabIndex={0}>
        <table>
          <caption>{tableTitle}</caption>
          <thead>
            <tr>
              <td />
              {(modelColumns as string[]).map((column, index) => <th key={index} scope="col">{column || '—'}</th>)}
            </tr>
          </thead>
          <tbody>
            {(rows as ComparisonRow[]).map((row, index) => <tr key={index}>
              <th scope="row">{row.label || '—'}</th>
              {row.values.map((value, cell) => <td key={cell}>{value || '—'}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>;
  },
};
