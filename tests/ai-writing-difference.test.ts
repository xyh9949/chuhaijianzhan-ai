import assert from 'node:assert/strict';
import test from 'node:test';
import { writingTextDifference } from '../src/lib/ai-writing-difference';

const reconstruct = (result: ReturnType<typeof writingTextDifference>, side: 'before' | 'after') => result.parts.filter(part => part.kind !== (side === 'before' ? 'added' : 'removed')).map(part => part.text).join('');

test('文字对照能完整还原双方，中文、emoji与分散修改不损坏', () => {
  const before = '原款🪑用于客厅。\nSuitable for 20 pcs. Keep the original finish.';
  const after = '新款🪑用于酒店。\nSuitable for 30 pcs. Keep the original finish.';
  const result = writingTextDifference(before, after);
  assert.equal(reconstruct(result, 'before'), before);
  assert.equal(reconstruct(result, 'after'), after);
  assert.equal(result.changed, true);
  assert.equal(result.simplified, false);
  assert.ok(result.parts.some(part => part.kind === 'same' && part.text.includes('Suitable for')));
});

test('新增、删除与相同内容各自准确，不将空值虚构为文字', () => {
  for (const [before, after] of [['', '新增内容'], ['删除内容', ''], ['', ''], ['原样  \n', '原样  \n']]) {
    const result = writingTextDifference(before, after);
    assert.equal(reconstruct(result, 'before'), before);
    assert.equal(reconstruct(result, 'after'), after);
    assert.equal(result.changed, before !== after);
  }
});

test('长文大范围重写降级比较且两边全文完整，保留共同头尾', () => {
  const before = `共同开头\n${'older material '.repeat(1200)}\n共同结尾`;
  const after = `共同开头\n${'newer specification '.repeat(1200)}\n共同结尾`;
  const result = writingTextDifference(before, after);
  assert.equal(result.simplified, true);
  assert.equal(reconstruct(result, 'before'), before);
  assert.equal(reconstruct(result, 'after'), after);
  assert.ok(result.parts[0].text.startsWith('共同开头'));
  assert.ok(result.parts.at(-1)?.text.endsWith('共同结尾'));
});
