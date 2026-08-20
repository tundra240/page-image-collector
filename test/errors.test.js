const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const catalogue = require('../public/errors.js');
const { ERRORS, lookup, repairUrl, isRetryable } = catalogue;

test('every entry is complete and self-consistent', () => {
  for (const [key, entry] of Object.entries(ERRORS)) {
    assert.equal(entry.code, key, `${key}: code must match its key`);
    for (const field of ['message', 'meaning', 'fix', 'where']) {
      assert.ok(entry[field] && entry[field].length > 0, `${key}: missing ${field}`);
    }
    assert.ok(['server', 'browser', 'startup', 'launcher', 'build'].includes(entry.where),
      `${key}: 'where' must be a known area, got ${entry.where}`);
    if ('http' in entry) {
      assert.ok(entry.http >= 400 && entry.http <= 599, `${key}: http must be a 4xx/5xx status`);
    }
    assert.equal(typeof entry.selfHeal, 'string', `${key}: selfHeal must be a string ('none' when not applicable)`);
  }
});

test('lookup finds known codes and degrades safely for unknown ones', () => {
  assert.equal(lookup('SCAN_IN_PROGRESS').code, 'SCAN_IN_PROGRESS');
  const unknown = lookup('NOT_A_REAL_CODE');
  assert.equal(unknown.code, 'UNKNOWN');
  assert.ok(unknown.fix.length > 0, 'the fallback must still offer advice');
  assert.equal(lookup(undefined).code, 'UNKNOWN');
});

