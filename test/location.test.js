const test = require('node:test');
const assert = require('node:assert/strict');
const { describeLocation, NETWORK_ONLY } = require('../lib/image-location.js');

const MEASURED = { foundIn: 'main > section.gallery > img:nth-of-type(3)', top: 1240, left: 320, width: 800, height: 450 };

test('a measured image reports where it sits on the page', () => {
  const location = describeLocation(MEASURED, 3260);
  assert.equal(location.via, 'page HTML');
  assert.equal(location.foundIn, MEASURED.foundIn);
  assert.equal(location.position.top, 1240);
  assert.equal(location.position.left, 320);
  assert.equal(location.position.downThePage, '38%');
  assert.deepEqual(location.displayedSize, { width: 800, height: 450 });
});

test('an image seen only as network traffic says so rather than inventing a place', () => {
  // CSS backgrounds the browser fetched, and sources a script requested, have no
  // element on the page. Reporting a made-up location would be worse than none.
  for (const missing of [null, undefined]) {
    assert.deepEqual(describeLocation(missing, 3260), NETWORK_ONLY);
    assert.equal(describeLocation(missing, 3260).foundIn, null);
  }
});

test('the share of the page is clamped, so no image is ever "112% down"', () => {
  // An element laid out past the measured scroll height is a real thing that happens
  // with fixed or transformed positioning; it should not read as a broken number.
  assert.equal(describeLocation({ ...MEASURED, top: 9999 }, 3260).position.downThePage, '100%');
  assert.equal(describeLocation({ ...MEASURED, top: -500 }, 3260).position.downThePage, '0%');
});

test('an unmeasurable page height yields no share rather than a division by zero', () => {
  for (const height of [0, undefined, NaN, -1]) {
    const location = describeLocation(MEASURED, height);
    assert.equal(location.position.downThePage, null, `height ${height} should give no share`);
    // The pixel position is still known and still worth reporting.
    assert.equal(location.position.top, 1240);
  }
});

test('missing measurements degrade to zero rather than NaN or undefined', () => {
  // Lazy placeholders and <source> elements are genuinely not rendered, so a zero
  // size is the truth. What must not happen is NaN reaching the UI.
  const location = describeLocation({ foundIn: 'div' }, 1000);
  assert.deepEqual(location.displayedSize, { width: 0, height: 0 });
  assert.equal(location.position.top, 0);
  assert.equal(location.position.downThePage, '0%');
});

test('every value the UI prints survives a JSON round trip', () => {
  // The {} panel stringifies this straight into the card, so anything that cannot
  // be serialised cleanly would surface there as a hole.
  for (const measured of [MEASURED, null]) {
    const location = describeLocation(measured, 3260);
    assert.deepEqual(JSON.parse(JSON.stringify(location)), location);
  }
});
