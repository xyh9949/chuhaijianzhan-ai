import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { AI_PREVIEW_INSPECTION_SCRIPT } from '../src/lib/ai-preview-inspection';

test('视觉定位只响应本人预览父窗口并精确命中真实ID；重复定位最终恢复原描边', () => {
  const parent = {}, events: Record<string, (event: unknown) => void> = {}, timers = new Map<number, () => void>(), messages: unknown[] = [];
  let timerId = 0, scrolls = 0, reads = 0;
  const node = { style: { outline: '1px solid red', outlineOffset: '1px' }, getAttribute: () => 'real-node', scrollIntoView: () => { scrolls++; } };
  const context = {
    parent, payload: { baseUrl: 'https://site.example/preview/~edit/candidate/after' },
    root: { querySelectorAll: (selector: string) => { assert.equal(selector, '[data-site-node-id]'); reads++; return [node]; }, addEventListener: () => {} },
    window: { addEventListener: (name: string, callback: (event: unknown) => void) => { events[name] = callback; } }, document: {},
    URL, send: (message: unknown) => messages.push(message), setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
  };
  new Script(AI_PREVIEW_INSPECTION_SCRIPT).runInNewContext(context);
  const locate = (override: object = {}) => events.message({ source: parent, origin: 'https://site.example', data: { source: 'form-studio-inspection', type: 'locate', nodeId: 'real-node' }, ...override });
  locate({ source: {} }); locate({ origin: 'https://other.example' });
  locate({ data: { source: 'form-studio-inspection', type: 'locate', nodeId: '<script>' } });
  assert.equal(reads, 0); assert.equal(messages.length, 0);
  locate(); locate();
  assert.equal(scrolls, 2); assert.equal(node.style.outline, '2px solid #d97706');
  assert.equal(timers.size, 2, '仅保留排版检查和最后一次定位计时器');
  timers.get(timerId)!();
  assert.equal(node.style.outline, '1px solid red'); assert.equal(node.style.outlineOffset, '1px');
  locate({ data: { source: 'form-studio-inspection', type: 'locate', nodeId: 'unlisted-node' } });
  assert.equal(scrolls, 2); assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'node-location', found: true }, { type: 'node-location', found: true }, { type: 'node-location', found: false }]);
});
