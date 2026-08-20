const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { ERRORS } = require('../public/errors.js');

const PORT = 37190;
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');

let child;

function start() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT), PIC_NO_OPEN: '1' }
    });
    let out = '';
    const onData = d => {
      out += d.toString();
      if (out.includes('is running at')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => reject(new Error(`server exited early (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15000);
  });
}

async function scan(body) {
  const response = await fetch(`${BASE}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test.before(start);
test.after(() => { if (child) child.kill('SIGKILL'); });

test('a bare domain is rejected with INVALID_URL', async () => {
  const { status, body } = await scan({ url: 'example.com', limit: 10 });
  assert.equal(status, 400);
  assert.equal(body.code, 'INVALID_URL');
  assert.equal(body.error, ERRORS.INVALID_URL.message);
});

test('a non-web scheme is rejected with UNSUPPORTED_SCHEME', async () => {
  const { status, body } = await scan({ url: 'ftp://example.com/x', limit: 10 });
  assert.equal(status, 400);
  assert.equal(body.code, 'UNSUPPORTED_SCHEME');
});

test('a missing image reports IMAGE_EXPIRED, not a bare 404', async () => {
  const id = Buffer.from('https://example.com/never-scanned.png').toString('base64url');
  const response = await fetch(`${BASE}/api/image/${id}`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, 'IMAGE_EXPIRED');
});

test('every error response carries both a message and a code', async () => {
  // The whole point of the catalogue: the front end must always have something to match on.
  for (const url of ['', 'nonsense', 'file:///etc/passwd', 'ftp://x.test']) {
    const { body } = await scan({ url, limit: 10 });
    assert.ok(body.error, `no message for ${JSON.stringify(url)}`);
    assert.ok(body.code, `no code for ${JSON.stringify(url)}`);
    assert.ok(body.code in ERRORS, `unknown code ${body.code} for ${JSON.stringify(url)}`);
  }
});

test('the UI and the catalogue are both served to the browser', async () => {
  for (const asset of ['/', '/app.js', '/style.css', '/errors.js', '/progress.js', '/contours.js']) {
    const response = await fetch(BASE + asset);
    assert.equal(response.status, 200, `${asset} should be served`);
  }
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('errors.js'), 'index.html must load the shared catalogue');
});

test('the contour background is not covered by an opaque body background', async () => {
  // The subtle one. #contours sits at z-index -1, and a background on body is only
  // handed to the page canvas - painted beneath everything - under particular
  // conditions. Otherwise it paints as an ordinary element background, ABOVE a
  // negative-z-index sibling, and hides the entire background layer. It failed totally
  // and silently: the layer rendered, animated and reported correct geometry the whole
  // time, and no amount of adjusting it would have revealed anything. The base colour
  // has to live on html.
  const css = await (await fetch(BASE + '/style.css')).text();
  const body = css.match(/\nbody \{[^}]*\}/);
  assert.ok(body, 'style.css should have a body rule');
  assert.match(body[0], /background:\s*transparent/,
    `body must not paint an opaque background over the contour layer: ${body[0]}`);
  const html = css.match(/\nhtml \{[^}]*\}/);
  assert.ok(html && /background:\s*var\(--bg\)/.test(html[0]),
    'html must carry the base colour, since that is what becomes the page canvas');
  // And the layer itself must stay behind content and non-interactive.
  const contours = css.match(/#contours \{[^}]*\}/);
  assert.ok(contours, 'style.css should have a #contours rule');
  assert.match(contours[0], /z-index:\s*-1/, 'the contour layer must sit behind the content');
  assert.match(contours[0], /pointer-events:\s*none/, 'the contour layer must never take clicks');
});

test('the contour canvas is present and driven by its own script', async () => {
  // The background moved from CSS to a canvas, so two things that used to be
  // guaranteed by the stylesheet alone now depend on the markup: the canvas the
  // renderer looks up by id, and the script that draws into it. contours.js returns
  // early rather than throwing when the element is missing, so losing either one
  // fails silently as a plain dark background - exactly the kind of quiet breakage
  // the rule above exists to catch.
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('id="contour-canvas"'), 'index.html must contain the contour canvas');
  assert.ok(html.includes('contours.js'), 'index.html must load the contour renderer');
});

test('a deselected image greys out as well as fading', async () => {
  // Two separate mechanisms, both of which fail quietly.
  //
  // The greyscale amount travels as a custom property because `filter` is a single
  // property and does not compose across rules: if `.card img` stops naming a
  // grayscale term, a deselected card still fades but never desaturates, and if the
  // hover rule stops naming one, it desaturates until you point at it and then
  // springs back to full colour. Neither throws, and both look like a design choice
  // rather than a bug.
  const css = await (await fetch(BASE + '/style.css')).text();

  const deselected = css.match(/\.card:has\(input:not\(:checked\)\) \{[^}]*\}/);
  assert.ok(deselected, 'style.css should style deselected cards');
  assert.match(deselected[0], /--grey:\s*1/,
    `a deselected card must switch on the greyscale: ${deselected[0]}`);
  assert.match(deselected[0], /opacity:\s*0?\.\d+/,
    `a deselected card must also fade, so the state reads at a glance: ${deselected[0]}`);

  // Both filter declarations have to carry the term for it to survive hovering.
  const base = css.match(/\.card img \{[^}]*\}/);
  assert.ok(base && /filter:\s*grayscale\(var\(--grey/.test(base[0]),
    `.card img must name grayscale(var(--grey)) or the greyscale cannot transition: ${base && base[0]}`);
  // Matched by the property rather than by the exact selector, so that changing how
  // the focus half is expressed does not fail this test for the wrong reason.
  const hovered = css.match(/\.card:hover img,[^{]*\{[^}]*\}/);
  assert.ok(hovered && /grayscale\(var\(--grey/.test(hovered[0]),
    `the hover filter must repeat grayscale(var(--grey)) or hovering un-greys a deselected card: ${hovered && hovered[0]}`);
});

test('the title is a real button that starts over', async () => {
  /* A click handler on the <h1> itself would have been the shorter route and would
     have left the control unreachable by keyboard, with no button role. A real
     <button> inside the heading gets Enter, Space, focus handling and the role from
     the platform — so the test guards the element, not the handler. */
  const html = await (await fetch(BASE + '/')).text();
  const heading = html.match(/<h1>.*?<\/h1>/s);
  assert.ok(heading, 'index.html should have an h1');
  assert.match(heading[0], /<button[^>]*id="home"/,
    `the title must be a button so it works by keyboard: ${heading[0]}`);

  const app = await (await fetch(BASE + '/app.js')).text();
  assert.match(app, /function resetToHome\(\)/, 'app.js must define resetToHome()');
  // The whole point of the feature: the address and the results both go.
  const body = app.match(/function resetToHome\(\) \{[\s\S]*?\n\}/);
  assert.ok(body, 'resetToHome() should be findable');
  assert.match(body[0], /clearResults\(\)/, 'resetToHome must clear the results');
  assert.match(body[0], /urlInput\.value = ''/, 'resetToHome must clear the address');
  // A reset mid-scan would be undone when the in-flight scan rendered, so it is inert.
  assert.match(body[0], /aria-disabled/, 'resetToHome must refuse to run during a scan');
});

test('the credit link is present and opens safely', async () => {
  /* The only outbound link in the app, so the safety attributes are worth pinning.
     Without rel="noopener" a target="_blank" link hands the opened tab a handle back to
     this one; without noreferrer it sends this address along as the referrer. Neither is
     needed by an attribution link, and both are easy to drop by accident. */
  const html = await (await fetch(BASE + '/')).text();
  const credit = html.match(/<footer id="credit">[\s\S]*?<\/footer>/);
  assert.ok(credit, 'index.html must contain the credit footer');
  assert.match(credit[0], /Made by:/, `the footer should read "Made by:": ${credit[0]}`);
  assert.match(credit[0], /href="https:\/\/github\.com\/tundra240"/,
    `the credit must link to the author's GitHub: ${credit[0]}`);
  assert.match(credit[0], /rel="noopener noreferrer"/,
    `an external target="_blank" link needs rel="noopener noreferrer": ${credit[0]}`);
});

test('the home screen has something on it before a scan', async () => {
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('id="home-panel"'), 'index.html must contain the home panel');
  const steps = html.match(/<li>/g) || [];
  assert.ok(steps.length >= 3, `the panel should explain the three steps, found ${steps.length}`);
  assert.ok(html.includes('id="recent-row"'), 'index.html must contain the recent-addresses row');

  // The panel must yield to the grid, or a scan's results appear underneath it.
  const app = await (await fetch(BASE + '/app.js')).text();
  assert.match(app, /homePanel\.hidden = images\.length > 0/,
    'app.js must hide the home panel once there are results');
});

test('only the address is ever persisted, never image data', async () => {
  /* The app's stated promise is that captured images live in memory and are never
     written to disk. Recent addresses are the one thing kept between runs, and this
     guards the line: localStorage must only ever see the address list, and there has
     to be a way to clear it. */
  const app = await (await fetch(BASE + '/app.js')).text();

  const writes = [...app.matchAll(/localStorage\.setItem\(([^,]+),/g)].map(m => m[1].trim());
  assert.deepEqual(writes, ['RECENT_KEY'],
    `localStorage must only be written with RECENT_KEY, found: ${writes.join(', ')}`);
  assert.match(app, /localStorage\.removeItem\(RECENT_KEY\)/,
    'there must be a way to clear the stored addresses');

  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('id="recent-clear"'), 'the Clear control must be present in the markup');

  // Reading it back has to survive junk from an older version or disabled storage.
  const loader = app.match(/function loadRecent\(\) \{[\s\S]*?\n\}/);
  assert.ok(loader, 'loadRecent() should be findable');
  assert.match(loader[0], /catch/, 'loadRecent must not let a broken history break the page');
});

test('the title button does not look like a button', async () => {
  // It sits inside the h1 and inherits its type, but `button` in this stylesheet is a
  // green pill with padding and a shadow. Without the reset the heading becomes one.
  const css = await (await fetch(BASE + '/style.css')).text();
  const home = css.match(/#home \{[^}]*\}/);
  assert.ok(home, 'style.css should style #home');
  assert.match(home[0], /all:\s*unset/,
    `#home must reset the base button styling or the title renders as a pill: ${home[0]}`);
  // all: unset also drops the focus ring, which has to come back explicitly.
  assert.match(css, /#home:focus-visible \{[^}]*outline/,
    '#home must restate a focus ring, since all: unset removed the inherited one');
});

test('the card overlay is not held open by a mouse click', async () => {
  /* :focus-within is the intuitive way to keep the hover controls reachable by
     keyboard, and it is wrong here. A mouse click on the tick box or on {} focuses
     that control, and :focus-within stays true after the pointer leaves — so the
     overlay stayed open after every select and deselect until you clicked elsewhere
     on the page.

     :focus-visible is the distinction that fixes it: for a checkbox or a button it
     matches keyboard focus but not a click. Measured in Chromium — after a mouse
     click the box is focused but :focus-visible is false.

     Guarded because the symptom is easy to reintroduce (:focus-within reads as the
     more obvious selector) and impossible to see in a screenshot. */
  const css = await (await fetch(BASE + '/style.css')).text();

  const cardFocusWithin = css.match(/^\.card:focus-within.*$/m);
  assert.equal(cardFocusWithin, null,
    `card rules must not use :focus-within — it latches after a mouse click: ${cardFocusWithin && cardFocusWithin[0]}`);

  const reveal = css.match(/\.card:hover \.overlay,\s*\n[^{]*\{[^}]*opacity:\s*1[^}]*\}/);
  assert.ok(reveal, 'style.css should have a rule revealing the overlay');
  assert.match(reveal[0], /:has\(:focus-visible\)/,
    `the overlay must be revealed by :has(:focus-visible), so keyboard focus still works: ${reveal[0]}`);
});

test('bulk selection changes skip the per-card transition', async () => {
  // Animating a fade and a filter on every card at once is a lurch, not an
  // animation: measured at 500 cards it took the worst frame past 180ms. app.js
  // adds .bulk to the grid for the frame the change lands in, and the stylesheet
  // has to actually act on it - if either half goes missing the jank returns
  // silently, since nothing about the result looks wrong in a screenshot.
  const css = await (await fetch(BASE + '/style.css')).text();
  assert.match(css, /#grid\.bulk[^{]*\{[^}]*transition:\s*none/,
    'style.css must suppress card transitions while #grid has .bulk');
  const app = await (await fetch(BASE + '/app.js')).text();
  assert.match(app, /classList\.add\('bulk'\)/, 'app.js must add the bulk class for a bulk change');
  assert.match(app, /classList\.remove\('bulk'\)/, 'app.js must remove it again, or clicks stop animating');
});

test('the address field does not tell people to type a scheme', async () => {
  // The repair has always accepted a bare domain, but the placeholder showed a full
  // "https://..." address, which reads as an instruction. The feature was invisible,
  // and an invisible feature gets reported as a missing one.
  const html = await (await fetch(BASE + '/')).text();
  const field = html.match(/<input id="url"[^>]*>/)[0];
  const placeholder = (field.match(/placeholder="([^"]*)"/) || [, ''])[1];
  assert.ok(placeholder, `#url should have a placeholder: ${field}`);
  assert.ok(!/^https?:\/\//i.test(placeholder),
    `the placeholder must not lead with a scheme, or it reads as compulsory: ${placeholder}`);
  // And the live preview that shows what a bare domain resolves to must be present.
  assert.ok(html.includes('id="url-preview"'), 'index.html must include the address preview');
});

test('the address field does not use native url validation', async () => {
  // type="url" makes the browser reject a bare domain before the submit handler runs,
  // which silently disables repairUrl — the exact input it exists to fix. Guarding this
  // because the feature fails invisibly if it comes back.
  const html = await (await fetch(BASE + '/')).text();
  const field = html.match(/<input id="url"[^>]*>/)[0];
  assert.ok(!/type="url"/.test(field), `#url must not be type="url": ${field}`);
});
