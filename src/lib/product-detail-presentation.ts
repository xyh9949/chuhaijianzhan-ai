export const PRODUCT_DETAIL_ORDERS = ['image-first', 'identity-first', 'specifications-first', 'overview-first'] as const;
export type ProductDetailActionFallback = 'email' | 'contact';

/** 旧版本把无明确链接时的询盘去向与顺序绑定；调序时可单独保留原去向。 */
export function productDetailDefaultAction(order: unknown): ProductDetailActionFallback {
  return PRODUCT_DETAIL_ORDERS.slice(1).some(item => item === order) ? 'contact' : 'email';
}

/** 缺省选项保持原来的图片优先，只有明确选择时才改变动态内容顺序。 */
export function productDetailPresentationErrors(props: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (props.mobileOrder !== undefined && !PRODUCT_DETAIL_ORDERS.some(order => order === props.mobileOrder)) errors.push('请选择受支持的产品详情顺序');
  if (props.ctaFallback !== undefined && props.ctaFallback !== 'email' && props.ctaFallback !== 'contact') errors.push('产品详情的默认询盘去向无效');
  if (props.ctaColor !== undefined && props.ctaColor !== '' && (typeof props.ctaColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(props.ctaColor))) errors.push('联系按钮颜色需为六位十六进制颜色，清空可恢复网站默认颜色');
  return errors;
}

/** 仅六位不透明颜色进入CSS变量，文字在纯黑/纯白中选择对比度更高的一种。 */
export function productDetailActionColors(value: unknown): { background: string; foreground: string } | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return undefined;
  const channels = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return { background: value, foreground: 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? '#ffffff' : '#000000' };
}
