/* ============================================================================
   Pointing at an image back on the page it came from.

   Extracted for the same reason as scan-limits, declared and image-location: the
   decisions in here are worth testing, and a function buried in a request handler
   cannot be. This one still needs a DOM, so its test drives it through a real page
   rather than in plain Node - but it can be handed to page.evaluate() directly.

   It must stay self-contained. Playwright serialises the function and injects its
   source into the page, so anything it closes over would simply be undefined there.
   ========================================================================== */

/* Finds an image back on the page it came from, and points at it.

   Runs INSIDE the reopened page, so it can do the two things a link never could: search
   the live DOM for whatever now carries this image, and draw on top of the result.

   Three ways of finding it, in descending order of trustworthiness:

     1. By URL. The exact resolved address is known, so whatever element carries it can be
        recognised for certain. This is tried first and is almost always what matches.
     2. By the DOM path recorded during the scan. Approximately a CSS selector already, so
        it is worth a try - but it can match the wrong element on a page whose contents
        have shifted, which is why it is second.
     3. By the position recorded during the scan. Points at coordinates rather than at an
        element, so it is only as good as the page being unchanged - but "roughly here" is
        much better than "not found".

   Element search is split in two passes on purpose. The first looks only where an image
   is normally declared, which is a handful of elements. The second reads computed styles
   to catch CSS backgrounds, which means visiting every element on the page, so it runs
   only when the cheap pass has already failed. */
function revealInPage({ imageUrl, foundIn, top, left, width, height }) {
  const resolve = value => {
    if (!value) return null;
    if (value.startsWith('data:')) return value;
    try { const url = new URL(value, location.href); url.hash = ''; return url.href; } catch { return null; }
  };

  const carriesImage = element => {
    if (!element.getAttribute) return false;
    for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-url']) {
      if (resolve(element.getAttribute(attr)) === imageUrl) return true;
    }
    if (element.currentSrc && resolve(element.currentSrc) === imageUrl) return true;
    const set = element.getAttribute('srcset') || element.getAttribute('data-srcset') || '';
    for (const part of set.split(',')) {
      const first = part.trim().split(/\s+/)[0];
      if (first && resolve(first) === imageUrl) return true;
    }
    const inline = (element.getAttribute('style') || '').match(/url\(\s*['"]?([^)'"]+)/i);
    return !!(inline && resolve(inline[1]) === imageUrl);
  };

  let element = null;
  let how = null;

  for (const candidate of document.querySelectorAll('img, source, [data-src], [data-srcset], [style*="url("]')) {
    if (carriesImage(candidate)) { element = candidate; how = 'url'; break; }
  }
  if (!element) {
    for (const candidate of document.querySelectorAll('*')) {
      const background = getComputedStyle(candidate).backgroundImage || '';
      const match = background.match(/url\(\s*['"]?([^)'"]+)/i);
      if (match && resolve(match[1]) === imageUrl) { element = candidate; how = 'background'; break; }
    }
  }
  if (!element && foundIn) {
    // The recorded path is built for reading, so it is not guaranteed to parse.
    try { element = document.querySelector(foundIn); if (element) how = 'path'; } catch { /* not a selector */ }
  }

  /* A <source>, or a lazy placeholder, genuinely has no box of its own - so measuring it
     gives zeroes and there is nothing to outline. The nearest ancestor that does have a
     box is what a person would point at anyway. */
  let box = null;
  for (let node = element; node && !box; node = node.parentElement) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) {
      box = { top: rect.top + window.scrollY, left: rect.left + window.scrollX, width: rect.width, height: rect.height };
    }
  }
  if (!box && (top || left)) {
    box = { top, left, width: Math.max(width || 0, 32), height: Math.max(height || 0, 32) };
    how = 'position';
  }
  if (!box) return { how: 'none' };

  // Any previous highlight belongs to a previous reveal.
  document.querySelectorAll('[data-pic-reveal]').forEach(node => node.remove());

  const style = document.createElement('style');
  style.setAttribute('data-pic-reveal', '');
  /* The second, enormous shadow is a spotlight: an inset-free spread of 9999px dims the
     whole rest of the page in one property, with no full-screen overlay element to get
     the stacking or the scrolling wrong. */
  style.textContent = '@keyframes picReveal{'
    + '0%,100%{box-shadow:0 0 0 3px rgba(61,220,132,.95),0 0 0 9999px rgba(5,7,9,.55)}'
    + '50%{box-shadow:0 0 0 8px rgba(125,255,176,.95),0 0 0 9999px rgba(5,7,9,.55)}}';
  document.documentElement.appendChild(style);

  const marker = document.createElement('div');
  marker.setAttribute('data-pic-reveal', '');
  marker.style.cssText = 'position:absolute;pointer-events:none;border-radius:4px;'
    + 'z-index:2147483647;animation:picReveal 1.5s ease-in-out infinite;'
    + `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;`;

  const label = document.createElement('div');
  label.setAttribute('data-pic-reveal', '');
  label.textContent = how === 'position' ? 'Around here' : 'This image';
  label.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;'
    + 'font:600 12px/1 system-ui,sans-serif;color:#04140b;background:#3ddc84;'
    + 'padding:5px 9px;border-radius:999px;white-space:nowrap;'
    // Above the box, unless that would be off the top of the page.
    + `left:${box.left}px;top:${Math.max(0, box.top - 26)}px;`;

  document.body.appendChild(marker);
  document.body.appendChild(label);

  const centre = Math.max(0, box.top + box.height / 2 - window.innerHeight / 2);
  window.scrollTo({ top: centre, left: 0, behavior: 'smooth' });

  return { how, top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
}

module.exports = { revealInPage };
