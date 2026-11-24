import { randomUUID } from 'node:crypto';
import type { AiTranslationTerm } from '../lib/ai-translation-types';
import type { TranslationGlossary, TranslationGlossaryEntry } from '../lib/ai-site-translation-types';
import { assertFixedTranslationTerms, normalizeTranslationTerms } from '../lib/ai-translation';
import { siteLocales } from '../lib/localization';
import { getDatabase } from './database';
import { getDraftRecord } from './studio';
import { ApiError } from './http';
import { object, revision } from './validation';
import { isMemberDisabled, requirePermission, type Actor, type MemberRow } from './permissions';
import { recordAudit } from './audit';
/** 术语属于全站管理员维护的私有设置，模型密钥及整篇正文不存入本表。 */
export function siteTranslationAdmin(actor: Actor): Actor { requirePermission(actor,'manage'); const row=getDatabase().prepare('SELECT id,name,email,role,banned,banExpires FROM auth_user WHERE id=?').get(actor.id) as MemberRow|undefined; if(!row||isMemberDisabled(row))throw new ApiError(401,'账号已停用或会话失效');if(row.role!=='admin')throw new ApiError(403,'整站翻译仅管理员可核对使用');return{id:row.id,name:row.name,email:row.email,role:row.role}; }
function readGlossary(): TranslationGlossary { const row=getDatabase().prepare('SELECT revision,config_json,updated_at FROM cms_ai_translation_glossary WHERE id=1').get() as {revision:number;config_json:string;updated_at:string}|undefined; return row?{revision:row.revision,entries:JSON.parse(row.config_json).entries,updatedAt:row.updated_at}:{revision:0,entries:[],updatedAt:null}; }
export function getTranslationGlossary(actor: Actor): TranslationGlossary { siteTranslationAdmin(actor);return readGlossary(); }
/** 内部生成服务已先鉴权，按明确语言对读取；不隐式联网或把其他语言术语发给模型。 */
export function translationGlossaryTerms(sourceLocale:string,targetLocale:string):AiTranslationTerm[]{return readGlossary().entries.filter(item=>item.sourceLocale===sourceLocale&&item.targetLocale===targetLocale).map(({source,target})=>({source,target}));}
export function saveTranslationGlossary(value:unknown,actor:Actor,checkAccess?:()=>void):TranslationGlossary {
  siteTranslationAdmin(actor);const input=object(value,'翻译术语库');if(Object.keys(input).some(key=>!['expectedRevision','entries'].includes(key)))throw new ApiError(422,'术语库包含未知字段');const expected=revision(input.expectedRevision);
  if(!Array.isArray(input.entries)||input.entries.length>100)throw new ApiError(422,'术语库最多保存100项，每个语言对最多30项');
  const content=getDraftRecord().content,locales=new Set(siteLocales(content.settings).map(item=>item.code)),ids=new Set<string>(),pairs=new Map<string,AiTranslationTerm[]>();
  const entries:TranslationGlossaryEntry[]=input.entries.map(raw=>{const row=object(raw,'术语条目');if(Object.keys(row).some(key=>!['id','source','target','sourceLocale','targetLocale'].includes(key))||typeof row.sourceLocale!=='string'||typeof row.targetLocale!=='string'||row.sourceLocale===row.targetLocale||!locales.has(row.sourceLocale)||!locales.has(row.targetLocale))throw new ApiError(422,'术语需选择两个不同且已配置的站点语言');const id=row.id===undefined?`term-${randomUUID()}`:row.id;if(typeof id!=='string'||!/^term-[A-Za-z0-9_-]{1,90}$/.test(id)||ids.has(id))throw new ApiError(422,'术语标识重复或无效');ids.add(id);let term:AiTranslationTerm;try{term=normalizeTranslationTerms([{source:row.source,target:row.target}])[0];assertFixedTranslationTerms([term],[content.settings.name]);}catch(error){throw new ApiError(422,(error as Error).message);}const pair=`${row.sourceLocale}\0${row.targetLocale}`,items=pairs.get(pair)||[];items.push(term);pairs.set(pair,items);return{id,sourceLocale:row.sourceLocale,targetLocale:row.targetLocale,...term};});
  try{for(const terms of pairs.values())normalizeTranslationTerms(terms);}catch(error){throw new ApiError(422,(error as Error).message);}
  return getDatabase().transaction(()=>{checkAccess?.();siteTranslationAdmin(actor);const old=readGlossary();if(old.revision!==expected)throw new ApiError(409,'术语库已被其他窗口修改，请保留输入后读取最新版本');const now=new Date().toISOString();getDatabase().prepare('INSERT INTO cms_ai_translation_glossary(id,revision,config_json,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at').run(expected+1,JSON.stringify({entries}),now);recordAudit(actor,'ai.writing.profile','success',{fields:['translation.glossary']});return readGlossary();}).immediate();
}
