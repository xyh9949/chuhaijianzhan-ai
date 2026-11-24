import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSiteJourneyFacts, loadSiteJourney, saveSiteJourney, type SiteJourneySession } from '../src/lib/site-journey';
import type { PageItem, StudioState } from '../src/lib/types';

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  writes = 0;
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; this.data.set(key, value); }
  removeItem(key: string) { this.writes++; this.data.delete(key); }
  clear() { this.data.clear(); }
}
const prefix = 'form-studio:site-journey:v1:';
const actor = 'journey-admin';
const safeDefault = { version: 1, active: false, step: 'materials' };
const example = (): SiteJourneySession => ({ version: 1, active: true, step: 'edit', pageId: 'page-projects', runId: 'aiv-12345678-abcd-1234-abcd-123456789abc' });
let previous: PropertyDescriptor | undefined, storage: MemoryStorage;
beforeEach(() => { previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'); storage = new MemoryStorage(); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage }); });
afterEach(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
const page = (id: string, slug: string, status: PageItem['status'] = 'draft'): PageItem => ({ id, slug, title: id, status, type: '普通页面', updated: '2026-11-11' });
const state = (): StudioState => ({ pages: [page('about', '/about'), page('home', '/'), page('detail', '/products/:slug')], products: [], media: [], inquiries: [], releases: [], theme: { primary: '#2563eb', background: '#fff', text: '#172033', radius: 4, font: 'system' }, settings: { name: 'Synthetic company', description: '', email: '', domain: '', language: 'en', timezone: 'UTC' }, editorData: {}, activePageId: 'about' });

test('同标签页仅保存安全步骤和ID，读取不写入且不共享可变对象', () => {
  const value = example(); saveSiteJourney(actor, value);
  const raw = storage.getItem(`${prefix}${actor}`)!; const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), ['actorId', 'session', 'version']);
  assert.deepEqual(saved.session, value);
  value.step = 'publish';
  const writes = storage.writes, first = loadSiteJourney(actor); first.step = 'seo';
  assert.equal(loadSiteJourney(actor).step, 'edit'); assert.equal(storage.writes, writes);
});

test('账号键与信封双重隔离，复制其他账号副本不能恢复其流程', () => {
  saveSiteJourney(actor, example());
  assert.deepEqual(loadSiteJourney('other-admin'), safeDefault);
  storage.setItem(`${prefix}other-admin`, storage.getItem(`${prefix}${actor}`)!);
  assert.deepEqual(loadSiteJourney('other-admin'), safeDefault);
  assert.equal(loadSiteJourney(actor).pageId, 'page-projects');
});

test('恢复不接受未知步骤、版本、ID、数组或多余敏感字段', () => {
  const bad = [null, [], { ...example(), step: 'complete' }, { ...example(), version: 2 }, { ...example(), active: 'true' }, { ...example(), pageId: '../admin' }, { ...example(), pageId: 'x'.repeat(101) }, { ...example(), runId: 'https://model.example.invalid' }, { ...example(), runId: 'sep-12345678-abcd-1234-abcd-123456789abc' }, { ...example(), apiKey: 'PRIVATE_CREDENTIAL_MUST_NOT_BE_SAVED' }, { ...example(), intent: { action: 'resume' } }];
  for (const value of bad) {
    storage.setItem(`${prefix}${actor}`, JSON.stringify({ version: 1, actorId: actor, session: value }));
    assert.deepEqual(loadSiteJourney(actor), safeDefault);
  }
});

test('损坏、大对象及带额外信封数据的副本安全回默认且读取不清理资料', () => {
  for (const raw of ['{', 'null', 'x'.repeat(2049), JSON.stringify({ version: 2, actorId: actor, session: example() }), JSON.stringify({ version: 1, actorId: actor, session: example(), brief: 'PRIVATE_COMPANY_BRIEF' })]) {
    storage.setItem(`${prefix}${actor}`, raw); const writes = storage.writes;
    assert.deepEqual(loadSiteJourney(actor), safeDefault); assert.equal(storage.getItem(`${prefix}${actor}`), raw); assert.equal(storage.writes, writes);
  }
});

test('非法写入不持久化正文、密钥或模型产物；清除可选ID保持有效步骤', () => {
  saveSiteJourney(actor, example());
  saveSiteJourney(actor, { ...example(), preview: { html: 'PRIVATE_MODEL_RESULT' } } as SiteJourneySession);
  assert.equal(storage.getItem(`${prefix}${actor}`), null); assert.deepEqual(loadSiteJourney(actor), safeDefault);
  saveSiteJourney(actor, { ...example(), pageId: undefined, runId: undefined });
  assert.deepEqual(loadSiteJourney(actor), { version: 1, active: true, step: 'edit' });
  assert.doesNotMatch([...storage.data.values()].join(''), /PRIVATE_/);
});

test('浏览器禁止存储、缺少存储或容量不足时不阻断当前流程', () => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('denied'); } });
  assert.doesNotThrow(() => saveSiteJourney(actor, example())); assert.deepEqual(loadSiteJourney(actor), safeDefault);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: undefined });
  assert.doesNotThrow(() => saveSiteJourney(actor, example())); assert.deepEqual(loadSiteJourney(actor), safeDefault);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem() { return null; }, setItem() { throw new Error('quota'); } } });
  assert.doesNotThrow(() => saveSiteJourney(actor, example())); assert.deepEqual(loadSiteJourney(actor), safeDefault);
});

