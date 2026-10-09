'use strict';

// Track local navigation image readiness; artwork lives in the original buttons.
// Keeping those nodes preserves entry IDs, badges, event wiring and community strips.
function installNavigationArtwork(doc = globalThis.document) {
  if (!doc?.querySelectorAll) return;
  const images = [...doc.querySelectorAll('#scene-rail img')];
  const ready = () => doc.documentElement.classList.toggle('navigation-artwork-ready',
    images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0));
  for (const image of images) {
    image.addEventListener('load', ready, { once: true });
    image.addEventListener('error', ready, { once: true });
  }
  ready();
}
module.exports = { installNavigationArtwork };
