/* ============================================================================
   Turning declared image references into a candidate list.

   The DOM sweep collects raw attribute values, and the same image usually appears
   several times in different spellings. A loaded <img> exposes both `src`
   ("/a.png") and `currentSrc` ("http://site/a.png"): two strings, one image. A
   srcset repeats the same file at several widths. Counting raw strings therefore
   overstates how many images a page has — which is exactly what made the auto cap
   denominator higher than the number of images actually downloaded.

   Resolving every value against the page URL and deduplicating fixes that. The
   result is still an upper bound: whether a URL returns an image cannot be known
   until it has been fetched. Hence "candidates".
   ========================================================================== */

// Schemes that can never yield bytes we can save. blob: URLs are created and
// revoked by the page itself, so by the time the sweep ran they are usually dead.
const UNFETCHABLE = /^(about|javascript|mailto|tel|blob|file|ws|wss):/i;

/**
 * @param {Array<unknown>} values raw attribute values collected from the DOM
 * @param {string} base the page URL, used to resolve relative references
 * @returns {string[]} unique candidate URLs, in first-seen order
 */
function uniqueCandidates(values, base) {
  const seen = new Set();
  const candidates = [];

  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    const raw = value.trim();
    if (!raw) continue;

    // data: URLs carry their bytes inline; there is nothing to resolve, and only
    // image payloads are of any use.
    if (raw.startsWith('data:')) {
      if (!/^data:image\//i.test(raw)) continue;
      if (!seen.has(raw)) { seen.add(raw); candidates.push(raw); }
      continue;
    }

    if (UNFETCHABLE.test(raw)) continue;

    let resolved;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(resolved.protocol)) continue;

    // A fragment is never sent to the server, so #top and no fragment fetch the
    // same bytes and must not count twice. A query string genuinely can differ.
    resolved.hash = '';
    const key = resolved.href;
    if (!seen.has(key)) { seen.add(key); candidates.push(key); }
  }

  return candidates;
}

module.exports = { uniqueCandidates };
