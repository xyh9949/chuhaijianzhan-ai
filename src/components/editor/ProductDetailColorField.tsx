'use client';

import { useEffect, useState } from 'react';
import { ColorPicker, Form, Input, Space } from 'antd';

/** 输入中的半成品只留本地；合法颜色或明确空串才进入原生草稿，清空不会写undefined。 */
export function ProductDetailColorField({ value, onChange, id, fallback }: { value: unknown; onChange: (value: string) => void; id?: string; fallback: string }) {
  const [draft, setDraft] = useState(String(value ?? '')), [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(value ?? '')); setInvalid(false); }, [value]);
  function commit() { const next = draft.trim(); if (next && !/^#[0-9a-fA-F]{6}$/.test(next)) { setInvalid(true); return; } setInvalid(false); setDraft(next); onChange(next); }
  return <Form.Item className="editor-property" label="联系按钮颜色" htmlFor={id} layout="vertical" validateStatus={invalid ? 'error' : undefined} help={invalid ? '请输入六位颜色，例如 #653f31；或清空恢复默认。' : '留空使用网站默认颜色。'}><Space.Compact style={{ width: '100%' }}><ColorPicker value={/^#[0-9a-fA-F]{6}$/.test(draft) ? draft : fallback} disabledAlpha onChangeComplete={color => { const next = color.toHexString(); setDraft(next); setInvalid(false); onChange(next); }} /><Input id={id} aria-label="联系按钮颜色" value={draft} placeholder="使用网站默认颜色" allowClear onChange={event => { const next = event.target.value; setDraft(next); setInvalid(false); if (!next) onChange(''); }} onBlur={commit} onPressEnter={commit} /></Space.Compact></Form.Item>;
}
