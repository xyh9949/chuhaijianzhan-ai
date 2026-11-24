import type { Data } from '@puckeditor/core';

/** 与Puck初始化使用同一根默认值；生成资产提前补齐，避免无操作打开编辑器产生伪变更。 */
export const EDITOR_ROOT_DEFAULT_PROPS = { title: '新页面', brand: '', showChrome: 'yes' };

/** 仅补缺失的根属性，显式布局/上下文/页眉设置与内容节点保持；不改调用方原对象。 */
export function withEditorRootDefaults(data: Data): Data {
  return { ...data, root: { ...data.root, props: { ...EDITOR_ROOT_DEFAULT_PROPS, ...data.root?.props } }, zones: data.zones || {} } as Data;
}
