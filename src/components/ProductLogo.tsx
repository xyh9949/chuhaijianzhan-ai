import Image from 'next/image';
import { PRODUCT_NAME } from '@/lib/product-brand';
import './product-logo.css';

export default function ProductLogo({ onDark = false, compact = false, decorative = false }: {
  onDark?: boolean;
  compact?: boolean;
  decorative?: boolean;
}) {
  // 横版使用审核通过的原图，小图标采用同一图案，避免在小尺寸呈现字标。
  return <Image
    src={compact ? '/admin/icon.png' : '/images/brand/chuhaijianzhan-ai.png'}
    alt={decorative ? '' : PRODUCT_NAME}
    width={compact ? 24 : 180}
    height={compact ? 24 : 60}
    className={onDark ? 'product-logo product-logo--on-dark' : 'product-logo'}
    unoptimized={compact}
  />;
}
