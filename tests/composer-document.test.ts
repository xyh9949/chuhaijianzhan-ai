import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComposerDocument } from '../src/lib/composer-document';
import { richTextErrors, richTextPlainText, type RichNode } from '../src/lib/presentation-content';

const linked = (attrs: Record<string, unknown>): RichNode => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'left' }, content: [{ type: 'text', text: 'Factory information', marks: [{ type: 'bold' }, { type: 'link', attrs }] }] }] });

test('SDK新增空title默认值不阻断合法链接，原节点与其它格式不变', () => {
  const input = linked({ href: '/about', target: null, rel: null, class: null, title: null }), original = structuredClone(input);
  assert.ok(richTextErrors(input).includes('富文本链接不安全'));
  const normalized = normalizeComposerDocument(input);
  assert.deepEqual(richTextErrors(normalized), []); assert.equal(richTextPlainText(normalized), 'Factory information');
  assert.deepEqual(input, original); assert.deepEqual(normalized.content?.[0].content?.[0].marks?.[1].attrs, { href: '/about', target: null, rel: null, class: null });
});

test('未设置空默认值的旧文档保持同一结构，含图片的相邻节点不受影响', () => {
  const input = linked({ href: 'https://example.com', target: '_blank', rel: 'noopener', class: null });
  input.content?.push({ type: 'image', attrs: { src: '/images/sofa.jpg', alt: 'Sample image', caption: 'Approved caption', width: 100, align: 'center' } });
  assert.deepEqual(normalizeComposerDocument(input), input);
});

test('非空title、其它未允许属性和危险href继续被原安全校验拒绝', () => {
  for (const attrs of [{ href: '/about', title: 'unsupported value' }, { href: '/about', title: null, onclick: null }, { href: 'javascript:alert(1)', title: null }]) {
    assert.ok(richTextErrors(normalizeComposerDocument(linked(attrs))).includes('富文本链接不安全'));
  }
});