test('非法账号不会读取或覆盖其他人的存储，原记录保留', () => {
  saveSiteJourney(actor, example()); const before = [...storage.data];
  for (const id of ['', 'other:journey-admin', '../journey-admin', 'x'.repeat(201), undefined, null, 42, {}]) { saveSiteJourney(id as string, example()); assert.deepEqual(loadSiteJourney(id as string), safeDefault); }
  assert.deepEqual([...storage.data], before);
});

test('合法当前普通页优先；动态模板或已删除活动页回退根页再首个普通页', () => {
  const value = state(); assert.equal(deriveSiteJourneyFacts(value).preferredPageId, 'about');
  value.activePageId = 'detail'; assert.equal(deriveSiteJourneyFacts(value).preferredPageId, 'home');
  value.activePageId = 'deleted'; assert.equal(deriveSiteJourneyFacts(value).preferredPageId, 'home');
  value.pages = value.pages.filter(item => item.id !== 'home'); assert.equal(deriveSiteJourneyFacts(value).preferredPageId, 'about');
  value.pages = value.pages.filter(item => item.id === 'detail'); assert.equal(deriveSiteJourneyFacts(value).preferredPageId, null); assert.deepEqual(deriveSiteJourneyFacts(value).editablePages, []);
});

test('事实统计只读真实记录，全部草稿含模板，图片不混PDF或视频', () => {
  const value = state(); value.pages[0].status = 'published';
  value.products = [{ id: 'chair', name: 'Supplied chair', sku: 'C01', category: 'Chairs', status: 'draft', image: '', description: '', material: '' }];
  value.media = [{ id: 'picture', name: 'Picture', url: '/images/chair.jpg', kind: 'image', folder: '', size: '', alt: '' }, { id: 'catalog', name: 'Catalog', url: '/api/media/catalog', kind: 'document', folder: '', size: '', alt: '' }, { id: 'film', name: 'Film', url: '/film.mp4', kind: 'video', folder: '', size: '', alt: '' }];
  const before = structuredClone(value), result = deriveSiteJourneyFacts(value);
  assert.equal(result.products, 1); assert.equal(result.images, 1); assert.equal(result.draftPageCount, 2); assert.equal(result.editablePages.length, 2); assert.equal(result.currentReleaseId, null);
  assert.deepEqual(value, before); assert.equal(Object.hasOwn(result, 'completed'), false); assert.equal(Object.hasOwn(result, 'aiGenerated'), false);
});

test('历史版本或页面published不冒充当前公开版本；当前版本不消除新草稿', () => {
  const value = state(); value.pages[0].status = 'published';
  value.releases = [{ id: 'release-old', title: 'Old', date: '', author: '', status: 'history', changes: [] }];
  assert.equal(deriveSiteJourneyFacts(value).currentReleaseId, null);
  value.releases.push({ id: 'release-current', title: 'Current', date: '', author: '', status: 'current', changes: [], snapshot: { pages: [{ id: 'old-public-page' }] } });
  const facts = deriveSiteJourneyFacts(value); assert.equal(facts.currentReleaseId, 'release-current'); assert.equal(facts.draftPageCount, 2); assert.equal(facts.editablePages.length, 2);
});
