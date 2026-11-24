'use client';
import {Form,Select,Typography} from 'antd';
import type {Field} from '@puckeditor/core';
import type {StudioState} from '@/lib/types';
import {siteLocales} from '@/lib/localization';
/** 未配置语言映射时隐藏菜单，不隐式展示其他语言菜单；作者可明确复用同一个菜单。 */
export function localeMenusField(state:StudioState):Field{return {type:'custom',label:'其他语言菜单',render:({value,onChange,readOnly})=>{const selected=(value||{}) as Record<string,string>,languages=siteLocales(state.settings).filter(l=>l.code!==state.settings.language);return <div>{languages.map(l=><Form.Item label={l.label} key={l.code}><Select aria-label={`${l.code}导航菜单`} disabled={readOnly} value={selected[l.code]||''} options={[{value:'',label:'不显示此语言菜单'},...(state.siteLayout?.menus||[]).map(m=>({value:m.id,label:m.name}))]} onChange={id=>onChange(Object.fromEntries(Object.entries({...selected,[l.code]:id}).filter(([,v])=>v)))}/></Form.Item>)}<Typography.Text type="secondary">没有映射的语言不显示菜单；先在全站设计创建对应菜单，再明确选择。默认语言使用上方菜单。</Typography.Text></div>;}};}
