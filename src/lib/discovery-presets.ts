/** 行业无关的资料起点；只建立字段和可拖拽模板，不生成认证、项目或业绩记录。 */
export const DISCOVERY_PRESETS=[
 {id:'capability',name:'工厂能力',schema:'WebPage',fields:[['summary','能力说明'],['process','实际工序'],['limits','能力与限制'],['evidence','证据与来源'],['author','资料负责人']]},
 {id:'selection',name:'选型与比较',schema:'TechArticle',fields:[['summary','直接回答'],['conditions','适用条件'],['comparison','比较与取舍'],['evidence','依据与来源'],['author','作者或审核人']]},
 {id:'case',name:'项目案例',schema:'Article',fields:[['summary','项目概况'],['constraints','客户需求与约束'],['solution','实际方案'],['results','结果与证据'],['author','资料负责人']]},
 {id:'certificate',name:'检测与认证',schema:'WebPage',fields:[['summary','资料说明'],['issuer','颁发或检测主体'],['scope','覆盖产品与范围'],['limits','有效期和适用限制'],['evidence','核验与文件来源']]},
 {id:'procurement',name:'采购指南',schema:'TechArticle',fields:[['summary','采购问题与回答'],['inputs','需要客户提供的资料'],['conditions','样品与交付条件'],['limits','限制与例外'],['author','资料负责人']]},
] as const;
