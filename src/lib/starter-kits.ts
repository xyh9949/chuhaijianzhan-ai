import type { SiteSnapshot } from '../server/types';
import { createManufacturingStarter } from './starters/manufacturing';
import { createServicesStarter } from './starters/services';
import { createPortfolioStarter } from './starters/portfolio';

/** 案例资料仅用于选用与预览；网站内容仍由普通可编辑快照生成，不增加专用渲染器。 */
export const STARTER_KITS = [
  { id: 'manufacturing', name: '制造企业 · Atlas Works', industry: '工业制造', style: '工业编辑风', recommended: true, pageCount: 10, cover: '/showcase/manufacturing.png', description: '暖白、深海蓝与铜橙。完整呈现产品、制造能力、质量流程和工程案例，适合作为外贸企业的起点。', features: ['产品目录与详情', '能力与质量流程', '工程案例', 'FAQ 与询盘'], color: '#173443', accent: '#f4f1eb' },
  { id: 'services', name: '空间设计 · North Atelier', industry: '专业服务', style: '克制的空间杂志', recommended: false, pageCount: 8, cover: '/showcase/services.png', description: '象牙白、酒红与衬线标题。大幅空间插画与安静的留白，展示服务、项目与合作方式。', features: ['服务与详情', '空间项目', '合作流程', '联系表单'], color: '#6c333b', accent: '#f3eee6' },
  { id: 'portfolio', name: '创意工作室 · Field Studio', industry: '品牌与数字设计', style: '大胆的创意排版', recommended: false, pageCount: 8, cover: '/showcase/portfolio.png', description: '深森林绿、荧光绿与大字。用不对称版式、可编辑图形和项目叙事展示创作能力。', features: ['项目列表与详情', '品牌与数字服务', '工作方式', '项目咨询'], color: '#c4f76a', accent: '#202723' },
] as const;
export type StarterKind = typeof STARTER_KITS[number]['id'];

/** 每次返回独立快照，编辑或导入一个案例不会污染其他案例及当前站点。 */
export function createStarterSnapshot(kind: StarterKind): SiteSnapshot {
  switch (kind) {
    case 'manufacturing': return createManufacturingStarter();
    case 'services': return createServicesStarter();
    case 'portfolio': return createPortfolioStarter();
    default: throw new Error('未知演示套件');
  }
}
