import type { QueryParams } from './content-query';
import { hasInvalidLoopPage } from './loop-pages';
import { resolveSitePage } from './site-routing';
import { STARTER_KITS, createStarterSnapshot } from './starter-kits';

/** 案例的页面、详情和分页只读同一演示快照，绝不回退到客户当前草稿。鉴权由私有预览路由负责。 */
export function resolveStarterPreview(segments: string[], queryParams: QueryParams = {}) {
  if (segments[0] !== '~starter') return null;
  const kit = STARTER_KITS.find(item => item.id === segments[1]);
  if (!kit) return null;
  const snapshot = createStarterSnapshot(kit.id);
  const resolved = resolveSitePage(snapshot, segments.slice(2));
  if (!resolved || hasInvalidLoopPage(snapshot, resolved, queryParams)) return null;
  return { kit, snapshot, resolved, previewPrefix: `/preview/~starter/${kit.id}` };
}
