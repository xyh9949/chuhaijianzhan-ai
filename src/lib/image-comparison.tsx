import type { Config } from '@puckeditor/core';
import { isLocalImagePath } from './bundled-media';
import { imageAttributes } from './media-images';
import { safeImageSrc } from './site-safety';
import type { MediaItem } from './types';

export interface ImageComparisonSide {
  src: string;
  label: string;
  alt: string;
}

const sides = ['before', 'after'] as const;
const sideNames = { before: '对比前', after: '对比后' };
export const imageComparisonDefaults = {
  title: '',
  before: { src: '', label: 'Before', alt: '' },
  after: { src: '', label: 'After', alt: '' },
  mode: 'toggle' as 'toggle' | 'split',
};

/** 草稿可预留图片位。发布需要两张本地图片及可读说明；具体素材是否存在由发布依赖校验。 */
export function imageComparisonErrors(props: Record<string, unknown>, publishing: boolean): string[] {
  const errors: string[] = [];
  if (props.title !== undefined && (typeof props.title !== 'string' || props.title.length > 200)) errors.push('图片对比标题最多 200 字');
  if (props.mode !== 'toggle' && props.mode !== 'split') errors.push('图片对比方式无效');
  for (const side of sides) {
    const value = props[side];
    const name = sideNames[side];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${name}的图片设置无效`);
      continue;
    }
    const { src, label, alt } = value as Record<string, unknown>;
    if (!(src === '' && !publishing) && !isLocalImagePath(src)) errors.push(`${name}请选择素材库图片`);
    if (typeof label !== 'string' || label.length > 100 || (publishing && !label.trim())) errors.push(`${name}的显示名称需填写，最多 100 字`);
    if (typeof alt !== 'string' || alt.length > 500 || (publishing && !alt.trim())) errors.push(`${name}的替代文字需描述图片，最多 500 字`);
  }
  return errors;
}

/** 切换使用原生单选和现有标签页样式，隔离预览、公开页和无 JavaScript 模式共用。 */
export function createImageComparisonView({ media, derived = true, editorCanvas = false }: { media?: MediaItem[]; derived?: boolean; editorCanvas?: boolean }): Config['components'][string] {
  return {
    render: ({ id, title = '', before, after, mode }) => {
      const comparison = { before: before || imageComparisonDefaults.before, after: after || imageComparisonDefaults.after };
      const labels = { before: comparison.before.label?.trim() || 'Before', after: comparison.after.label?.trim() || 'After' };
      const split = mode === 'split';
      const figure = (side: typeof sides[number]) => {
        const { src, alt } = comparison[side] as ImageComparisonSide;
        const image = isLocalImagePath(src) ? safeImageSrc(src) : undefined;
        const attrs = image ? imageAttributes(image, media, 'auto', derived) : undefined;
        return <figure key={side} className="site-image-comparison-figure">
          {attrs ? <img {...attrs} sizes={!split && attrs.srcSet ? '(min-width: 1200px) 1120px, 100vw' : attrs.sizes} alt={alt?.trim() || labels[side]} /> : editorCanvas ? <div className="site-image-comparison-placeholder">{sideNames[side]} · 请选择图片</div> : null}
          {split && (attrs || editorCanvas) ? <figcaption>{labels[side]}</figcaption> : null}
        </figure>;
      };
      return <section className="site-image-comparison">
        {title.trim() ? <h2>{title}</h2> : null}
        {split ? <div className="site-image-comparison-split">{sides.map(figure)}</div> :
          <div className="site-tabs site-image-comparison-toggle" role="group" aria-label={title.trim() || `${labels.before} / ${labels.after}`}>
            {sides.map((side, index) => {
              const inputId = `${id}-image-comparison-${side}`;
              return <div className="site-tab" key={side}>
                <input type="radio" id={inputId} name={`${id}-image-comparison`} defaultChecked={index === 0} aria-controls={`${inputId}-panel`} />
                <label htmlFor={inputId} style={{ gridColumn: index + 1 }}>{labels[side]}</label>
                <section id={`${inputId}-panel`} aria-label={labels[side]}>{figure(side)}</section>
              </div>;
            })}
          </div>}
      </section>;
    },
  };
}
