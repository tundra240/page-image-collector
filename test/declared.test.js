const test = require('node:test');
const assert = require('node:assert/strict');
const { uniqueCandidates } = require('../lib/declared.js');

const BASE = 'http://example.com/gallery/index.html';

test('the same image in relative and absolute form counts once', () => {
  // This is the actual overcounting bug: a loaded <img> exposes both src ("/a.png")
  // and currentSrc ("http://example.com/a.png"). Two strings, one image.
  const found = uniqueCandidates(['/a.png', 'http://example.com/a.png'], BASE);
  assert.deepEqual(found, ['http://example.com/a.png']);
});

test('relative forms all resolve against the page URL', () => {
  const found = uniqueCandidates(['b.png', './b.png', '../gallery/b.png'], BASE);
  assert.equal(found.length, 1);
  assert.equal(found[0], 'http://example.com/gallery/b.png');
});

test('genuinely different images are all kept, in first-seen order', () => {
  const found = uniqueCandidates(['/one.png', '/two.jpg', '/one.png', '/three.webp'], BASE);
  assert.deepEqual(found, [
    'http://example.com/one.png',
    'http://example.com/two.jpg',
    'http://example.com/three.webp'
  ]);
});

test('a query string makes a genuinely different resource', () => {
  const found = uniqueCandidates(['/a.png', '/a.png?w=200'], BASE);
  assert.equal(found.length, 2);
});

test('a fragment does not', () => {
  // #foo is never sent to the server, so both fetch the same bytes.
  const found = uniqueCandidates(['/a.png', '/a.png#top'], BASE);
  assert.equal(found.length, 1);
});

test('data URLs are kept verbatim and deduplicated', () => {
  const one = 'data:image/png;base64,AAAA';
  assert.deepEqual(uniqueCandidates([one, one], BASE), [one]);
});

test('things that can never be a fetchable image are dropped', () => {
  const junk = [
    '', '   ', null, undefined,
    'about:blank',
    'javascript:void(0)',
    'data:text/html,<b>hi</b>',        // a data URL, but not an image
    'blob:http://example.com/abc'       // revoked by the time we would fetch it
  ];
  assert.deepEqual(uniqueCandidates(junk, BASE), []);
});

test('a filename containing spaces is a real candidate, not junk', () => {
  // This assertion originally sat in the junk list above, which was a mistake in the
  // test rather than the code: "my photo.jpg" is a perfectly ordinary filename and
  // resolves to a fetchable URL with the spaces percent-encoded. Dropping it would
  // lose real images from real pages.
  assert.deepEqual(
    uniqueCandidates(['my photo.jpg'], BASE),
    ['http://example.com/gallery/my%20photo.jpg']
  );
});

test('the count is an upper bound, and says so by being a candidate list', () => {
  // A candidate is something worth trying, not something guaranteed to be an image.
  // 404s and non-image responses are only knowable after fetching.
  const found = uniqueCandidates(['/real.png', '/missing.png', '/page.html'], BASE);
  assert.equal(found.length, 3);
});
