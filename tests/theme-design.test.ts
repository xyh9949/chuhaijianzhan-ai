import protocol from '../src/lib/protocol.json';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { SiteTheme } from '../src/lib/types';
import { themeDesignErrors, resolveThemeDesign, themeNodeCss, styleUsage } from '../src/lib/theme-design';
import { compileDesignCss, resolveDesign, validateDesign } from '../src/lib/responsive-style';
import { cloneEditorNode, editorNodes } from '../src/lib/editor-layout';
import { getDatabase } from '../src/server/database';
import { getDraftRecord, getStudioEnvelope, patchStudio, readRelease } from '../src/server/studio';
import { activateRelease, previewPublication, publishSite, restoreDraft } from '../src/server/publication';

const theme: SiteTheme = { primary: '#245a46', background: '#ffffff', text: '#222222', radius: 4, font: 'system', tokens: [{ id: 'brand', name: '品牌色', value: '#245a46' }, { id: 'space', name: '间距', value: 24 }], presets: [{ id: 'button', name: '品牌按钮', design: { desktop: { color: '#ffffff', borderRadius: 12 }, mobile: { borderRadius: 8 } }, tokenBindings: { desktop: { backgroundColor: 'brand', paddingLeft: 'space' } }, stateStyles: { hover: { desktop: { opacity: 0.8 } }, focus: { desktop: { borderColor: '#ffffff' } } } }] };
const content = (extra = {}) => ({ root: { props: { title: '品牌实验' } }, content: [{ type: 'ActionButton', props: { id: 'cta', text: 'Contact', href: '/contact', stylePresetId: 'button', ...extra } }] });

