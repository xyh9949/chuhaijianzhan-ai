import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { normalizeAiPreviewFeedback, type AiPreviewFeedback } from '../src/lib/ai-preview-inspection';
import { createSandboxDocument } from '../src/lib/site-code-render';

const report: AiPreviewFeedback = { viewport: 'mobile', width: 390, horizontalOverflow: true, brokenImages: 1, pendingImages: 0, smallText: 0, smallTargets: 2, headingCount: 1, inspectedElements: 17, truncated: false, issues: [{ code: 'horizontal-overflow', count: 1, nodeId: 'hero' }] };

test('真实预览测量只接受三个设备的有界几何数据，不能夹带正文、URL或指令', () => {
  assert.deepEqual(normalizeAiPreviewFeedback([report]), [report]);
  for (const input of [[{ ...report, secret: 'not accepted' }], [{ ...report, width: 0 }], [{ ...report, brokenImages: -1 }], [{ ...report, inspectedElements: 1501 }], [{ ...report, issues: [{ code: 'run-code', count: 1 }] }], [{ ...report, issues: [{ code: 'small-text', count: 1, url: '/api/secret' }] }], [{ ...report, issues: [{ code: 'small-text', count: 1, nodeId: '<script>' }] }], [report, report]]) assert.throws(() => normalizeAiPreviewFeedback(input));
});

test('只有显式AI编辑预览装载诊断，不改变普通预览；诊断保持单个受控脚本', () => {
  const input = { markup: '<h1>Preview</h1>', styles: [], css: [], scripts: [], baseUrl: 'https://example.test/preview/~edit/test/after', language: 'en' };
  const ordinary = createSandboxDocument(input), inspected = createSandboxDocument({ ...input, inspect: true });
  assert.doesNotMatch(ordinary, /layout-inspection|const inspectLayout/);
  assert.match(inspected, /layout-inspection/);
  assert.match(inspected, /event.source === parent && event.origin === new URL\(payload.baseUrl\).origin/);
  assert.equal(inspected.match(/<script>/g)?.length, 1);
  new Script(inspected.match(/<script>([\s\S]*)<\/script>/)![1]);
});
