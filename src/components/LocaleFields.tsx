'use client';
import {Alert,Form,Input,Select} from 'antd';
import {localeOf,localePrefix,siteLocales,type LocaleSettings} from '@/lib/localization';
import MoreSettings from './MoreSettings';
/** 确认译文仍需显式操作；仅折叠设置，保留原语言、关联编号和核对状态。 */
export default function LocaleFields({settings,page=false}:{settings:LocaleSettings;page?:boolean}){
 const form=Form.useFormInstance(),locale=Form.useWatch('locale',form)||localeOf(settings),review=Form.useWatch('translationState',form),prefix=localePrefix(settings,{locale});
 return <>
  {review==='needs-review'&&<Alert type="warning" showIcon title="这份内容还需要翻译并核对" description="请修改复制过来的文字，确认译文准确后，在下方多语言设置中标记已核对。核对前不能发布。" style={{marginBottom:16}}/>}
  <Form.Item noStyle shouldUpdate>{()=> <MoreSettings title="多语言版本（选填）" defaultOpen={review==='needs-review'} hasErrors={form.getFieldsError().some(f=>['locale','translationGroupId','translationState'].includes(String(f.name[0]))&&!!f.errors.length)} description="维护同一内容的不同语言版本时才需要设置；复制译文时会自动关联原文。">
   <Form.Item name="locale" label="内容语言" extra={page?`页面网址需使用 ${prefix||'/'} 开头。`:'每种语言的内容分别编辑、分别发布。'}><Select aria-label="内容语言" placeholder={settings.language||'en'} options={siteLocales(settings).map(l=>({value:l.code,label:`${l.label} · ${l.code}`}))}/></Form.Item>
   <Form.Item name="translationState" label="翻译进度"><Select aria-label="翻译核对状态" placeholder="原文 / 尚未标记" options={[...(review==='needs-review'?[]:[{value:'source',label:'原文'}]),{value:'needs-review',label:'尚未核对，暂不能发布'},{value:'reviewed',label:'译文已编辑并核对'}]}/></Form.Item>
   <MoreSettings title="手动关联译文（高级）" description="一般由复制译文功能自动填写。手动关联已有内容时，同一组的不同语言使用相同编号。">
    <Form.Item name="translationGroupId" label="译文关联编号" getValueFromEvent={e=>e.target.value||undefined} rules={[{validator:(_,v)=>!v||/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v)?Promise.resolve():Promise.reject(new Error('使用最多100位字母、数字、连字符或下划线'))}]}><Input aria-label="翻译组标识" maxLength={100}/></Form.Item>
   </MoreSettings>
  </MoreSettings>}</Form.Item>
 </>;
}
