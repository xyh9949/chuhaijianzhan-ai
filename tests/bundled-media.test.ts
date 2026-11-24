import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_IMAGES, bundledImage, bundledImageReferences, isLocalImagePath } from '../src/lib/bundled-media';
import { isContentImage } from '../src/lib/content-models';
import { validateDesign } from '../src/lib/responsive-style';
import { richTextErrors, presentationErrors } from '../src/lib/presentation-content';
import { collectReferences, isSafeImage, validateDraft } from '../src/server/validation';
import { createEmptyDraft } from '../src/server/seed';
import { imageAttributes } from '../src/lib/media-images';

test('内置图清单只扩展明确的两张PNG，各保存入口不接受其他静态路径或远程地址', () => {
  assert.equal(BUNDLED_IMAGES.length, 6);
  for (const { url, mime } of BUNDLED_IMAGES) {
    assert.ok(isLocalImagePath(url)); assert.ok(isContentImage(url)); assert.ok(isSafeImage(url));
    assert.equal(bundledImage(url)?.mime, url.endsWith('.png') ? 'image/png' : 'image/jpeg');
    assert.ok(mime.startsWith('image/'));
    assert.deepEqual(validateDesign({ desktop: { backgroundImage: url } }), []);
    assert.deepEqual(richTextErrors({ type: 'doc', content: [{ type: 'image', attrs: { src: url, alt: '', caption: '', width: 100, align: 'center' } }] }), []);
    assert.deepEqual(presentationErrors('Gallery', { images: [{ id: 'image', src: url, alt: '' }], ratio: '4/3', fit: 'cover', lightbox: true }, true), []);
    const draft = createEmptyDraft();
    draft.media = [{ id: 'image', name: url.split('/').pop()!, url, kind: 'image', folder: '', size: '', alt: '' }];
    assert.doesNotThrow(() => validateDraft(draft));
  }
  for (const url of ['/images/other.png', '/images/showcase-factory.jpg', '/images/showcase-components.svg', '/images/../images/showcase-factory.png', '/images/%73howcase-factory.png', '/images/showcase-factory.png?x=1', 'https://example.com/images/showcase-factory.png', '//example.com/images/chair.jpg', '/admin/logo.png']) {
    assert.equal(isLocalImagePath(url), false, url); assert.equal(isContentImage(url), false, url); assert.equal(isSafeImage(url), false, url);
    assert.ok(validateDesign({ desktop: { backgroundImage: url } }).length, url);
  }
  assert.equal(imageAttributes('/images/chair.jpg').height, 1201);
  assert.ok(isLocalImagePath('/api/media/upload-id'));
});

test('新旧静态图的正文、背景和关闭中CSS引用均进入发布与分发依赖', () => {
  const draft = createEmptyDraft();
  draft.editorData.home = { root: { props: {} }, content: [{ type: 'Image', props: { id: 'image', src: '/images/showcase-components.png', alt: '' } }, { type: 'RichText', props: { id: 'article', doc: { type: 'doc', content: [{ type: 'image', attrs: { src: '/images/chair.jpg', alt: '', caption: '', width: 100, align: 'center' } }] } } }] };
  draft.customCode = { global: { css: 'body{background:url("/images/showcase-factory.png")}p{background:url(/images/studio.jpg)}', js: '', cssEnabled: false, jsEnabled: false }, pages: {} };
  assert.deepEqual([...collectReferences(draft).urls].sort(), ['/images/chair.jpg', '/images/showcase-components.png', '/images/showcase-factory.png', '/images/studio.jpg']);
  assert.deepEqual(bundledImageReferences('url(/images/showcase-factory.png.evil) url(/images/other.png)'), []);
});
