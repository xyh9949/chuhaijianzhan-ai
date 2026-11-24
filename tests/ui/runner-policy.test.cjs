const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { parseArguments, resultStatus } = require('../../scripts/test-ui.cjs');
const successful = { code: 0, removed: true, closed: true, interrupted: false, buildUnchanged: true, listOnly: false, stats: { expected: 19, unexpected: 0, skipped: 0, flaky: 0 } };

test('UI调试参数固定配置，grep值不被解释成另一项CLI选项', () => {
  assert.deepEqual(parseArguments([]), []);
  assert.deepEqual(parseArguments(['--grep', '-cother.config.ts', '--headed']), ['--grep=-cother.config.ts', '--headed']);
  assert.deepEqual(parseArguments(['--list']), ['--list']);
});
test('拒绝连写短配置、长配置及会隐藏零执行的CLI参数', () => {
  for (const args of [['-cother.config.ts'], ['--config=other.config.ts'], ['--output=elsewhere'], ['--pass-with-no-tests'], ['--retries=3'], ['--trace=on'], ['--grep']]) assert.throws(() => parseArguments(args));
});
test('真正执行19组通过才得到passed', () => { assert.equal(resultStatus(successful), 'passed'); });
test('退出0但没执行、缺失统计、跳过或波动必须failed', () => {
  for (const stats of [undefined, { ...successful.stats, expected: 0 }, { ...successful.stats, skipped: 1 }, { ...successful.stats, flaky: 1 }, { ...successful.stats, unexpected: 1 }]) assert.equal(resultStatus({ ...successful, stats }), 'failed');
});
test('list只能得到listed，不能冒充执行', () => { assert.equal(resultStatus({ ...successful, listOnly: true, stats: { expected: 0, skipped: 19 } }), 'listed'); });
test('清理不完整、构建变化或被中断不能得到passed', () => {
  for (const value of [{ removed: false }, { closed: false }, { interrupted: true }, { buildUnchanged: false }, { code: 1 }]) assert.equal(resultStatus({ ...successful, ...value }), 'failed');
});

test('本机模型例外拒绝外网、正式端口、凭据和路径，仍拦截其它外发', () => {
  const guard = resolve(__dirname, 'deny-external.cjs');
  for (const origin of ['https://models.example.com', 'http://127.0.0.1:3200', 'http://user:pass@127.0.0.1:45671', 'http://127.0.0.1:45671/wrong']) {
    const result = spawnSync(process.execPath, ['--require', guard, '-e', ''], { env: { ...process.env, UI_TEST_ORIGIN: 'http://127.0.0.1:45670', UI_TEST_MODEL_ORIGIN: origin }, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /synthetic model origin is not isolated/);
  }
  const result = spawnSync(process.execPath, ['--require', guard, '-e', "try { fetch('https://external.example.invalid'); process.exitCode=1; } catch(e) { if (!e.message.includes('outbound request is disabled')) process.exitCode=2; }"], { env: { ...process.env, UI_TEST_ORIGIN: 'http://127.0.0.1:45670', UI_TEST_MODEL_ORIGIN: 'http://127.0.0.1:45671' }, encoding: 'utf8' });
  assert.equal(result.status, 0);
});
