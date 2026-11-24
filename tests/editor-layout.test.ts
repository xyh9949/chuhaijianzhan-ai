import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEditorNode, createLayoutPreset, editorNodes, moveTargets } from '../src/lib/editor-layout';
import type { Data } from '@puckeditor/core';

test('nested layout insertion is immutable and excludes cyclic move targets', () => {
  let count = 0;
  const layout = createLayoutPreset('sidebar', () => `layout-${++count}`);
  const data: Data = { root: { props: {} }, content: [layout] };
  const nodes = editorNodes(data);
  assert.equal(nodes.length, 3);
  assert.equal(moveTargets(data, layout.props.id).length, 0);
  assert.equal(moveTargets(data, nodes[1].id).length, 2);
  assert.equal(nodes[1].zone, `${layout.props.id}:content`);
  const added = appendEditorNode(data, { type: 'Text', props: { id: 'new-text', text: 'Hello' } }, nodes[1].id);
  assert.equal(editorNodes(data).length, 3);
  assert.equal(editorNodes(added).length, 4);
  assert.deepEqual(editorNodes(added).find((node) => node.id === 'new-text')?.ancestors, [layout.props.id, nodes[1].id]);
  assert.equal(appendEditorNode(data, layout, 'missing'), data);
});

test('layout presets retain independent editable columns and mobile stacking', () => {
  for (const kind of ['two', 'three', 'sidebar'] as const) {
    const preset = createLayoutPreset(kind);
    assert.equal(preset.props.design.mobile.columns, 1);
    assert.equal(preset.props.content.length, kind === 'three' ? 3 : 2);
    const ids = editorNodes({ root: { props: {} }, content: [preset] }).map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});
