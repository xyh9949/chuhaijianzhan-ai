import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Data } from '@puckeditor/core';
import { matchesCanvasData } from '../src/lib/editor-canvas-history';

test('详情画布语义相同的对象键顺序不产生修改，区块和子项顺序仍参与比较', () => {
  const first = { type: 'Heading', props: { id: 'heading', text: 'Title', design: { desktop: { align: 'left', fontSize: 32 } } } };
  const second = { type: 'LogoCloud', props: { id: 'logos', items: [{ text: 'First' }, { text: 'Second' }] } };
  const stored: Data = { root: { props: { title: 'Template' } }, zones: {}, content: [first, second] };
  const reopened: Data = { content: [{ ...first, props: { text: 'Title', design: { desktop: { fontSize: 32, align: 'left' } }, id: 'heading' } }, second], root: stored.root };

  assert.equal(matchesCanvasData(stored, reopened), true);
  assert.equal(matchesCanvasData(stored, { ...reopened, content: [second, first] }), false);
  assert.equal(matchesCanvasData(stored, { ...reopened, content: [first, { ...second, props: { ...second.props, items: [...second.props.items].reverse() } }] }), false);
});
