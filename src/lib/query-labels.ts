import type {ContentQuery,QueryLabelKey} from './types';
export const QUERY_LABEL_NAMES:Record<QueryLabelKey,string>={search:'搜索',category:'分类',all:'全部',apply:'应用筛选',previous:'上一页',next:'下一页',results:'结果单位',content:'内容名称后备',pagination:'分页导航说明',empty:'此语言空状态（优先于通用提示）'};
const en:Record<QueryLabelKey,string>={search:'Search',category:'Category',all:'All',apply:'Apply',previous:'Previous',next:'Next',results:'results',content:'content',pagination:'Pagination',empty:'No content is available yet.'};
const de:Record<QueryLabelKey,string>={search:'Suche',category:'Kategorie',all:'Alle',apply:'Anwenden',previous:'Zurück',next:'Weiter',results:'Ergebnisse',content:'Inhalte',pagination:'Seitennavigation',empty:'Noch keine Inhalte verfügbar.'};
const zh:Record<QueryLabelKey,string>={search:'搜索',category:'分类',all:'全部',apply:'筛选',previous:'上一页',next:'下一页',results:'条结果',content:'内容',pagination:'分页导航',empty:'暂无内容。'};
/** 系统控件可用基础译名，作者按语言覆盖；不自动翻译业务正文。 */
export function queryLabels(query:ContentQuery|undefined,locale='en'){return {...(locale==='de'?de:locale==='zh-CN'?zh:en),...query?.labels?.[locale]};}
