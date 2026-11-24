import {LOCAL_EXTENSIONS,usedExtensionTypes} from '../extensions/registry';
import protocol from '../lib/protocol.json';
import { bundledImage } from '../lib/bundled-media';
import {siteLocales,localizationErrors} from '../lib/localization';
import { recordAudit } from './audit';
import type { ActorIdentity } from './types';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { SiteSnapshot, DraftContent } from './types';
import type { PackageImportOptions, SitePackagePreview } from '../lib/site-package';
import { SITE_PACKAGE_MAX_BYTES } from '../lib/site-package';
import { ApiError, readBodyBytes } from './http';
import { getDatabase, getDataDirectory } from './database';
import { getActiveReleaseId, getDraftRecord, getStudioEnvelope, writeDraft } from './studio';
import { getActiveSiteSnapshot } from './publication';
import { assertKnownPageComponents, collectReferences, object, pageTemplateErrors, revision, sharedDependencyErrors, text, validateDraft, validatePageData } from './validation';
import { validateContentState } from './model-validation';
import { contentBindingErrors } from '../lib/content-binding';
import { contentRouteErrors } from '../lib/content-routes';
import { contentQueryErrors } from '../lib/content-query';
import { siteLinkErrors } from '../lib/site-links';
import { navigationErrors } from '../lib/site-navigation';
import { taxonomyErrors } from '../lib/taxonomy';
import { redirectErrors } from '../lib/site-redirects';
import { seoErrors } from '../lib/site-seo';
import { themeDesignErrors } from '../lib/theme-design';
import { presentationMediaErrors } from '../lib/presentation-content';
import { formContentErrors } from '../lib/form-content';
import { readMediaFile } from './media';
import { validatePdf } from './pdf-validation';
import { getAuthEnvironment } from './env';
import { remapPortableSite } from './portable-site';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const extensions: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm' };
// 渲染器源码的许可与导出站点的内容授权分别记录，避免把客户素材一起授予 MIT。
const dependencies = [{ name: 'form-studio-renderer', version: String(protocol.renderer), license: 'MIT' }, { name: '@puckeditor/core', version: '0.24.0', license: 'MIT' }, { name: 'react', version: '19.3.1', license: 'MIT' }, { name: 'antd', version: '6.7.0', license: 'MIT' }];
export interface SitePackage { format: 'form-studio-site'; version: 1; manifest: { name: string; description: string; createdAt: string; rendererVersion: number; license: string; dependencies: typeof dependencies; snapshotSha256: string }; snapshot: SiteSnapshot; files: { mediaId: string; path: string; mime: string; bytes: number; sha256: string; content: string }[]; }
const snapshotKeys = ['schemaVersion','urlState','pages','products','editorData','media','theme','settings','sharedBlocks','siteLayout','customCode','contentModels','contentEntries','taxonomies','redirects','forms','pageTemplates'];
function only(value: Record<string, unknown>, keys: string[], label: string) { if (Object.keys(value).some(k => !keys.includes(k))) throw new ApiError(422, `${label}包含不允许的属性`); }
function asDraft(snapshot: SiteSnapshot): DraftContent {
  const { schemaVersion: _version, urlState: _state, ...data } = snapshot;
  return { ...data, settings: { ...snapshot.settings, domain: '', timezone: 'UTC' } };
}
/** 分发内容走与发布相同的声明式依赖规则；不借用接收实例的未发布对象补齐源包。 */
function validateSource(snapshot: SiteSnapshot) {
  validateDraft(asDraft(snapshot));
  for (const p of snapshot.pages) { assertKnownPageComponents(snapshot.editorData[p.id]); validatePageData(snapshot.editorData[p.id], p.title, true); }
  for (const b of snapshot.sharedBlocks || []) { assertKnownPageComponents(b.data); validatePageData(b.data, b.name, true); }
  for (const t of snapshot.pageTemplates || []) assertKnownPageComponents(t.data);
  validateContentState(snapshot, true);
  const errors = [...localizationErrors(snapshot,true),...sharedDependencyErrors(snapshot), ...contentBindingErrors(snapshot, true), ...contentRouteErrors(snapshot), ...contentQueryErrors(snapshot), ...siteLinkErrors(snapshot), ...navigationErrors(snapshot, true), ...taxonomyErrors(snapshot), ...redirectErrors(snapshot), ...seoErrors(snapshot), ...themeDesignErrors(snapshot), ...presentationMediaErrors(snapshot), ...formContentErrors(snapshot, true), ...pageTemplateErrors(snapshot, true)];
  if (errors.length) throw new ApiError(422, errors.slice(0, 20).join('；'));
  const urls = new Set(snapshot.media.map(m => m.url)); for (const url of collectReferences(snapshot).urls) if (!urls.has(url)) throw new ApiError(422, `分发包缺失素材引用：${url}`);
  if (!snapshot.pages.some(p => p.slug === '/')) throw new ApiError(422, '整站分发包必须包含首页');
}
/** 只导出活动快照及其公开媒体；私有草稿、运行表、发布指针和认证资料均不进入包。 */
export function exportSitePackage(value: unknown): SitePackage {
  const active = getActiveSiteSnapshot(); if (!active) throw new ApiError(422, '请先发布需要分发的站点内容');
  return buildSitePackage(active, value);
}
/** 内置演示也走同一格式与校验，导入权限/预检/确认没有旁路。 */
export function buildSitePackage(active: SiteSnapshot, value: unknown): SitePackage {
  const input = object(value, '导出请求'); only(input, ['name','description','license'], '导出请求');
  const snapshot = Object.fromEntries(Object.entries(structuredClone(active)).filter(([k]) => snapshotKeys.includes(k))) as unknown as SiteSnapshot;
  // 公开设置再次白名单化，避免未来运行配置扩展被分发功能意外带出。
  delete snapshot.urlState;
  snapshot.settings = { name: active.settings.name, description: active.settings.description, email: active.settings.email, language: active.settings.language,...(active.settings.locales?{locales:active.settings.locales}:{}), ...(active.settings.discovery?{discovery:structuredClone(active.settings.discovery)}:{}), ...(active.settings.publicUrl ? { publicUrl: active.settings.publicUrl } : {}) };
  validateSource(snapshot);
  if (snapshot.media.length > 2000) throw new ApiError(413, '单个分发包最多2000个媒体文件');
  let total = 0;
  const files = snapshot.media.map(m => {
    let bytes: Buffer, mime: string;
    const bundled = bundledImage(m.url);
    if (bundled) { bytes = readFileSync(join(process.cwd(), 'public', bundled.url)); mime = bundled.mime; }
    else { const source = readMediaFile(m.id); bytes = source.bytes; mime = source.mime; }
    total += bytes.length; if (total > 48 * 1024 * 1024) throw new ApiError(413, '分发媒体总量最多48 MB，请移出大视频后重新发布/分发');
    const sha256 = hash(bytes); return { mediaId: m.id, path: `assets/${sha256}.${extensions[mime]}`, mime, bytes: bytes.length, sha256, content: bytes.toString('base64') };
  });
  return { format: 'form-studio-site', version: 1, manifest: { name: text(input.name, '分发包名称', 120, true), description: text(input.description || '', '分发说明', 2000), license: text(input.license, '素材和设计授权记录', 4000, true), createdAt: new Date().toISOString(), rendererVersion: protocol.renderer, dependencies:[...dependencies,...LOCAL_EXTENSIONS.filter(e=>usedExtensionTypes(snapshot).has(e.type)).map(e=>({name:e.type,version:String(e.version),license:e.license}))], snapshotSha256: hash(JSON.stringify(snapshot)) }, snapshot, files };
}
export async function readPackageRequest(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, '请使用JSON分发包请求');
  const bytes = await readBodyBytes(request, SITE_PACKAGE_MAX_BYTES);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ApiError(400, '分发包不是有效UTF-8 JSON'); }
}
/** 原包由浏览器保留；拒绝未知/恶意数据时不创建任何文件或业务行。路径只用于完整性检查，从不作为解压目标。 */
export async function validateSitePackage(value: unknown) {
  const v = object(value, '整站分发包'); only(v, ['format','version','manifest','snapshot','files'], '分发包');
  if (v.format !== 'form-studio-site' || v.version !== 1) throw new ApiError(422, '不支持此分发包格式或版本');
  const manifest = object(v.manifest, '包清单'); only(manifest, ['name','description','license','createdAt','rendererVersion','dependencies','snapshotSha256'], '包清单');
  text(manifest.name, '分发包名称', 120, true); text(manifest.description, '分发说明', 2000); text(manifest.license, '授权记录', 4000, true); text(manifest.createdAt, '创建时间', 100, true);
  if (!Number.isInteger(manifest.rendererVersion) || Number(manifest.rendererVersion) < 1 || Number(manifest.rendererVersion) > protocol.renderer || !Array.isArray(manifest.dependencies) || manifest.dependencies.length > 40) throw new ApiError(422, '不兼容的渲染器或依赖清单');
  for (const d of manifest.dependencies) { const dep = object(d, '依赖'); only(dep, ['name','version','license'], '依赖'); for (const key of ['name','version','license']) text(dep[key], '依赖记录', 500, true); }
  const raw = object(v.snapshot, '网站快照'); only(raw, snapshotKeys, '网站快照'); const settings = object(raw.settings, '公开设置'); only(settings, ['name','description','email','language','publicUrl','locales','discovery'], '公开设置');
  if (!Number.isInteger(raw.schemaVersion) || Number(raw.schemaVersion) < 1 || Number(raw.schemaVersion) > protocol.snapshot) throw new ApiError(422, '不兼容的站点数据版本');
  const snapshot = raw as unknown as SiteSnapshot; validateSource(snapshot);
  if (hash(JSON.stringify(snapshot)) !== manifest.snapshotSha256) throw new ApiError(422, '网站数据哈希不匹配，原包未导入');
  if (!Array.isArray(v.files) || v.files.length !== snapshot.media.length || v.files.length > 2000) throw new ApiError(422, '媒体文件清单缺失或数量不匹配');
  const fileIds = new Set<string>(), files: { id: string; filename: string; mime: string; hash: string; bytes: Buffer }[] = []; let total = 0;
  for (const value of v.files) {
    const f = object(value, '媒体文件'); only(f, ['mediaId','path','mime','bytes','sha256','content'], '媒体文件');
    const mime = String(f.mime), ext = extensions[mime], sha = String(f.sha256), media = snapshot.media.find(m => m.id === f.mediaId);
    if (!media || fileIds.has(media.id) || !ext || !/^[a-f0-9]{64}$/.test(sha) || f.path !== `assets/${sha}.${ext}`) throw new ApiError(422, '媒体标识、类型、哈希或安全路径无效');
    fileIds.add(media.id);
    if (media.kind !== (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'document') || !Number.isSafeInteger(f.bytes) || Number(f.bytes) < 1 || Number(f.bytes) > (media.kind === 'video' ? 40 : media.kind === 'document' ? 10 : 8) * 1024 * 1024) throw new ApiError(422, '媒体类型或单文件大小无效');
    total += Number(f.bytes); if (total > 48 * 1024 * 1024) throw new ApiError(413, '分发媒体总量超过48 MB');
    if (typeof f.content !== 'string' || f.content.length !== 4 * Math.ceil(Number(f.bytes) / 3) || /[^A-Za-z0-9+/=]/.test(f.content)) throw new ApiError(422, '媒体Base64内容无效');
    const bytes = Buffer.from(f.content, 'base64'); if (bytes.length !== f.bytes || bytes.toString('base64') !== f.content || hash(bytes) !== sha) throw new ApiError(422, '媒体文件哈希或大小不匹配');
    if (media.kind === 'image') {
      try { const decoder = sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' }), info = await decoder.metadata(); if (info.format !== ({ webp: 'webp', jpg: 'jpeg', png: 'png' } as Record<string,string>)[ext] || (info.pages || 1) !== 1) throw new Error(); await decoder.webp().toBuffer(); if (media.width !== undefined && media.width !== info.width || media.height !== undefined && media.height !== info.height) throw new Error(); }
      catch { throw new ApiError(422, '包内图片无法解码或尺寸信息不符'); }
    } else if (media.kind === 'document') { const pages = await validatePdf(bytes); if (media.pages !== undefined && media.pages !== pages) throw new ApiError(422, 'PDF页数不符'); }
    else { const valid = ext === 'mp4' ? bytes.length >= 32 && bytes.toString('ascii',4,8) === 'ftyp' && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length && bytes.includes(Buffer.from('mdat')) && (bytes.includes(Buffer.from('moov')) || bytes.includes(Buffer.from('moof'))) : bytes.length >= 32 && bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) && bytes.subarray(0,4096).includes(Buffer.from('webm')); if (!valid) throw new ApiError(422, '包内视频签名无效'); }
    files.push({ id: media.id, filename: `${sha}.${ext}`, mime, hash: sha, bytes });
  }
  return { package: v as unknown as SitePackage, snapshot, files };
}
function optionsFor(value: unknown): PackageImportOptions {
  const o = object(value, '导入选项'); only(o, ['mode','prefix','skuPrefix','enableJs','mergeLocales'], '导入选项');
  if(o.mergeLocales!==undefined&&typeof o.mergeLocales!=='boolean')throw new ApiError(422,'请明确是否合并语言配置');
  if (!['fresh','merge'].includes(String(o.mode)) || typeof o.enableJs !== 'boolean' || typeof o.prefix !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(o.prefix) || typeof o.skuPrefix !== 'string' || o.skuPrefix.length > 30 || /[\u0000-\u001f\u007f]/.test(o.skuPrefix)) throw new ApiError(422, '导入模式、路径前缀或SKU前缀无效');
  return {...o,mergeLocales:o.mergeLocales===true} as unknown as PackageImportOptions;
}
function signature(digest: string, options: PackageImportOptions, rev: number, timestamp: number, namespace: string) { return createHmac('sha256', getAuthEnvironment().secret).update(JSON.stringify(['site-package',digest,options,rev,timestamp,namespace])).digest('base64url'); }
async function prepare(value: unknown, namespace: string) {
  const input = object(value, '分发包导入'); only(input, ['package','options','expectedRevision','confirmation'], '分发包导入'); const expected = revision(input.expectedRevision), options = optionsFor(input.options), draft = getDraftRecord();
  if (draft.revision !== expected) throw new ApiError(409, '工作区已变化，请重新预检；尚未导入');
  if (options.mode === 'fresh' && (draft.revision !== 0 || getActiveReleaseId() || getDatabase().prepare('SELECT 1 FROM cms_release UNION ALL SELECT 1 FROM cms_inquiry UNION ALL SELECT 1 FROM cms_media_file LIMIT 1').get())) throw new ApiError(422, '新建模式仅用于未修改且无发布/询盘/上传媒体的初始实例；当前实例请使用合并草稿');
  const checked = await validateSitePackage(input.package), source = checked.snapshot;
  const productTemplateId = options.mode === 'merge' ? draft.content.pages.find(p => p.slug === '/products/:slug')?.id : undefined;
  const targetSettings=structuredClone(draft.content.settings);
  if(options.mode==='merge'){
    const targetLocales=siteLocales(targetSettings),missing=siteLocales(source.settings).filter(l=>!targetLocales.some(t=>t.code===l.code));
    if(missing.length&&!options.mergeLocales)throw new ApiError(422,`来源包含本站未启用语言 ${missing.map(l=>l.code).join('、')}，请明确选择合并语言配置后重新预检`);
    if(options.mergeLocales)targetSettings.locales=[...targetLocales,...missing];
  }
  const mapped = remapPortableSite(source, { namespace, prefix: options.prefix, skuPrefix: options.skuPrefix, enableJs: options.enableJs, merge: options.mode === 'merge', productTemplateId,...(options.mode==='merge'?{targetSettings}:{}) });
  const imported = asDraft(mapped.site), warnings = [...mapped.warnings];
  if(options.mode==='merge'&&options.mergeLocales)warnings.push(`明确合并语言：${siteLocales(targetSettings).map(l=>`${l.label} (${l.code})`).join('、')}。保留本站默认语言 ${targetSettings.language}；导入正文保留来源语言，语言前缀和翻译组已映射，配置仍需另选发布。`);
  let next: DraftContent;
  if (options.mode === 'fresh') next = { ...imported, settings: { ...draft.content.settings, ...mapped.site.settings, publicUrl: undefined } };
  else {
    const current = {...draft.content,settings:targetSettings};
    if(imported.settings.discovery?.mappings?.length){current.settings={...current.settings,discovery:{...current.settings.discovery,mappings:[...current.settings.discovery?.mappings||[],...imported.settings.discovery.mappings]}};warnings.push('保留目标客户企业身份与访问政策；只合并导入模型的结构化映射。');}
    for (const page of imported.pages) { const data=imported.editorData[page.id] as {root?:{props?:Record<string,unknown>}}; if(data.root?.props) data.root.props.brand=current.settings.name; }
    next = { ...current, pages: [...current.pages, ...imported.pages], editorData: { ...current.editorData, ...Object.fromEntries(Object.entries(imported.editorData).filter(([k]) => k !== '__themeControls')) }, products: [...current.products, ...imported.products], media: [...current.media, ...imported.media], contentModels: [...current.contentModels || [], ...imported.contentModels || []], contentEntries: [...current.contentEntries || [], ...imported.contentEntries || []], sharedBlocks: [...current.sharedBlocks || [], ...imported.sharedBlocks || []], forms: [...current.forms || [], ...imported.forms || []], taxonomies: [...current.taxonomies || [], ...imported.taxonomies || []], redirects: [...current.redirects || [], ...imported.redirects || []], pageTemplates: [...current.pageTemplates || [], ...imported.pageTemplates || []], theme: { ...current.theme, tokens: [...current.theme.tokens || [], ...imported.theme.tokens || []], presets: [...current.theme.presets || [], ...imported.theme.presets || []] }, siteLayout: current.siteLayout ? { ...current.siteLayout, menus: [...current.siteLayout.menus || [], ...imported.siteLayout?.menus || []] } : imported.siteLayout ? { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' }, menus: imported.siteLayout.menus } : undefined, customCode: { global: current.customCode?.global || { css: '',js: '',cssEnabled:false,jsEnabled:false }, pages: { ...current.customCode?.pages, ...imported.customCode?.pages } } };
    const skus = next.products.map(p => p.sku.toLowerCase()); if (new Set(skus).size !== skus.length) throw new ApiError(422, 'SKU与已有产品重复，请明确填写SKU前缀后重新预检；不会自动改型号');
    warnings.push('合并保留本站品牌、基础主题、页眉页脚和全站代码；导入页面会继承本站基础样式。源站同步区块和菜单保留为可编辑资源，可手动应用。整站视觉完全还原请使用全新实例。');
    if (productTemplateId) warnings.push('本站产品默认详情保持不变。来源详情设计保存在页面模板资源库，导入产品使用本站详情模板。');
  }
  // 只移除本模块构造时的可选undefined属性；来源数据已经过safeJson校验，未知组件从不丢弃。
  next = JSON.parse(JSON.stringify(next)) as DraftContent; validateDraft(next);
  warnings.push('只写入草稿，不发布、不恢复账号/会话/询盘/邮件凭据。来源公开邮箱等内容会进入新建站点，请替换为客户真实资料。', '授权记录由分发者填写，不等于系统替您取得第三方素材再分发权；原始分发包由您保留。', '自定义代码是可信管理员功能；查看代码清单，动态选择器和外部接口须人工核对。');
  const code = [{ scope: '全站', ...source.customCode?.global || { css:'',js:'',cssEnabled:false,jsEnabled:false } }, ...Object.entries(source.customCode?.pages || {}).map(([scope,c]) => ({ scope, ...c })), ...(source.pageTemplates || []).filter(t => t.code).map(t => ({ scope: `模板 ${t.name}`, ...t.code! }))].filter(c => c.css || c.js);
  return { checked, next, options, expected, mapped, warnings, code, digest: hash(JSON.stringify(input.package)) };
}
export async function previewSitePackage(value: unknown, now = Date.now()): Promise<SitePackagePreview> {
  const namespace = randomBytes(6).toString('hex'), plan = await prepare(value, namespace), pkg = plan.checked.package;
  return { revision: plan.expected, name: pkg.manifest.name, description: pkg.manifest.description, license: pkg.manifest.license, dependencies: pkg.manifest.dependencies, counts: { pages: plan.mapped.site.pages.length, products: plan.mapped.site.products.length, entries: plan.mapped.site.contentEntries?.length || 0, media: plan.mapped.site.media.length, templates: plan.mapped.site.pageTemplates?.length || 0 }, paths: [...plan.mapped.paths].filter(([from]) => !from.startsWith('/api/media/') && !from.startsWith('/images/')).map(([from,to]) => ({from,to})), code: plan.code, warnings: plan.warnings, errors: [], confirmation: `1.${plan.expected}.${now}.${namespace}.${signature(plan.digest, plan.options, plan.expected, now, namespace)}` };
}
/** 先验证整个包，随后同一SQLite事务提交文件索引/草稿；失败只清理本次新建的内容哈希文件，既有文件不动。 */
export async function commitSitePackage(value: unknown, now = Date.now(), actor?:ActorIdentity, checkAccess?: () => void) {
  const input = object(value, '分发包导入'), options = optionsFor(input.options), expected = revision(input.expectedRevision), parts = typeof input.confirmation === 'string' ? input.confirmation.split('.') : [], timestamp = Number(parts[2]);
  if (parts.length !== 5 || parts[0] !== '1' || parts[1] !== String(expected) || !Number.isSafeInteger(timestamp) || timestamp > now || now - timestamp > 300000 || !/^[a-f0-9]{12}$/.test(parts[3]) || !/^[a-zA-Z0-9_-]{43}$/.test(parts[4])) throw new ApiError(409, '预检已过期或确认无效，请重新预检');
  const sig = signature(hash(JSON.stringify(input.package)), options, expected, timestamp, parts[3]); if (!timingSafeEqual(Buffer.from(sig), Buffer.from(parts[4]))) throw new ApiError(409, '文件或选项已变化，请重新预检');
  const plan = await prepare(value, parts[3]), created: string[] = [], directory = join(getDataDirectory(), 'media'); mkdirSync(directory, { recursive: true });
  try {
    getDatabase().transaction(() => {
      // 解码与校验会异步等待；HTTP调用在真正写文件索引和草稿前再次核对当前会话权限。
      checkAccess?.();
      if (getDraftRecord().revision !== expected) throw new ApiError(409, '工作区已变化，分发包尚未导入');
      for (const file of plan.checked.files) {
        const path = join(directory, file.filename);
        if (!existsSync(path)) { writeFileSync(path, file.bytes, { flag: 'wx' }); created.push(path); }
        else if (hash(readFileSync(path)) !== file.hash) throw new ApiError(422, '本机已有同名媒体损坏，导入取消；请先检查磁盘或恢复备份');
        getDatabase().prepare('INSERT INTO cms_media_file(id,filename,mime,bytes,sha256,created_at) VALUES(?,?,?,?,?,?)').run(plan.mapped.id('media', file.id), file.filename, file.mime, file.bytes.length, file.hash, new Date().toISOString());
      }
      writeDraft(plan.next, expected);
      if(actor)recordAudit(actor,'package.import','success',{objectIds:plan.mapped.site.pages.map(p=>p.id),revision:expected+1,fields:[plan.options.mode],jsEnabledScopes:plan.options.enableJs?Object.keys(plan.mapped.site.customCode?.pages||{}):[]});
    }).immediate();
  } catch (error) { for (const path of created) try { unlinkSync(path); } catch { /* 失败时只可能留下无索引孤立文件，交由容量诊断识别，不能删既有媒体。 */ } throw error; }
  return getStudioEnvelope();
}
