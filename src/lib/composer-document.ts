import type { RichNode } from './presentation-content';

/** Tiptap会为普通链接补title:null；只移除这个空默认值，保持既有安全格式和非空未知属性校验。 */
export function normalizeComposerDocument(document: RichNode): RichNode {
  const next = structuredClone(document);
  const visit = (node: RichNode) => {
    for (const mark of node.marks || []) {
      if (mark.type === 'link' && mark.attrs && Object.hasOwn(mark.attrs, 'title') && mark.attrs.title == null) delete mark.attrs.title;
    }
    node.content?.forEach(visit);
  };
  visit(next);
  return next;
}
