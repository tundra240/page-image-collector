/* ============================================================================
   Where an image sits on the page.

   The scan sweep is the only moment this knowledge exists: it walks the live
   DOM, so it can see which element declared each source and where that element
   was laid out. Once the browser closes the page is gone, and the question can
   no longer be answered. So the sweep measures, and this module turns the raw
   measurements into the shape the UI reports.

   Kept out of the request handler for the same reason as scan-limits: the
   decisions here can then be tested without starting a server or a browser.
   ========================================================================== */

/** Nothing on the page declared this image, so there is no element to point at. */
const NETWORK_ONLY = { via: 'network traffic', foundIn: null, position: null, displayedSize: null };

/**
 * Describes one image's place in the page.
 *
 * @param {object|null|undefined} measured Raw sweep output for this source, or nothing
 *   if the image only ever appeared as network traffic.
 * @param {number} pageHeight Full scroll height of the document, used to express the
 *   vertical position as a share of the page rather than a bare pixel count.
 */
function describeLocation(measured, pageHeight) {
  // Images captured purely from network traffic — CSS backgrounds fetched by the
  // browser, or sources a script requested — have no element on the page at all.
  // Saying so plainly beats inventing a location for them.
  if (!measured) return NETWORK_ONLY;

  const top = Number(measured.top) || 0;
  const usableHeight = Number(pageHeight) > 0 ? Number(pageHeight) : 0;
  // Clamped because an element positioned past the measured height would otherwise
  // report "112% down the page", which reads as a bug rather than a quirk of layout.
  const share = usableHeight ? Math.min(100, Math.max(0, Math.round((top / usableHeight) * 100))) : null;

  return {
    via: 'page HTML',
    foundIn: measured.foundIn || null,
    position: { top, left: Number(measured.left) || 0, downThePage: share === null ? null : `${share}%` },
    // Zero is a truthful answer here: lazy placeholders and <source> elements are
    // genuinely not rendered, and reporting that is better than hiding it.
    displayedSize: { width: Number(measured.width) || 0, height: Number(measured.height) || 0 }
  };
}

module.exports = { describeLocation, NETWORK_ONLY };