test('repairUrl fixes the mistake people actually make', () => {
  // A bare domain is the common case: the app requires a scheme, humans omit it.
  assert.equal(repairUrl('example.com'), 'https://example.com/');
  assert.equal(repairUrl('  www.example.com/gallery  '), 'https://www.example.com/gallery');
  // Already valid input must be returned untouched in substance.
  assert.equal(repairUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(repairUrl('http://example.com/a'), 'http://example.com/a');
  // Local addresses are almost never served over TLS, so guessing https for them
  // produces a connection refused instead of a working scan.
  assert.equal(repairUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(repairUrl('127.0.0.1:8124'), 'http://127.0.0.1:8124/');
  assert.equal(repairUrl('127.0.0.1:8124/page'), 'http://127.0.0.1:8124/page');
  assert.equal(repairUrl('192.168.1.10:8080'), 'http://192.168.1.10:8080/');
  assert.equal(repairUrl('printer.local'), 'http://printer.local/');
  // An explicit scheme is always respected, even for a local address.
  assert.equal(repairUrl('https://localhost:3000/'), 'https://localhost:3000/');

  // Things that cannot be repaired must fail rather than be guessed at.
  assert.equal(repairUrl('ftp://example.com'), null);
  assert.equal(repairUrl('not a url at all'), null);
  assert.equal(repairUrl(''), null);
  assert.equal(repairUrl('http://'), null);
});

test('repairUrl tolerates a mistyped scheme', () => {
  // Hand-typing "https://" goes wrong in predictable ways. None of these should
  // force a retype: the intent is unmistakable in every case.
  assert.equal(repairUrl('https:/example.com'), 'https://example.com/');   // one slash
  assert.equal(repairUrl('http:/example.com'), 'http://example.com/');     // one slash
  assert.equal(repairUrl('https//example.com'), 'https://example.com/');   // no colon
  assert.equal(repairUrl('https:example.com'), 'https://example.com/');    // no slashes
  assert.equal(repairUrl('htps://example.com'), 'https://example.com/');   // dropped t
  assert.equal(repairUrl('htp://example.com'), 'http://example.com/');     // dropped t
  assert.equal(repairUrl('://example.com'), 'https://example.com/');       // no scheme text
  assert.equal(repairUrl('//example.com'), 'https://example.com/');        // protocol-relative

  // http stays http and https stays https - the typo is repaired, the stated intent
  // is not overridden.
  assert.equal(repairUrl('http:/localhost:3000'), 'http://localhost:3000/');
  assert.equal(repairUrl('https:/localhost:3000'), 'https://localhost:3000/');

  // A path must survive the repair.
  assert.equal(repairUrl('https:/example.com/a/b?c=1'), 'https://example.com/a/b?c=1');

  // The tolerance is a short explicit list, not a fuzzy match, because guessing at
  // schemes is how you end up quietly accepting javascript: or file:.
  assert.equal(repairUrl('javascript:alert(1)'), null);
  assert.equal(repairUrl('ftp:/example.com'), null);
  assert.equal(repairUrl('file:///etc/passwd'), null);
  // Nothing after the scheme is still nothing.
  assert.equal(repairUrl('https:/'), null);
  assert.equal(repairUrl('https://'), null);
  // A hostname that merely starts like a scheme is left alone, not mangled.
  assert.equal(repairUrl('http.com'), 'https://http.com/');
  assert.equal(repairUrl('httpsite.com'), 'https://httpsite.com/');
});

test('a response with no code is recognised as a version mismatch, not as UNKNOWN', () => {
  /* This is the bug behind a real report of "Something went wrong" on a button that had
     just been added.

     Static files are read from disk on every request, so a running app serves the CURRENT
     index.html and app.js. Its ROUTES, though, were fixed when the process started. An app
     left running across an update therefore hands the browser a front end that calls an
     endpoint the server has never heard of - and Express answers "Cannot POST /api/..." as
     an HTML page, with no code in it.

     Falling back to UNKNOWN there was the worst possible answer: "Something went wrong",
     no advice, for a situation fixed completely by restarting the app. The front end can
     tell, though - a response with no code did not come from this app's fail(), so the
     thing that answered is not the server this page expects. */
  const { responseCode } = catalogue;

  // A properly coded failure is passed through untouched.
  assert.equal(responseCode({ code: 'PAGE_TIMEOUT', error: 'x' }), 'PAGE_TIMEOUT');
  assert.equal(responseCode({ code: 'IMAGE_EXPIRED' }), 'IMAGE_EXPIRED');

  // Anything without one means the answer did not come from a handler that knows us.
  assert.equal(responseCode({}), 'SERVER_OUTDATED');
  assert.equal(responseCode(null), 'SERVER_OUTDATED');
  assert.equal(responseCode(undefined), 'SERVER_OUTDATED');
  // What a non-JSON body degrades to once parsing has failed.
  assert.equal(responseCode({ error: 'Cannot POST /api/reveal' }), 'SERVER_OUTDATED');
  // A code that is present but useless is no code at all.
  assert.equal(responseCode({ code: '' }), 'SERVER_OUTDATED');
  assert.equal(responseCode({ code: 42 }), 'SERVER_OUTDATED');

  // And it must be a real catalogue entry with advice attached.
  const entry = lookup('SERVER_OUTDATED');
  assert.equal(entry.code, 'SERVER_OUTDATED');
  assert.ok(/restart/i.test(entry.fix), 'the fix should say to restart the app');
});

test('the port-clash advice works on the platform the app is shipped for', () => {
  /* This is the message somebody sees when the packaged .exe will not start, and it is
     the commonest reason it will not: an earlier copy still holding the port.

     It used to offer only `ss -ltnp | grep 3719` and `pkill`, which are Linux commands.
     The single-file executable is built FOR Windows, where neither exists - so the one
     error most likely to greet a Windows user came with advice they could not follow. */
  const fix = lookup('PORT_IN_USE').fix;
  assert.match(fix, /Get-NetTCPConnection|taskkill|PowerShell/,
    'PORT_IN_USE must tell a Windows user how to find the process holding the port');
  assert.match(fix, /ss -ltnp|lsof|kill/,
    'and must keep the Unix instructions, since the app runs there too');
});

test('isRetryable marks only the errors worth retrying automatically', () => {
  assert.equal(isRetryable('SCAN_IN_PROGRESS'), true);
  assert.equal(isRetryable('INVALID_URL'), false);
  assert.equal(isRetryable('NO_BROWSER'), false);
  assert.equal(isRetryable('NOT_A_REAL_CODE'), false);
});

test('every code the server reports exists in the catalogue', () => {
  // Rewritten: the previous version asserted that server.js contained particular string
  // literals, which coupled it to how the code was written rather than what it does. It
  // broke the moment those literals were replaced by fail(res, 'CODE') — a passing test
  // failing while the app improved. This asserts the contract instead.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const codes = [...server.matchAll(/fail\(res, '([A-Z_]+)'/g)].map(m => m[1]);
  assert.ok(codes.length >= 5, `expected several fail() calls, found ${codes.length}`);
  for (const code of codes) {
    assert.ok(code in ERRORS, `server.js reports an undocumented code: ${code}`);
  }
});

test('the server routes every failure through fail(), not raw strings', () => {
  // A raw error string would reach the front end with no code attached, and nothing
  // could recognise it. This keeps that from creeping back in.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const raw = [...server.matchAll(/\{\s*error:\s*'[^']+'/g)].map(m => m[0]);
  assert.deepEqual(raw, [], `found error responses bypassing fail(): ${raw.join(', ')}`);
});

test('ERRORS.md documents every code in the catalogue', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'ERRORS.md'), 'utf8');
  for (const code of Object.keys(ERRORS)) {
    if (code === 'UNKNOWN') continue;
    assert.ok(md.includes(code), `ERRORS.md is missing ${code}`);
  }
});
