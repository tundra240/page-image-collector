const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLimit, MAX_IMAGE_LIMIT, DEFAULT_IMAGE_LIMIT } = require('../lib/scan-limits.js');

test('a valid explicit cap is used as given', () => {
  assert.equal(resolveLimit({ limit: 100 }).limit, 100);
  assert.equal(resolveLimit({ limit: 1 }).limit, 1);
  assert.equal(resolveLimit({ limit: MAX_IMAGE_LIMIT }).limit, MAX_IMAGE_LIMIT);
});

test('nonsense or out-of-range caps fall back to the default', () => {
  for (const limit of [0, -5, 1.5, MAX_IMAGE_LIMIT + 1, 'abc', null, undefined, NaN, {}]) {
    assert.equal(resolveLimit({ limit }).limit, DEFAULT_IMAGE_LIMIT,
      `${JSON.stringify(limit)} should fall back`);
  }
});

test('auto cap runs to the hard backstop, so nothing is cut off', () => {
  // Auto cap cannot know the real total up front, so it must not impose a small
  // limit early and silently drop images the page reveals later.
  const auto = resolveLimit({ autoCap: true });
  assert.equal(auto.limit, MAX_IMAGE_LIMIT);
  assert.equal(auto.autoCap, true);
});

test('auto cap overrides any number sent alongside it', () => {
  const auto = resolveLimit({ autoCap: true, limit: 10 });
  assert.equal(auto.limit, MAX_IMAGE_LIMIT);
  assert.equal(auto.autoCap, true);
});

test('autoCap is only honoured when it is genuinely true', () => {
  // Guards against a truthy string from a hand-made request switching it on.
  for (const value of ['false', 'no', 0, '', null, undefined]) {
    assert.equal(resolveLimit({ autoCap: value, limit: 50 }).autoCap, false,
      `${JSON.stringify(value)} must not enable auto cap`);
    assert.equal(resolveLimit({ autoCap: value, limit: 50 }).limit, 50);
  }
});

test('the reported denominator tracks what has been detected', () => {
  const { reportedLimit } = require('../lib/scan-limits.js');
  // Fixed cap: the denominator is the cap itself.
  assert.equal(reportedLimit({ autoCap: false, limit: 500, detected: 0 }), 500);
  assert.equal(reportedLimit({ autoCap: false, limit: 500, detected: 900 }), 500);
  // Auto cap: the denominator is what has been spotted so far, never below what
  // is already captured, and null while nothing is known yet.
  assert.equal(reportedLimit({ autoCap: true, limit: 5000, detected: 0 }), null);
  assert.equal(reportedLimit({ autoCap: true, limit: 5000, detected: 142 }), 142);
  assert.equal(reportedLimit({ autoCap: true, limit: 5000, detected: 10, captured: 25 }), 25);
});
