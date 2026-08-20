/* ============================================================================
   Scan limit rules.

   Pulled out of the request handler so the decisions can be tested without
   starting a server. The interesting part is auto cap: the number of images on a
   page is not knowable before the scan, because lazy-loaded images only exist
   once they have been scrolled into view. So auto cap does not try to guess a
   total up front — it runs to the hard backstop and reports what it finds as it
   goes.
   ========================================================================== */

const DEFAULT_IMAGE_LIMIT = 500;
const MAX_IMAGE_LIMIT = 5_000;

/**
 * Decides the cap for a scan request.
 * @param {{ limit?: unknown, autoCap?: unknown }} body
 * @returns {{ limit: number, autoCap: boolean }}
 */
function resolveLimit(body = {}) {
  // Strictly true only: a hand-made request sending "false" must not switch it on.
  const autoCap = body.autoCap === true;
  if (autoCap) return { limit: MAX_IMAGE_LIMIT, autoCap: true };

  const requested = Number(body.limit);
  const valid = Number.isInteger(requested) && requested >= 1 && requested <= MAX_IMAGE_LIMIT;
  return { limit: valid ? requested : DEFAULT_IMAGE_LIMIT, autoCap: false };
}

/**
 * The denominator to show in the progress line — "12 of 142 images".
 *
 * With a fixed cap that is simply the cap. With auto cap there is nothing
 * meaningful to show until the page has been inspected, so this returns null and
 * the caller words it differently. It can never fall below the number already
 * captured, because a progress bar reading "25 of 10" is worse than no number.
 */
function reportedLimit({ autoCap, limit, detected = 0, captured = 0 }) {
  if (!autoCap) return limit;
  if (!detected) return null;
  return Math.min(Math.max(detected, captured), MAX_IMAGE_LIMIT);
}

module.exports = { resolveLimit, reportedLimit, DEFAULT_IMAGE_LIMIT, MAX_IMAGE_LIMIT };
