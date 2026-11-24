'use client';
import {Form} from 'antd';
import type {Field} from '@puckeditor/core';
import RichTextComposer from '../RichTextComposer';

/** 页面组件和内容正文复用同一受限JSON编辑器，Puck字段契约保持不变。 */
export function richTextField():Field{return {type:'custom',label:'富文本内容',render:({value,onChange,readOnly})=><Form.Item layout="vertical" colon={false} label="富文本内容"><RichTextComposer value={value} onChange={onChange} readOnly={readOnly} label="富文本内容"/></Form.Item>};}
