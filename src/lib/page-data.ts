import type { Data } from '@puckeditor/core';
import type { PageItem } from './types';

// 模板提供真实可编辑的嵌套节点；空白模板保留空 content，绝不偷偷套用首页。
export function createPageData(kind = 'home'): Data {
  let counter = 0;
  const node = (type: string, props: Record<string, unknown>) => ({ type, props: { id: `${kind}-${type}-${++counter}`, ...props } });
  const heading = (text: string, size = 44, color = '#222a25', level?: 'h1') => node('Heading', { text, size, mobileSize: Math.min(size, 38), color, align: 'left', style: 'serif', spacing: 0, ...(level ? { level } : {}) });
  // 示例的首屏主标题明确为 H1；字号与语义分开，其他标题沿用原外观和层级。
  const pageHeading = (text: string, size: number, color?: string) => heading(text, size, color, 'h1');
  const text = (value: string, color = '#657067') => node('Text', { text: value, size: 15, color, align: 'left', maxWidth: 480 });
  const button = (label: string, href: string, style = 'theme') => node('ActionButton', { text: label, href, kind: style, align: 'left' });
  const container = (content: Data['content'], extra: Record<string, unknown> = {}) => node('Container', { content, layout: 'column', columns: 2, mobileColumns: 1, gap: 20, padding: 60, inset: 48, background: '#f7f5f0', image: '', minHeight: 120, align: 'start', ...extra });
  // 新布局继承实例品牌；演示文案仍仅在明确选择示例时产生。
  const root = { props: { title: kind === 'home' ? '首页' : '新页面', brand: '', showChrome: kind === 'blank' ? 'no' : 'yes' } };
  if (kind === 'blank') return { root, content: [] };
  if (kind === 'product-detail') return { root, content: [node('ProductDetail', { productId: '', layout: 'split', imageHeight: 550, padding: 64, cta: 'Enquire about this piece' })] };
  if (kind === 'craft') return { root, content: [container([text('MATERIALS & PERSPECTIVE'), pageHeading('Beauty in the details.', 58), text('An editable concept page for your materials, process and point of view.')]), node('Image', { src: '/images/studio.jpg', alt: 'Morrow material and interior study', height: 480, fit: 'cover', radius: 0 }), container([heading('Honest materials. Thoughtful choices.'), text('Use this space to share your own process and verified product information. Replace these sample words with your story.')])] };
  const products = node('ProductList', { eyebrow: 'THE CONSIDERED COLLECTION', title: 'Good things, made to stay.', columns: 3, mobileColumns: 1, count: 3, category: '', padding: 64 });
  if (kind === 'products') return { root, content: [container([text('OUR COLLECTION'), pageHeading('Objects with a sense of purpose.', 56), text('Furniture and objects designed around real life. Explore our considered collection.')]), products] };
  if (kind === 'about') return { root, content: [container([pageHeading('A slower, more considered way.', 54), text('We believe the places we inhabit should feel natural, personal and quietly extraordinary.')]), container([node('Image', { src: '/images/studio.jpg', alt: 'Inside our design studio', height: 440, fit: 'cover', radius: 0 }), container([text('OUR STORY'), heading('Made with intention.'), text('Morrow is a concept for considered living. This editable sample page brings together honest materials and thoughtful details.')], { inset: 28 })], { layout: 'grid', background: '#ffffff', padding: 48 })] };
  if (kind === 'contact') return { root, content: [container([text('LET’S TALK'), pageHeading('Every good space starts with a conversation.', 58), text('Tell us about your project, ask about a piece, or simply say hello.'), button('Say hello', 'mailto:hello@example.invalid')], { minHeight: 460, padding: 90 }), node('Image', { src: '/images/studio.jpg', alt: 'Morrow studio', height: 380, fit: 'cover', radius: 0 })] };
  return { root, content: [container([text('CONSIDERED LIVING, EVERY DAY', '#ffffff'), pageHeading('Room for\nwhat matters.', 72, '#ffffff'), text('Thoughtful pieces. Natural materials.\nA quieter kind of home.', '#f2f0e9'), button('Explore the collection', '#collection', 'light')], { background: '#6a705e', image: '/images/interior.jpg', minHeight: 570, padding: 64, inset: 60, align: 'center', gap: 22 }), products, container([node('Image', { src: '/images/studio.jpg', alt: 'Natural materials in the Morrow studio', height: 390, fit: 'cover', radius: 0 }), container([text('OUR POINT OF VIEW'), heading('Less, but more meaningful.'), text('A home is a collection of things you love. We make thoughtful pieces that find their place in yours.'), button('Discover our story', '#story', 'outline')], { inset: 24, padding: 30 })], { layout: 'grid', background: '#f0eee7', gap: 40, padding: 52 })] };
}

// 页面 ID 优先于中文显示类型和 URL，避免 /collections 被误认为空白页。
export function getPageKind(page?: Pick<PageItem, 'id' | 'type' | 'slug' | 'contentModelId'>): string {
  if (!page) return 'blank';
  // 内容模型模板从空白画布创建，不能被显示名称里的“详情”误识别为产品模板。
  if (page.contentModelId) return 'blank';
  if (['home', 'about', 'products', 'product-detail', 'craft', 'contact'].includes(page.id)) return page.id;
  if (page.slug === '/' || page.type === 'home' || page.type === '首页') return 'home';
  if (page.type === 'product-detail' || page.type.includes('详情') || /\/(products|collections)\/:/.test(page.slug)) return 'product-detail';
  if (page.type === 'products' || page.type === '产品列表' || /^\/(collections|products)\/?$/.test(page.slug)) return 'products';
  if (page.type === 'about' || page.slug.includes('about')) return 'about';
  if (page.type === 'contact' || page.slug.includes('contact')) return 'contact';
  if (page.type === 'craft' || page.slug.includes('craft')) return 'craft';
  return 'blank';
}

export function getPageData(page?: Pick<PageItem, 'id' | 'type' | 'slug' | 'contentModelId'>): Data {
  return createPageData(getPageKind(page));
}
