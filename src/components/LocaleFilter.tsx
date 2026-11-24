"use client";
import {Select} from 'antd';
import {siteLocales,type LocaleSettings} from '@/lib/localization';
/** 内容语言筛选独立于后台显示语言，不修改内容或发布范围。 */
export default function LocaleFilter({settings,value,onChange}:{settings:LocaleSettings;value:string;onChange:(v:string)=>void}){
 const languages=siteLocales(settings);return languages.length<2?null:<Select aria-label="内容语言筛选" value={value} onChange={onChange} style={{minWidth:140}} options={[{value:'all',label:'全部语言'},...languages.map(l=>({value:l.code,label:l.label}))]}/>;
}
