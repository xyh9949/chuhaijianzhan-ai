export interface BundledImage {
  url: string;
  mime: 'image/jpeg' | 'image/png';
  label: string;
  width?: number;
  height?: number;
}

/** 随应用分发的图片必须逐项登记；新增演示图不开放任意 public 路径或远程地址。 */
export const BUNDLED_IMAGES: readonly BundledImage[] = [
  { url: '/images/interior.jpg', mime: 'image/jpeg', label: '演示 · 室内', width: 1400, height: 1050 },
  { url: '/images/chair.jpg', mime: 'image/jpeg', label: '演示 · 椅子', width: 800, height: 1201 },
  { url: '/images/sofa.jpg', mime: 'image/jpeg', label: '演示 · 沙发', width: 800, height: 533 },
  { url: '/images/studio.jpg', mime: 'image/jpeg', label: '演示 · 工作室', width: 900, height: 601 },
  { url: '/images/showcase-factory.png', mime: 'image/png', label: '演示 · 制造工厂', width: 1672, height: 941 },
  { url: '/images/showcase-components.png', mime: 'image/png', label: '演示 · 工业零部件', width: 1672, height: 941 },
];

export function bundledImage(value: unknown): BundledImage | undefined {
  return typeof value === 'string' ? BUNDLED_IMAGES.find(image => image.url === value) : undefined;
}

/** 保存、导入和模型字段共用严格地址规则；不接受查询参数、编码变体或路径穿越。 */
export function isLocalImagePath(value: unknown): value is string {
  return typeof value === 'string' && (/^\/api\/media\/[a-zA-Z0-9_-]+$/.test(value) || !!bundledImage(value));
}

/** 自定义 CSS 只收集清单内的静态依赖；真实文件读取仍以完整清单地址为准。 */
export function bundledImageReferences(text: string): string[] {
  return [...new Set((text.match(/\/images\/[a-zA-Z0-9._-]+/g) || []).filter(url => !!bundledImage(url)))];
}
