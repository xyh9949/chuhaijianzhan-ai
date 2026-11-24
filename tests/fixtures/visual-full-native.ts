import type { DraftContent } from '../../src/server/types';

/** UI与生产保存探针共用完整原生夹具，避免只校验单个节点却遗漏菜单、表单和引用依赖。 */
export function visualFullNativePatch(original: Pick<DraftContent, 'editorData' | 'siteLayout' | 'forms'>, homeId: string): Pick<DraftContent, 'editorData' | 'siteLayout' | 'forms'> {
  const menuId = 'ui-full-menu', formId = 'ui-full-form';
  return {
    siteLayout: { ...(original.siteLayout || { header: { mode: 'default', blockId: '' }, footer: { mode: 'default', blockId: '' } }), menus: [...(original.siteLayout?.menus || []), { id: menuId, name: 'Visual native navigation', items: [{ id: 'ui-full-menu-group', label: 'Factory sections', children: [{ id: 'ui-full-menu-bottom', label: 'Page bottom', href: '#ui-full-bottom' }] }] }] },
    forms: [...(original.forms || []), { id: formId, name: 'Visual native form', enabled: true, fields: [{ id: 'ui-full-email', label: 'Email', type: 'email', required: true }], submitLabel: 'Send inquiry', successMessage: 'Synthetic only' }],
    editorData: { ...original.editorData, [homeId]: { root: { props: { title: 'Visual full native page', showChrome: 'no' } }, content: [
      { type: 'Heading', props: { id: 'ui-full-heading', text: 'Original full page heading', level: 'h1' } },
      { type: 'Navigation', props: { id: 'ui-full-navigation', menuId, label: 'Factory native menu', mobileMode: 'collapse' } },
      { type: 'Accordion', props: { id: 'ui-full-accordion', items: [{ id: 'ui-full-packaging', title: 'Packaging options', body: 'Supplied synthetic packaging description.' }] } },
      { type: 'Tabs', props: { id: 'ui-full-tabs', items: [{ id: 'ui-full-overview', title: 'Overview', body: 'First supplied text.' }, { id: 'ui-full-specifications', title: 'Specifications', body: 'Second supplied text.' }] } },
      { type: 'Carousel', props: { id: 'ui-full-carousel', images: [{ id: 'ui-full-slide-one', src: '/images/chair.jpg', alt: 'First supplied chair' }, { id: 'ui-full-slide-two', src: '/images/chair.jpg', alt: 'Second supplied chair' }] } },
      { type: 'Form', props: { id: 'ui-full-form-node', formId } },
      { type: 'ActionButton', props: { id: 'ui-full-bottom-button', text: 'Go to actual bottom', href: '#ui-full-bottom', kind: 'outline', align: 'left' } },
      ...Array.from({ length: 4 }, (_, i) => ({ type: 'Spacer', props: { id: `ui-full-spacer-${i}`, height: 600, line: 'no' } })),
      { type: 'Heading', props: { id: 'ui-full-bottom-heading', anchor: 'ui-full-bottom', text: 'Actual full page bottom', level: 'h2' } },
    ] } },
  };
}