test('令牌/复用样式按来源优先级解析，元素桌面明确值高于样式库手机值', () => {
  const props = { stylePresetId: 'button', design: { desktop: { borderRadius: 20 } } };
  assert.equal(resolveDesign(resolveThemeDesign(theme, props), 'mobile').borderRadius, 20);
  assert.equal(resolveDesign(resolveThemeDesign(theme, props), 'mobile').backgroundColor, '#245a46');
  const changed = { ...theme, tokens: [{ id: 'brand', name: '品牌色', value: '#001144' }, ...theme.tokens!.slice(1)] };
  assert.equal(resolveThemeDesign(changed, props).desktop?.backgroundColor, '#001144');
  assert.equal(resolveThemeDesign(changed, { ...props, design: { desktop: { backgroundColor: '#ff0000' } } }).mobile?.backgroundColor, '#ff0000');
  assert.equal(resolveThemeDesign(theme, {}).desktop?.borderRadius, undefined);
});
test('交互状态三端编译、键盘focus-within及旧字面量/安全长度兼容', () => {
  const css = themeNodeCss(theme, 'cta', { stylePresetId: 'button' }, 'ActionButton');
  assert.match(css, /:hover>\.editor-site-action/); assert.match(css, /:focus-within>/); assert.match(css, /max-width:700px/);
  const legacy = { desktop: { color: '#ff0000' }, mobile: { fontSize: 14 } };
  // 没有资源引用的旧数据编译结果可包含等价的继承声明，但不引入主题令牌值。
  assert.ok(themeNodeCss(theme, 'old', { design: legacy }, 'Text').includes('color:#ff0000!important'));
  assert.ok(!themeNodeCss(theme, 'old', { design: legacy }, 'Text').includes('#245a46'));
  assert.deepEqual(validateDesign({ desktop: { maxWidth: '72rem', width: '100%' } }), []);
  assert.ok(validateDesign({ desktop: { maxWidth: 'calc(100% - 2px)', width: '251rem' } }).length);
  assert.match(compileDesignCss('width', { desktop: { maxWidth: '72rem' } }), /max-width:72rem/);
});
test('删除引用、令牌类型、非法状态、重复ID及畸形资源均给出校验错误', () => {
  const source = { theme, pages: [{ id: 'home', title: '首页' }], editorData: { home: content() } };
  assert.deepEqual(themeDesignErrors(source), []);
  assert.ok(styleUsage(source, 'button').includes('首页'));
  assert.ok(styleUsage(source, 'brand').some(v => v.includes('品牌按钮')));
  assert.ok(themeDesignErrors({ ...source, theme: { ...theme, presets: [] } }).length);
  assert.ok(themeDesignErrors({ ...source, theme: { ...theme, tokens: [{ id: 'brand', name: '错误颜色', value: 24 }] } }).length);
  assert.ok(themeDesignErrors({ theme: { ...theme, tokens: [null] as never } }).length);
  assert.ok(themeDesignErrors({ theme: { ...theme, presets: [...theme.presets!, theme.presets![0]] } }).length);
  assert.ok(themeDesignErrors({ ...source, editorData: { home: content({ stateStyles: { hover: { desktop: { width: '100%' } } } }) } }).length);
  assert.ok(themeDesignErrors({ ...source, editorData: { home: content({ locked: 'yes' }) } }).length);
});
test('复制嵌套节点重建节点与锚点、重定向内部锚点链接并保留稳定资源目标', () => {
  const node = { type: 'Container', props: { id: 'container', nodeLabel: 'Hero', anchor: 'hero', content: [{ type: 'ActionButton', props: { id: 'a', href: '#hero', stylePresetId: 'button', linkTarget: { kind: 'page', id: 'home' } } }] } };
  const copy = cloneEditorNode(node, 'paste-test');
  assert.notEqual(copy.props.id, 'container'); assert.equal(copy.props.anchor, 'paste-test-1');
  assert.equal(copy.props.content[0].props.href, '#paste-test-1'); assert.equal(copy.props.content[0].props.stylePresetId, 'button');
  assert.deepEqual(copy.props.content[0].props.linkTarget, { kind: 'page', id: 'home' });
  assert.equal(node.props.content[0].props.href, '#hero');
  assert.equal(editorNodes({ root: { props: {} }, content: [copy] })[0].label, 'Hero');
});
test('真实保存、部分主题发布、遗漏依赖拒绝、历史切换与恢复均保持资源边界', () => {
  const previous = process.env.FORM_STUDIO_DATA_DIR, directory = mkdtempSync(join(tmpdir(), 'form-studio-theme-'));
  process.env.FORM_STUDIO_DATA_DIR = directory;
  try {
    const actor = { id: 'theme-admin', name: '主题验收' };
    const save = (patch: object) => patchStudio({ expectedRevision: getDraftRecord().revision, patch });
    const selection = (extra = {}) => ({ expectedRevision: getDraftRecord().revision, baseReleaseId: getStudioEnvelope().activeReleaseId, pageIds: ['home'], productIds: [], includeTheme: true, includeSettings: true, ...extra });
    save({ theme, editorData: { ...getDraftRecord().content.editorData, home: content() } });
    const first = publishSite(selection(), actor); const firstSnapshot = readRelease(first.releaseId);
    assert.equal(firstSnapshot.schemaVersion, protocol.snapshot);
    const changedTheme = structuredClone(theme); changedTheme.tokens![0].value = '#001144';
    save({ theme: changedTheme });
    const themeOnly = publishSite(selection({ pageIds: [] }), actor);
    assert.equal(readRelease(themeOnly.releaseId).theme.tokens![0].value, '#001144');
    assert.deepEqual(readRelease(themeOnly.releaseId).editorData.home, firstSnapshot.editorData.home);
    activateRelease(first.releaseId, { expectedActiveReleaseId: getStudioEnvelope().activeReleaseId }, actor); assert.equal(getStudioEnvelope().activeReleaseId, first.releaseId);
    restoreDraft(first.releaseId, { expectedRevision: getDraftRecord().revision, pageIds: [], productIds: [], includeTheme: true }, actor);
    assert.equal(getDraftRecord().content.theme.tokens![0].value, '#245a46');
    const newTheme = { ...theme, presets: [...theme.presets!, { id: 'new-style', name: '新样式', design: {} }] };
    save({ theme: newTheme, editorData: { ...getDraftRecord().content.editorData, home: content({ stylePresetId: 'new-style' }) } });
    const missing = previewPublication(selection({ includeTheme: false }));
    assert.ok(missing.errors.some(e => e.includes('复用样式不存在')));
    const revision = getDraftRecord().revision;
    assert.throws(() => save({ theme: { ...newTheme, presets: [] } }), /复用样式不存在/); assert.equal(getDraftRecord().revision, revision);
    // 真正的旧协议快照没有新增字段，当前渲染器可继续激活。
    const legacy = structuredClone(firstSnapshot); legacy.schemaVersion = 7; legacy.releaseId = 'legacy-theme-v7'; delete legacy.theme.tokens; delete legacy.theme.presets; legacy.editorData.home = { root: { props: {} }, content: [] };
    getDatabase().prepare('INSERT INTO cms_release (id, title, manifest_json, manifest_hash, schema_version, renderer_version, created_by, author_name, created_at, selection_json) VALUES (?, ?, ?, ?, 7, 7, ?, ?, ?, ?)').run('legacy-theme-v7', '旧主题', JSON.stringify(legacy), 'legacy-fixture', actor.id, actor.name, new Date().toISOString(), JSON.stringify(selection()));
    activateRelease('legacy-theme-v7', { expectedActiveReleaseId: getStudioEnvelope().activeReleaseId }, actor);
  } finally {
    getDatabase().close(); if (previous === undefined) delete process.env.FORM_STUDIO_DATA_DIR; else process.env.FORM_STUDIO_DATA_DIR = previous;
    if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}form-studio-theme-`)) rmSync(directory, { recursive: true, force: true });
  }
});
