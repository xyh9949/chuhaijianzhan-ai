/** 公开组件内置文案的原生覆盖点；字典只允许已知纯文字，不允许模型新增属性或改公司事实。 */
export const COMPONENT_TRANSLATABLE_LABELS: Record<string, Record<string, string>> = {
  CompanyFacts: { company: 'Company', alternateName: 'Also known as', role: 'Role', address: 'Address', telephone: 'Telephone', email: 'Email', source: 'Source', reviewed: 'Reviewed', validUntil: 'Valid until', profile: 'Official profile' },
  Download: { download: 'Download catalog (PDF)' },
  Breadcrumb: { home: 'Home', navigation: 'Breadcrumb' },
  Navigation: { navigation: 'Website navigation', open: 'Open' },
  LanguageSwitcher: { languages: 'Languages' },
  ProductList: { countSuffix: 'considered pieces', empty: 'No products are available in this collection.' },
  ProductDetail: { unavailable: 'This product is currently unavailable.', collection: 'THE COLLECTION', reference: 'REFERENCE', material: 'MATERIAL', contactNote: 'Contact our studio for product information.', gallery: 'product images', chooseImage: 'Choose product image', viewImage: 'View product image', thumbnail: 'thumbnail' },
  ContentList: { empty: 'No content is available yet.' },
  Gallery: { open: 'Open image', image: 'Gallery image', close: 'Close', closeImage: 'Close image' },
  Tabs: { sections: 'Content sections' },
  Carousel: { images: 'Image carousel', content: 'Content carousel', slide: 'Slide', controls: 'controls', previous: 'Previous', previousSlide: 'Previous slide', next: 'Next', nextSlide: 'Next slide' },
  Video: { unavailable: 'Select an approved video source.' },
  Form: { select: 'Please select', confirm: 'Please confirm this field.', required: 'Please complete this field.', email: 'Please enter a valid email.', retry: 'Retry the same inquiry', refresh: 'Refresh form session', unconfirmed: 'Receipt is unconfirmed. Your input is locked so retrying checks the same inquiry without creating a duplicate.', receiptError: 'We could not confirm receipt. Please retry the same inquiry.', tryAgain: 'Please try again.', noScript: 'JavaScript is required to submit this form. You can also use the contact details provided on this website.' },
};
export const COMPONENT_LABEL_NAMES: Record<string,string> = {company:'公司',alternateName:'别名',role:'企业角色',address:'地址',telephone:'电话',email:'邮箱',source:'证据来源',reviewed:'复核日期说明',validUntil:'有效期说明',profile:'官方主页',download:'缺省下载按钮',home:'缺省首页文字',navigation:'导航说明',languages:'缺省语言说明',countSuffix:'数量单位',empty:'无内容提示',unavailable:'不可用提示',collection:'系列说明',reference:'型号说明',material:'材料说明',contactNote:'联系提示',gallery:'相册说明',chooseImage:'选择图片说明',viewImage:'查看图片说明',thumbnail:'缩略图说明',open:'打开说明',image:'缺省图片说明',close:'关闭按钮',closeImage:'关闭图片说明',sections:'内容组说明',images:'图片组说明',content:'内容说明',slide:'当前项说明',controls:'操作说明',previous:'上一项按钮',previousSlide:'上一项说明',next:'下一项按钮',nextSlide:'下一项说明',select:'选择提示',confirm:'勾选确认提示',required:'必填提示',retry:'重试按钮',refresh:'刷新按钮',unconfirmed:'接收未确认提示',receiptError:'接收异常提示',tryAgain:'一般重试提示',noScript:'浏览器脚本提示'};

/** 保存、发布和导入共用同一字典校验；只允许当前组件的已知文本覆盖，不扩展可执行结构。 */
export function componentTranslatableLabelErrors(type:string,value:unknown):string[]{
  if(value===undefined)return[];
  const defaults=COMPONENT_TRANSLATABLE_LABELS[type];
  if(!defaults||!value||typeof value!=='object'||Array.isArray(value))return['此组件的控件提示文字格式无效'];
  return Object.entries(value).some(([key,text])=>!Object.hasOwn(defaults,key)||typeof text!=='string'||text.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))?['控件提示只能填写已知项目，每项最多1000字']:[];
}

/** 有意不套用页面语言猜测译文：缺省文案就是当前渲染的原词，翻译后写回同一原生组件。 */
export function componentTranslatableLabels(type: string, value?: unknown): Record<string, string> {
  const defaults = COMPONENT_TRANSLATABLE_LABELS[type] || {}, labels = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof labels[key] === 'string' && (labels[key] as string).trim() ? labels[key] as string : fallback]));
}
