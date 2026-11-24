import type { PageItem, Product, Release } from './types';

export const PUBLICATION_STATE = {
  published: { label: '已发布', color: 'success' },
  modified: { label: '待更新', color: 'processing' },
  draft: { label: '草稿', color: 'default' },
} as const;
export { PUBLICATION_STATE as PAGE_PUBLICATION_STATE };
export type PublicationState = keyof typeof PUBLICATION_STATE;

/** status 表示草稿与线上是否一致；只有当前公开快照里的 ID 才属于已上线。 */
function publicationState(releases: Release[], collection: 'pages' | 'products') {
  const published = releases.find(release => release.status === 'current')?.snapshot?.[collection];
  const publicIds = new Set(Array.isArray(published) ? published.map((item: PageItem | Product) => item.id) : []);
  return (item: PageItem | Product): PublicationState =>
    publicIds.has(item.id) ? item.status === 'published' ? 'published' : 'modified' : 'draft';
}

export function pagePublicationState(releases: Release[]) { return publicationState(releases, 'pages'); }

export function productPublicationState(releases: Release[]) { return publicationState(releases, 'products'); }
