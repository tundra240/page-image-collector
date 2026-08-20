/* ============================================================================
   Progress bar easing.

   The bar's width is painted every animation frame, but the server only reports
   a new percentage a few times a second. Something has to fill the gap, and
   getting that wrong is what makes a loading bar feel choppy.

   These tests pin down four properties. Frame-rate independence is the one that
   matters most: the original code moved a fixed fraction of the gap per *frame*,
   so the bar animated 2.4x faster on a 144Hz display than on a 60Hz one.
   ========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const { advance, CREEP_ROOM } = require('../public/progress.js');

/**
 * Runs `advance` repeatedly at a fixed frame interval and returns where it ends up.
 *
 * The elapsed time must come out at exactly `totalMs`, hence the trailing partial
 * frame. Stepping in whole frames and stopping once past the total instead means a
 * 30fps run simulates 533ms against a 60fps run's 500ms - and then the extra
 * distance it covers looks exactly like the frame-rate bug these tests exist to
 * catch. It cost me a wrong diagnosis once already.
 */
function simulate({ shown = 0, target, frameMs, totalMs }) {
  let value = shown;
  let elapsed = 0;
  while (elapsed < totalMs) {
    const step = Math.min(frameMs, totalMs - elapsed);
    value = advance(value, target, step);
    elapsed += step;
  }
  return value;
}

test('the same elapsed time travels the same distance at any frame rate', () => {
  // The original bug: 0.09 of the gap per frame means a fast display closes the
  // gap far sooner. Easing on elapsed time removes the dependence entirely.
  const at60 = simulate({ target: 80, frameMs: 1000 / 60, totalMs: 500 });
  const at144 = simulate({ target: 80, frameMs: 1000 / 144, totalMs: 500 });
  const at30 = simulate({ target: 80, frameMs: 1000 / 30, totalMs: 500 });

  assert.ok(Math.abs(at60 - at144) < 1, `60Hz reached ${at60}, 144Hz reached ${at144}`);
  assert.ok(Math.abs(at60 - at30) < 1, `60Hz reached ${at60}, 30Hz reached ${at30}`);
});

test('never moves backwards, even when the target drops', () => {
  // A page that grows while being scrolled can genuinely report a lower
  // percentage than before. A bar that retreats reads as broken.
  let value = 60;
  for (const target of [60, 55, 40, 58, 20]) {
    const next = advance(value, target, 16);
    assert.ok(next >= value, `${value} -> ${next} with target ${target}`);
    value = next;
  }
});

test('creeps forward while the target is unchanged, but only a little', () => {
  // Long stalls are unavoidable: fixed waits, slow networks. A stationary bar
  // reads as frozen, so it drifts - bounded, so it never lies by much.
  const target = 50;
  const afterOneSecond = simulate({ shown: target, target, frameMs: 16, totalMs: 1000 });
  assert.ok(afterOneSecond > target, 'should have moved off the target');

  const afterAnAge = simulate({ shown: target, target, frameMs: 16, totalMs: 60_000 });
  assert.ok(afterAnAge <= target + CREEP_ROOM + 0.001,
    `crept to ${afterAnAge}, which is more than ${CREEP_ROOM}% ahead of ${target}`);
});

test('creep never reaches 100% on its own', () => {
  // 100% has to mean finished. If creep could get there the bar would sit full
  // while the scan was still running.
  const value = simulate({ shown: 99, target: 99, frameMs: 16, totalMs: 120_000 });
  assert.ok(value < 100, `crept all the way to ${value}`);
});

test('completion arrives promptly rather than gliding in', () => {
  // The front end hides the bar shortly after a scan finishes. If the easing is
  // still halfway there when it disappears, the scan looks unfinished.
  const value = simulate({ shown: 40, target: 100, frameMs: 16, totalMs: 400 });
  assert.ok(value > 99.5, `only reached ${value} in 400ms`);
});

test('a long gap between frames does not leap the bar forward', () => {
  // rAF stops in a hidden tab. Coming back, the elapsed time can be many
  // seconds, and easing on it unclamped would jump the bar in one frame.
  const oneFrame = advance(0, 80, 30_000);
  assert.ok(oneFrame < 40, `a single 30s frame moved the bar to ${oneFrame}`);
});

test('stays within 0-100 for nonsense input', () => {
  for (const [shown, target] of [[0, 500], [0, -20], [0, NaN], [-5, 50]]) {
    const value = advance(shown, target, 16);
    assert.ok(value >= 0 && value <= 100, `advance(${shown}, ${target}) gave ${value}`);
    assert.ok(Number.isFinite(value), `advance(${shown}, ${target}) gave ${value}`);
  }
});
