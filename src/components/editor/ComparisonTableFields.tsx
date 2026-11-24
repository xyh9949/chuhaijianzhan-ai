'use client';

import type { ReactNode } from 'react';
import { Button, Collapse, Form, Input, Popconfirm, Space } from 'antd';
import { createUsePuck, type Config } from '@puckeditor/core';
import { comparisonTableDefaults, comparisonTableLimits, type ComparisonRow } from '@/lib/comparison-table';
import { groupedEditorFields } from './DesignFields';

const useComparisonPuck = createUsePuck();

export const comparisonTableFields: Config['components'][string]['fields'] = {
  title: {
    type: 'custom', label: '对比表标题',
    render: ({ id, value, onChange, readOnly }) => <Form.Item label="对比表标题" htmlFor={id} layout="vertical">
      <Input id={id} maxLength={comparisonTableLimits.title} value={value} disabled={readOnly} onChange={event => onChange(event.target.value)} />
    </Form.Item>,
  },
};

export function comparisonTableRenderFields({ fields }: { fields: Record<string, ReactNode> }) {
  return groupedEditorFields({ fields: { ...fields, comparisonMatrix: <ComparisonMatrixFields /> } });
}

function moveItem<T>(items: T[], index: number, offset: number) {
  const next = [...items];
  [next[index], next[index + offset]] = [next[index + offset], next[index]];
  return next;
}

function ComparisonMatrixFields() {
  const { selectedItem: item, dispatch, getSelectorForId } = useComparisonPuck(state => state);
  if (!item || item.type !== 'ComparisonTable') return null;

  const { minColumns, maxColumns, column, row, cell, rows: maxRows } = comparisonTableLimits;
  const columns = (item.props.modelColumns || comparisonTableDefaults.modelColumns) as string[];
  const rows = (item.props.rows || []) as ComparisonRow[];
  const locked = Boolean(item.props.locked);

  // 一次替换同时更新列与单元格次序，保留节点标识；撤销时整张表作为一步还原。
  function change(nextColumns: string[], nextRows: ComparisonRow[]) {
    if (!item || locked) return;
    const selector = getSelectorForId(item.props.id);
    if (selector) dispatch({ type: 'replace', destinationIndex: selector.index, destinationZone: selector.zone,
      data: { ...item, props: { ...item.props, modelColumns: nextColumns, rows: nextRows } } });
  }

  const changeRow = (index: number, next: ComparisonRow) => change(columns, rows.map((current, i) => i === index ? next : current));
  const moveColumn = (index: number, offset: number) => change(moveItem(columns, index, offset), rows.map(current => ({ ...current, values: moveItem(current.values, index, offset) })));
  const removeColumn = (index: number) => change(columns.filter((_, i) => i !== index), rows.map(current => ({ ...current, values: current.values.filter((_, i) => i !== index) })));

  return <Space orientation="vertical" style={{ width: '100%' }} size={12}>
    <Collapse size="small" defaultActiveKey={['columns']} items={[{
      key: 'columns', label: `产品列（${columns.length}/${maxColumns}）`, children: <Space orientation="vertical" style={{ width: '100%' }}>
        {columns.map((name, index) => <Space key={index} orientation="vertical" style={{ width: '100%' }} size={4}>
          <Input aria-label={`产品列 ${index + 1} 名称`} placeholder={`产品列 ${index + 1} 名称`} maxLength={column} value={name} disabled={locked}
            onChange={event => change(columns.map((current, i) => i === index ? event.target.value : current), rows)} />
          <Space wrap size={4}>
            <Button size="small" aria-label={`左移产品列 ${index + 1}`} disabled={locked || index === 0} onClick={() => moveColumn(index, -1)}>左移</Button>
            <Button size="small" aria-label={`右移产品列 ${index + 1}`} disabled={locked || index === columns.length - 1} onClick={() => moveColumn(index, 1)}>右移</Button>
            <Popconfirm title="移除该产品列及对应值？" description="移除后可使用撤销恢复。" okText="移除" cancelText="取消" onConfirm={() => removeColumn(index)} disabled={locked || columns.length <= minColumns}>
              <Button size="small" danger aria-label={`移除产品列 ${index + 1}`} disabled={locked || columns.length <= minColumns}>移除</Button>
            </Popconfirm>
          </Space>
        </Space>)}
        <Button block disabled={locked || columns.length >= maxColumns} onClick={() => change([...columns, ''], rows.map(current => ({ ...current, values: [...current.values, ''] })))}>添加产品列</Button>
      </Space>,
    }]} />
    {rows.length > 0 && <Collapse size="small" defaultActiveKey={['0']} items={rows.map((current, index) => ({
      key: String(index), label: current.label || `参数 ${index + 1}`, children: <Space orientation="vertical" style={{ width: '100%' }}>
        <Input aria-label={`参数 ${index + 1} 名称`} placeholder="参数名称" value={current.label} maxLength={row} disabled={locked}
          onChange={event => changeRow(index, { ...current, label: event.target.value })} />
        {columns.map((name, position) => <Form.Item key={position} label={name || `产品列 ${position + 1}`} layout="vertical" style={{ marginBottom: 4 }}>
          <Input.TextArea aria-label={`参数 ${index + 1} · 产品列 ${position + 1} 的值`} value={current.values[position]} maxLength={cell} disabled={locked} autoSize={{ minRows: 1, maxRows: 3 }}
            onChange={event => changeRow(index, { ...current, values: current.values.map((value, i) => i === position ? event.target.value : value) })} />
        </Form.Item>)}
        <Space wrap size={4}>
          <Button size="small" aria-label={`上移参数 ${index + 1}`} disabled={locked || index === 0} onClick={() => change(columns, moveItem(rows, index, -1))}>上移</Button>
          <Button size="small" aria-label={`下移参数 ${index + 1}`} disabled={locked || index === rows.length - 1} onClick={() => change(columns, moveItem(rows, index, 1))}>下移</Button>
          <Popconfirm title="移除该参数及对应值？" description="移除后可使用撤销恢复。" okText="移除" cancelText="取消" onConfirm={() => change(columns, rows.filter((_, i) => i !== index))} disabled={locked}>
            <Button size="small" danger aria-label={`移除参数 ${index + 1}`} disabled={locked}>移除</Button>
          </Popconfirm>
        </Space>
      </Space>,
    }))} />}
    <Button block disabled={locked || rows.length >= maxRows} onClick={() => change(columns, [...rows, { label: '', values: columns.map(() => '') }])}>添加对比参数（{rows.length}/{maxRows}）</Button>
  </Space>;
}
