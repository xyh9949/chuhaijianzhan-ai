'use client';

import { Tree, Typography } from 'antd';
import type { DataNode } from 'antd/es/tree';
import type { AiRangeChoice } from '@/lib/ai-design-selection-client';

/** 使用Ant严格勾选，不自动把属性组合提升为父范围；每次选择后必须重新真实预览。 */
export default function AiDesignRangeTree({ units, selectedIds, onToggle, disabled, selectableIds }: { units: AiRangeChoice[]; selectedIds: string[]; onToggle: (id: string, checked: boolean) => void; disabled?: boolean; selectableIds?: string[] }) {
  const known = new Set(units.map(unit => unit.id)), selectable = selectableIds ? new Set(selectableIds) : known;
  const children = (parent?: string): DataNode[] => units.filter(unit => parent ? unit.parentId === parent : !unit.parentId || !known.has(unit.parentId)).map(unit => ({ key: unit.id, title: <div style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', paddingBlock: 3 }}><Typography.Text>{unit.label}</Typography.Text>{selectable.has(unit.id) && <Typography.Paragraph type="secondary" style={{ margin: '2px 0 0', fontSize: 12 }}>{unit.description}{unit.unavailableReason && <><br />{unit.unavailableReason}</>}</Typography.Paragraph>}</div>, checkable: selectable.has(unit.id), children: children(unit.id) }));
  return <Tree aria-label="精细设计范围" checkable checkStrictly selectable={false} blockNode virtual={false} defaultExpandAll disabled={disabled} checkedKeys={selectedIds.filter(id => selectable.has(id))} treeData={children()} onCheck={(_keys, info) => onToggle(String(info.node.key), info.checked)} />;
}
