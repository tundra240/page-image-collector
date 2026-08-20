/* ============================================================================
   Progress bar easing.

   The server reports a percentage a few times a second; the bar is painted every
   animation frame, sixty or more times a second. This module decides where the
   bar should be on any given frame, and it is the whole of the answer to why a
   loading bar feels smooth or choppy.

   Three ideas, in order of how much they matter:

   1. Ease on ELAPSED TIME, not per frame. The obvious version - "move a tenth of
      the remaining gap each frame" - secretly depends on the display's refresh
      rate, so the bar animates 2.4x faster on a 144Hz monitor than a 60Hz one,
      and every dropped frame becomes a visible hitch. Easing on elapsed time
      makes the motion identical everywhere.

   2. Never move backwards. A page that grows while being scrolled can honestly
      report a lower percentage than it did a moment ago, but a bar that retreats
      reads as a bug.

   3. Creep during stalls. Some  waits are unavoidable, and a stationary bar looks
      frozen. So the bar drifts forward when there is no news - but by at most
      CREEP_ROOM percent, because this is the one part of the module that shows
      motion not backed by real progress, and it should never be able to lie by
      more than a few pixels.

   Loaded by the browser as a <script> tag (window.APP_PROGRESS) and by the tests
   through require(), the same dual-mode trick errors.js uses.
   ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.APP_PROGRESS = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /* Each of these is a time constant: the number of milliseconds in which the
     remaining gap shrinks to about 37% of its size. Smaller means snappier. */

  // Catching up to a newly reported percentage. Tuned a little under the poll
  // interval so the bar is usually still gliding when the next figure arrives,
  // rather than arriving early and parking.
  const CATCH_UP_MS = 260;

  // Reaching 100%. Much faster, because the front end hides the bar shortly
  // after a scan ends and a half-finished bar makes a finished scan look broken.
  const FINISH_MS = 70;

  // The creep. An order of magnitude slower than catching up, so real progress
  // always visibly overtakes it.
  const CREEP_MS = 2400;

  /** How far ahead of the reported percentage the creep may run. */
  const CREEP_ROOM = 2;

  /** The creep stops here. 100% has to mean finished, so it must never creep there. */
  const CREEP_CEILING = 99.4;

  // requestAnimationFrame stops in a hidden tab, so returning to one can report
  // many seconds of elapsed time. Easing on that unclamped would jump the bar
  // across the screen in a single frame. This is above any real frame interval
  // (30fps is 33ms), so it only ever bites after a genuine gap.
  const MAX_STEP_MS = 100;

  // Below this the remaining distance is under a tenth of a pixel on any sane bar
  // width, so settling exactly avoids easing forever toward an asymptote.
  const SNAP = 0.05;

  /** Fraction of a remaining gap to close over `dt` ms with the given time constant. */
  function ease(dt, timeConstant) {
    return 1 - Math.exp(-dt / timeConstant);
  }

  /**
   * Where the bar should be on this frame.
   *
   * @param {number} shown the width currently painted, as a percentage
   * @param {number} target the percentage last reported by the server
   * @param {number} dtMs milliseconds since the previous frame
   * @returns {number} the width to paint, between 0 and 100
   */
  function advance(shown, target, dtMs) {
    const dt = Math.min(Math.max(Number(dtMs) || 0, 0), MAX_STEP_MS);

    const reported = Number(target);
    const to = Number.isFinite(reported) ? Math.min(Math.max(reported, 0), 100) : 0;

    const from = Number.isFinite(Number(shown)) ? Math.max(Number(shown), 0) : 0;
    let next = Math.min(from, 100);

    const finished = to >= 100;

    // The bar always heads for a point slightly past the reported figure. What
    // changes is the speed: brisk while it is still behind real progress, an
    // order of magnitude slower once it is out in front and merely creeping.
    //
    // This is deliberately ONE eased step rather than a catch-up plus a separate
    // creep. Each exponential is exact on its own, but applying two in sequence
    // within a frame is not - the creep would act on the value the catch-up had
    // already moved, so fewer, larger frames drifted ahead of many small ones,
    // and the frame-rate independence this whole module exists for was lost.
    const goal = finished ? 100 : Math.min(to + CREEP_ROOM, CREEP_CEILING);
    const rate = finished ? FINISH_MS : (next < to ? CATCH_UP_MS : CREEP_MS);

    // Guarded, so a target that has fallen behind leaves the bar exactly where it
    // is instead of pulling it back. This is what makes the result monotonic.
    if (goal > next) {
      next += (goal - next) * ease(dt, rate);
      // Settle rather than easing forever toward an asymptote. Guarded the same
      // way: an unguarded snap reads as true when `next` is already past `goal`,
      // and would jump the bar backwards onto it.
      if (goal - next < SNAP) next = goal;
    }

    return Math.min(next, 100);
  }

  return { advance, CATCH_UP_MS, FINISH_MS, CREEP_MS, CREEP_ROOM, CREEP_CEILING, MAX_STEP_MS };
});
