import protocol from '../lib/protocol.json';
import { initialState } from '../lib/demo';
import { getPageData } from '../lib/page-data';
import { getDatabase } from './database';
import type { DraftContent } from './types';

export function createInitialDraft(): DraftContent {
  const demo = structuredClone(initialState);
  // 示例内容只是待编辑草稿，绝不初始化假询盘、假操作人或已发布版本。
  return {
    pages: demo.pages.map((page) => ({ ...page, status: 'draft', updated: new Date().toISOString() })),
    products: demo.products.map((product) => ({ ...product, status: 'draft' })),
    media: demo.media, theme: demo.theme, settings: demo.settings,
    editorData: Object.fromEntries(demo.pages.map((page) => [page.id, getPageData(page)])),
  };
}

/** 新客户安装仅建立一张空白草稿，不继承演示品牌、联系人或已发布内容。 */
export function createEmptyDraft(): DraftContent {
  return { pages: [{id:'home',title:'Home',slug:'/',status:'draft',type:'普通页面',updated:new Date().toISOString()}], products:[],media:[],
    theme:{primary:'#2563eb',background:'#ffffff',text:'#172033',radius:4,font:'system'},
    settings:{name:'My website',domain:'',description:'',email:'',language:'en',timezone:'UTC'},
    editorData:{home:{root:{props:{brand:'',showChrome:'no'}},content:[]}} };
}

export function ensureDraft() {
  const db = getDatabase();
  if (!db.prepare('SELECT id FROM cms_draft WHERE id = 1').get()) {
    db.prepare('INSERT OR IGNORE INTO cms_draft (id, revision, schema_version, content_json, updated_at) VALUES (1, 0, ?, ?, ?)')
      .run(protocol.snapshot, JSON.stringify(createInitialDraft()), new Date().toISOString());
  }
}
