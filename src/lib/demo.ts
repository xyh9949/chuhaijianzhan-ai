import type { StudioState } from './types';

// 所有联系人、产品和版本均为界面演示，不代表真实客户经营数据。
export const initialState: StudioState = {
  activePageId: 'home', editorData: {},
  settings: { name: 'Morrow 家居', domain: 'morrow.example.com', description: 'Thoughtful furniture. Beautiful everyday living.', email: 'hello@morrow.example.com', language: 'en', timezone: 'Asia/Hong_Kong' },
  theme: { primary: '#25634E', background: '#F7F5F0', text: '#222D26', radius: 4, font: 'Georgia' },
  pages: [
    { id: 'home', title: '首页', slug: '/', status: 'draft', type: '首页', updated: '刚刚' },
    { id: 'about', title: '关于 Morrow', slug: '/about', status: 'published', type: '普通页面', updated: '11月05日 14:32' },
    { id: 'products', title: '产品系列', slug: '/collections', status: 'published', type: '产品列表', updated: '11月05日 11:20' },
    { id: 'product-detail', title: '产品详情', slug: '/products/:slug', status: 'published', type: '动态模板', updated: '11月04日 16:08' },
    { id: 'craft', title: '材料与工艺', slug: '/craftsmanship', status: 'draft', type: '普通页面', updated: '11月06日 09:40' },
    { id: 'contact', title: '联系我们', slug: '/contact', status: 'published', type: '普通页面', updated: '11月03日 10:15' },
  ],
  products: [
    { id: 'p1', name: 'Arc 弧线休闲椅', sku: 'MR-CH-001', category: '座椅', status: 'published', image: '/images/chair.jpg', description: '柔和曲线与简洁结构，为日常空间增添自然气息。演示产品，请以实际产品资料为准。', material: '木材 / 织物（示例）' },
    { id: 'p2', name: 'Linen 模块沙发', sku: 'MR-SF-002', category: '沙发', status: 'published', image: '/images/sofa.jpg', description: '可灵活组合的客厅系列。展示样品，不构成具体产品参数。', material: '织物（示例）' },
    { id: 'p3', name: 'Gather 餐厅系列', sku: 'MR-TB-003', category: '桌几', status: 'draft', image: '/images/interior.jpg', description: '围坐相聚，让平凡时刻值得珍藏。', material: '实木（示例）' },
    { id: 'p4', name: 'Quiet 空间系列', sku: 'MR-SP-004', category: '空间方案', status: 'published', image: '/images/studio.jpg', description: '为开放式办公与接待区域设计的空间灵感。', material: '混合材质（示例）' },
  ],
  media: [
    { id: 'm1', name: 'living-room-hero.jpg', url: '/images/interior.jpg', kind: 'image', folder: '品牌空间', size: '287 KB', alt: '自然光照射下的现代客厅' },
    { id: 'm2', name: 'linen-sofa.jpg', url: '/images/sofa.jpg', kind: 'image', folder: '产品图片', size: '46 KB', alt: '绿色双人沙发' },
    { id: 'm3', name: 'arc-lounge-chair.jpg', url: '/images/chair.jpg', kind: 'image', folder: '产品图片', size: '42 KB', alt: '简洁的设计休闲椅' },
    { id: 'm4', name: 'our-studio.jpg', url: '/images/studio.jpg', kind: 'image', folder: '品牌空间', size: '96 KB', alt: '充满自然光的工作空间' },
  ],
  inquiries: [
    { id: 'IQ-004', name: 'Alex Morgan', company: 'North & Co.（演示）', email: 'alex@example.com', country: '英国', product: 'Arc 弧线休闲椅', message: 'Hello, we are interested in your lounge chair collection for an upcoming hospitality project. Could you share the available finishes and a product catalogue?', date: '2026-11-06 10:24', status: 'new' },
    { id: 'IQ-003', name: 'Emma Wilson', company: 'Studio Eight（演示）', email: 'emma@example.com', country: '澳大利亚', product: 'Linen 模块沙发', message: 'We would like to explore fabric options for our showroom. Please send us more information.', date: '2026-11-05 16:40', status: 'new' },
    { id: 'IQ-002', name: 'Noah Chen', company: 'Gather Living（演示）', email: 'noah@example.com', country: '新加坡', product: 'Gather 餐厅系列', message: 'Interested in becoming a distributor. Could we discuss the available collections?', date: '2026-11-04 09:18', status: 'contacted' },
    { id: 'IQ-001', name: 'Sofia Rossi', company: 'Casa Studio（演示）', email: 'sofia@example.com', country: '意大利', product: 'Quiet 空间系列', message: 'Thank you for the information. We will review it with our design team.', date: '2026-11-03 11:06', status: 'archived' },
  ],
  releases: [
    { id: 'v1.3', title: '秋日产品系列更新', date: '2026-11-05 15:32', author: 'Lin', status: 'current', changes: ['更新产品系列页', '调整全站导航', '新增 Arc 休闲椅'] },
    { id: 'v1.2', title: '完善品牌与联系页面', date: '2026-11-03 10:18', author: 'Lin', status: 'history', changes: ['完善关于我们', '配置联系表单'] },
    { id: 'v1.1', title: 'Morrow 网站首次发布', date: '2026-11-01 14:05', author: 'Lin', status: 'history', changes: ['首页与基础页面', '全站样式与导航'] },
  ],
};
