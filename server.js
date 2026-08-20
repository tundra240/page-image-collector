const express = require('express');
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
// Shared with the front end, which loads the same file as a <script>. One catalogue, no drift.
const { lookup } = require('./public/errors.js');

const app = express();
// Overridable so tests can start their own instance without colliding with a
// running app. Defaults to the documented port.
const PORT = Number(process.env.PORT) || 3719;
// Inside a packaged single-file build, __dirname points into a virtual snapshot, so anything
// read from the real filesystem must be located relative to the executable instead.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
// Unpacked .deb payloads for browser libraries this Linux image lacks (see WSL-COMPATIBILITY.md).
const BROWSER_LIB_DIR = path.join(APP_DIR, '.wsl-browser-libs', 'usr', 'lib', 'x86_64-linux-gnu');
const { resolveLimit, reportedLimit, DEFAULT_IMAGE_LIMIT, MAX_IMAGE_LIMIT } = require('./lib/scan-limits.js');
const { uniqueCandidates } = require('./lib/declared.js');
const { describeLocation } = require('./lib/image-location.js');
const imageStore = new Map();
let currentScan = null;

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Sends a failure the front end can reason about: the human message plus a stable
 * code. `detail` appends the underlying cause for catch-all errors.
 */
function fail(res, code, detail) {
  const entry = lookup(code);
  const message = detail ? `${entry.message} ${detail}` : entry.message;
  return res.status(entry.http || 500).json({ error: message, code });
}

function browserCandidates() {
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap(root => [
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ]);
  }
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];
  // A system browser is preferred when present; Playwright's per-user Chromium is the
  // fallback that makes WSL work, where Windows Chrome under /mnt/c cannot be driven:
  // Playwright controls a browser over Linux process pipes, which WSL interop cannot
  // pass to a Windows .exe.
  let bundled;
  try { bundled = chromium.executablePath(); } catch { /* No Playwright browser is registered. */ }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', bundled].filter(Boolean);
}

function browserEnvironment() {
  // Playwright's Chromium needs NSS and ALSA libraries that are absent here and cannot be
  // installed system-wide without sudo, so they live unpacked inside the project instead.
  // Only browser child processes receive this path; the server's own environment is untouched.
  if (process.platform !== 'linux' || !fs.existsSync(BROWSER_LIB_DIR)) return process.env;
  return { ...process.env, LD_LIBRARY_PATH: [BROWSER_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
}

function findBrowser() {
  return browserCandidates().find(candidate => fs.existsSync(candidate));
}

function normalizeUrl(value, base) {
  try { return new URL(value, base).href; } catch { return null; }
}

const EXTENSIONS = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico', 'image/bmp': '.bmp', 'image/tiff': '.tif'
};

function uniqueName(url, contentType, index) {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image'); } catch { /* ignored */ }
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'image';
  // The served content type wins over whatever the URL claims: sites routinely serve WebP
  // from a .jpg address, and a saved file whose extension lies will not open cleanly.
  const extension = EXTENSIONS[contentType];
  if (extension) name = name.replace(/\.[a-zA-Z0-9]{2,5}$/, '') + extension;
  else if (!/\.[a-zA-Z0-9]{2,5}$/.test(name)) name += '.img';
  return `${String(index + 1).padStart(3, '0')}-${name}`;
}

/* How the 0-99% shown during a scan is divided up.

   Every phase gets a slice it can move through, which is the whole point. The
   previous split gave scrolling 1-90% and the sweep 90-99%, so the seconds spent
   confirming the page had stopped growing, and the fixed wait after that, both
   sat at exactly 90% with nothing to report. Several seconds of motionless bar is
   read as a hang, and no amount of animation on the browser side can fix a number
   that genuinely is not changing. */
const SCROLL_END_PERCENT = 80;   // reaching the bottom of the page
const SETTLE_END_PERCENT = 86;   // confirming it stopped growing
const GRACE_END_PERCENT = 88;    // waiting out requests the last scroll triggered
const RETOP_END_PERCENT = 90;    // waiting again after scrolling back to the top
// The sweep runs from RETOP_END_PERCENT to 99. 100 is reserved for "finished".

/** Consecutive settled steps required before the page is accepted as fully scrolled. */
const SETTLE_STEPS = 6;

/** Time given to requests triggered by a scroll, and how often to report during it. */
const GRACE_MS = 1_500;
const GRACE_STEP_MS = 250;

/**
 * Waits, reporting progress across a slice of the bar as it goes.
 *
 * A fixed-length wait is the one place where progress can be stated with complete
 * confidence: elapsed time over total time, no estimation involved. Reporting it
 * turns seconds of motionless bar into honest movement.
 */
async function reportedWait(page, report, { ms, from, to, phase, extra = {} }) {
  for (let waited = 0; waited < ms; waited += GRACE_STEP_MS) {
    const step = Math.min(GRACE_STEP_MS, ms - waited);
    report({
      phase,
      percent: Number((from + (waited / ms) * (to - from)).toFixed(1)),
      images: imageStore.size,
      ...extra
    });
    await page.waitForTimeout(step);
  }
}

async function scrollEverything(page, reportProgress, shouldStop) {
  // Scroll in individual steps instead of calculating a one-time "bottom". Many
  // pages grow as cards are revealed, and some use a scrolling div rather than
  // the document itself. Both patterns otherwise leave images undiscovered.
  let settledAtEnd = 0;
  let lastDocumentHeight = 0;
  let lastDeclared = 0;
  for (let stepNumber = 0; stepNumber < 1_200 && settledAtEnd < SETTLE_STEPS; stepNumber++) {
    const progress = await page.evaluate(() => {
      const distance = Math.max(220, Math.floor(window.innerHeight * 0.7));
      const scrollers = [...document.querySelectorAll('*')].filter(element => {
        const style = getComputedStyle(element);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll')
          && element.scrollHeight > element.clientHeight + 80;
      });
      // Advance every independently scrolling region, including app-style feeds.
      scrollers.forEach(element => element.scrollTop = Math.min(element.scrollTop + distance, element.scrollHeight));
      window.scrollBy(0, distance);
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const windowAtEnd = window.scrollY + window.innerHeight >= height - 2;
      const containersAtEnd = scrollers.every(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2);
      // Counted here rather than in a second pass: this evaluate already crosses the
      // process boundary, and a deliberately light selector keeps it cheap. Skips
      // computed styles, so it is an estimate — the real sweep is exhaustive.
      const refs = new Set();
      // Resolved against the page URL before counting: a loaded <img> exposes both
      // src ("/a.png") and currentSrc ("http://site/a.png"), and counting those as
      // two images is what made the auto cap total higher than the real one.
      const add = value => {
        if (!value) return;
        if (value.startsWith('data:')) { if (/^data:image\//i.test(value)) refs.add(value); return; }
        try { const u = new URL(value, location.href); u.hash = '';
          if (u.protocol === 'http:' || u.protocol === 'https:') refs.add(u.href); } catch { /* skip */ }
      };
      document.querySelectorAll('img, source, [data-src], [data-srcset], [style*="url("]').forEach(el => {
        for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-url']) {
          add(el.getAttribute(attr));
        }
        add(el.currentSrc);
        const set = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (set) for (const part of set.split(',')) add(part.trim().split(/\s+/)[0]);
        const inline = el.getAttribute('style') || '';
        const match = inline.match(/url\(\s*['\"]?([^)'\"]+)/i);
        if (match) add(match[1]);
      });
      return {
        height, atEnd: windowAtEnd && containersAtEnd,
        position: window.scrollY + window.innerHeight, declared: refs.size
      };
    });
    lastDeclared = progress.declared;
    // Two things advance here, and reporting both is what keeps the bar moving.
    // How far down the page we have reached covers 1% to SCROLL_END_PERCENT - but
    // it stops changing once we are at the bottom, while the loop keeps going to
    // confirm the page is not still growing. So the settled-step count carries the
    // bar the rest of the way.
    const reach = Math.min(1, progress.position / Math.max(1, progress.height));
    const scrolled = 1 + reach * (SCROLL_END_PERCENT - 1);
    const settling = (settledAtEnd / SETTLE_STEPS) * (SETTLE_END_PERCENT - SCROLL_END_PERCENT);
    reportProgress({
      phase: 'Scrolling through the page',
      // Reported to one decimal place, not rounded to whole percent. Rounding meant
      // the figure only changed every few polls, so the bar arrived and then parked
      // over and over - the choppiness was in the number, not the animation.
      percent: Number(Math.min(SETTLE_END_PERCENT, Math.max(1, scrolled + settling)).toFixed(1)),
      images: imageStore.size,
      declared: progress.declared
    });
    if (shouldStop()) break;
    // This pause is what gives lazy-loading observers time to request each image.
    await page.waitForTimeout(550);
    if (progress.atEnd && progress.height <= lastDocumentHeight) settledAtEnd++;
    else settledAtEnd = 0;
    lastDocumentHeight = progress.height;
  }
  // Give requests triggered by the final scroll position a moment to start.
  await reportedWait(page, reportProgress, {
    ms: GRACE_MS, from: SETTLE_END_PERCENT, to: GRACE_END_PERCENT,
    phase: 'Waiting for the last images to load',
    extra: { declared: lastDeclared }
  });
  await page.evaluate(() => window.scrollTo(0, 0));
}

app.get('/api/scan-progress', (req, res) => {
  res.json(currentScan || { phase: 'Idle', percent: 0, images: 0, limit: DEFAULT_IMAGE_LIMIT });
});

app.post('/api/scan', express.json({ limit: '1mb' }), async (req, res) => {
  if (currentScan) return fail(res, 'SCAN_IN_PROGRESS');
  const target = String(req.body?.url || '').trim();
  const { limit: imageLimit, autoCap } = resolveLimit(req.body);
  // Auto cap cannot know the total up front, so it runs to the backstop and reports
  // the number of image references it has spotted as the scan proceeds.
  let detectedImages = 0;
  let parsed;
  try { parsed = new URL(target); } catch { return fail(res, 'INVALID_URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return fail(res, 'UNSUPPORTED_SCHEME');
  const executablePath = findBrowser();
  if (!executablePath) return fail(res, 'NO_BROWSER');

  currentScan = {
    phase: 'Opening the page', percent: 0, images: 0, autoCap,
    limit: reportedLimit({ autoCap, limit: imageLimit, detected: 0 })
  };
  imageStore.clear();
  let browser;
  try {
    // Keep the automated page visible: it makes progress clear and avoids sites
    // that decline to run lazy loaders in a headless browser.
    browser = await chromium.launch({ executablePath, headless: false, env: browserEnvironment() });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const captureTasks = new Set();
    page.on('response', response => {
      const task = (async () => {
      const type = (response.headers()['content-type'] || '').split(';')[0].toLowerCase();
      if (!type.startsWith('image/') || imageStore.size >= imageLimit) return;
      const key = response.url();
      if (imageStore.has(key)) return;
      try {
        const body = await response.body();
        if (body.length && imageStore.size < imageLimit) imageStore.set(key, { url: key, contentType: type, body });
      } catch { /* Some responses intentionally have no readable body. */ }
      })();
      captureTasks.add(task);
      task.then(() => captureTasks.delete(task), () => captureTasks.delete(task));
    });
    await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const report = progress => {
      if (!currentScan) return;
      if (progress.declared > detectedImages) detectedImages = progress.declared;
      Object.assign(currentScan, progress, {
        limit: reportedLimit({ autoCap, limit: imageLimit, detected: detectedImages, captured: imageStore.size })
      });
    };

    await scrollEverything(page, report, () => imageStore.size >= imageLimit);

    // A second wait, because scrollEverything returns the page to the top and that
    // can bring more lazy-loaded images into view. It used to be a bare
    // waitForTimeout, which meant a second and a half of completely motionless bar.
    await reportedWait(page, report, {
      ms: GRACE_MS, from: GRACE_END_PERCENT, to: RETOP_END_PERCENT,
      phase: 'Checking the top of the page again'
    });

    // Include URL forms exposed by lazy-load attributes and srcset even if the site did not request them yet.
    // The sweep also records where each source was found, because the {} panel in the UI reports an
    // image's place in the page and this evaluate is the only moment that knowledge exists.
    const sweep = await page.evaluate(() => {
      const found = [];
      const locations = {};

      // A short readable path rather than a full ancestor chain: an id ends it outright
      // because an id is already unique, and the first class name is usually enough to
      // recognise a section by eye. Six levels keeps it readable on a card.
      const describePath = element => {
        const parts = [];
        for (let node = element; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
          if (node.id) { parts.unshift(node.tagName.toLowerCase() + '#' + node.id); break; }
          let part = node.tagName.toLowerCase();
          const className = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
          if (className) part += '.' + className;
          const twins = node.parentElement
            ? [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName)
            : [];
          if (twins.length > 1) part += ':nth-of-type(' + (twins.indexOf(node) + 1) + ')';
          parts.unshift(part);
        }
        return parts.join(' > ');
      };

      // Measured only for the first element to declare a given source. getBoundingClientRect
      // forces the browser to lay the page out, and this sweep already visits every element,
      // so doing it once per source rather than once per sighting matters here.
      const add = (value, element) => {
        if (!value) return;
        found.push(value);
        if (!element || locations[value]) return;
        const box = element.getBoundingClientRect();
        locations[value] = {
          foundIn: describePath(element),
          top: Math.round(box.top + window.scrollY),
          left: Math.round(box.left + window.scrollX),
          width: Math.round(box.width),
          height: Math.round(box.height)
        };
      };

      document.querySelectorAll('img, source, [style], *').forEach(el => {
        ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-url', 'srcset', 'data-srcset'].forEach(attr => {
          const value = el.getAttribute(attr);
          if (!value) return;
          if (attr.includes('srcset')) value.split(',').forEach(item => add(item.trim().split(/\s+/)[0], el));
          else add(value, el);
        });
        const style = el.getAttribute('style') || '';
        for (const match of style.matchAll(/url\(\s*['\"]?([^)'\"]+)/gi)) add(match[1], el);
        const computed = getComputedStyle(el).backgroundImage || '';
        for (const match of computed.matchAll(/url\(\s*['\"]?([^)'\"]+)/gi)) add(match[1], el);
      });
      document.querySelectorAll('img').forEach(img => add(img.currentSrc, img));

      return {
        found, locations,
        pageHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
      };
    });
    // Kept as a plain array of raw values: uniqueCandidates below is what turns it into
    // one entry per real resource, and the measurements ride alongside rather than
    // changing its shape.
    const declared = sweep.found;
    // Collapse the raw attribute values into one entry per actual resource. Without
    // this the same image is fetched and counted several times over, because src,
    // currentSrc and each srcset entry are different strings for the same file.
    const candidates = uniqueCandidates(declared, page.url());
    if (candidates.length > detectedImages) detectedImages = candidates.length;

    // Fetch declared sources through the automated browser so cookies/referrer handling stays with the page.
    for (const [sweepIndex, raw] of candidates.entries()) {
      if (currentScan) Object.assign(currentScan, {
        phase: 'Collecting images the page declared',
        // Fractional for the same reason as the scroll phase: with candidates.length
        // under nine, rounding to whole percent left the bar still between images.
        percent: Number((RETOP_END_PERCENT + Math.min(9, (sweepIndex / Math.max(1, candidates.length)) * 9)).toFixed(1)),
        images: imageStore.size,
        limit: reportedLimit({ autoCap, limit: imageLimit, detected: detectedImages, captured: imageStore.size })
      });
      if (raw.startsWith('data:image/')) {
        if (imageStore.has(raw) || imageStore.size >= imageLimit) continue;
        const match = raw.match(/^data:([^;,]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/s);
        if (!match) continue;
        try {
          const body = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
          if (match[1].startsWith('image/')) imageStore.set(raw, { url: raw, contentType: match[1], body });
        } catch { /* Ignore malformed data URLs. */ }
        continue;
      }
      const imageUrl = normalizeUrl(raw, page.url());
      if (!imageUrl || imageStore.has(imageUrl) || imageStore.size >= imageLimit) continue;
      // no-cors matches how a browser loads an <img>: a default fetch is CORS-mode and is
      // refused by hosts that send no access-control-allow-origin. The response is opaque to
      // the page, but Playwright reads bodies at the network layer, so it is still captured.
      try { await page.evaluate(url => fetch(url, { mode: 'no-cors' }).catch(() => null), imageUrl); } catch { /* continue */ }
    }
    // Sweep fetches are fire-and-forget, so this is the grace period for the last
    // of them to arrive. Reported too, rather than holding the sweep's last figure.
    if (currentScan) Object.assign(currentScan, { phase: 'Finishing up', percent: 99, images: imageStore.size });
    await page.waitForTimeout(600);
    await Promise.allSettled([...captureTasks]);
    // Responses arrive in network order, so use the page's DOM order for the grid.
    const pageOrder = new Map();
    candidates.forEach((url, index) => { if (!pageOrder.has(url)) pageOrder.set(url, index); });
    // Measurements are keyed by the raw attribute value; the store is keyed by resolved
    // URL. Running each raw key back through uniqueCandidates is what makes the two
    // agree — resolving by hand would miss the fragment stripping it does, and every
    // location for a src ending in "#top" would then silently fail to match.
    const locationByUrl = new Map();
    for (const [raw, measured] of Object.entries(sweep.locations)) {
      const [url] = uniqueCandidates([raw], page.url());
      if (url && !locationByUrl.has(url)) locationByUrl.set(url, measured);
    }
    const items = [...imageStore.values()]
      .sort((a, b) => (pageOrder.get(a.url) ?? Number.MAX_SAFE_INTEGER) - (pageOrder.get(b.url) ?? Number.MAX_SAFE_INTEGER))
      .map((entry, index) => ({
      id: Buffer.from(entry.url).toString('base64url'), url: entry.url,
      name: uniqueName(entry.url, entry.contentType, index), type: entry.contentType, bytes: entry.body.length,
      location: describeLocation(locationByUrl.get(entry.url), sweep.pageHeight)
      }));
    res.json({
      images: items, browser: path.basename(executablePath),
      capped: imageStore.size >= imageLimit, limit: imageLimit,
      autoCap, detected: detectedImages
    });
  } catch (error) {
    // Recognise the failures we know by shape, so the front end can offer real advice
    // instead of showing a raw Playwright message.
    const raw = error.message || '';
    if (raw.includes('Timeout')) fail(res, 'PAGE_TIMEOUT');
    else if (/shared librar|libnss3|libnspr4|libasound/i.test(raw)) fail(res, 'BROWSER_LIBS_MISSING');
    else if (raw.includes('not well-serializable')) fail(res, 'PKG_NOT_SERIALIZABLE');
    else if (raw.includes('ERR_INSPECTOR_NOT_AVAILABLE')) fail(res, 'PKG_INSPECTOR_UNAVAILABLE');
    else if (raw.includes('browsers.json')) fail(res, 'PKG_MISSING_BROWSERS_JSON');
    else fail(res, 'SCAN_FAILED', raw);
  } finally {
    if (browser) await browser.close().catch(() => {});
    currentScan = null;
  }
});

let installingBrowser = null;

app.post('/api/self-heal/install-browser', async (req, res) => {
  if (currentScan) return fail(res, 'SCAN_IN_PROGRESS');
  // A packaged build has no node_modules on disk to run the CLI from.
  if (process.pkg) return fail(res, 'NO_BROWSER');

  const cli = path.join(__dirname, 'node_modules', 'playwright-core', 'cli.js');
  if (!fs.existsSync(cli)) return fail(res, 'NO_BROWSER');

  if (!installingBrowser) {
    // execFile with a fixed argument list and no shell: there is no user input
    // anywhere in this command, so it cannot be turned into arbitrary execution.
    installingBrowser = new Promise((resolve, reject) => {
      execFile(process.execPath, [cli, 'install', 'chromium'], { timeout: 900000 },
        error => error ? reject(error) : resolve());
    }).finally(() => { installingBrowser = null; });
  }

  try {
    await installingBrowser;
    if (!findBrowser()) return fail(res, 'NO_BROWSER');
    res.json({ ok: true, browser: path.basename(findBrowser()) });
  } catch (error) {
    fail(res, 'SCAN_FAILED', `Chromium download failed: ${error.message}`);
  }
});

app.get('/api/image/:id', (req, res) => {
  const url = Buffer.from(req.params.id, 'base64url').toString();
  const image = imageStore.get(url);
  if (!image) return fail(res, 'IMAGE_EXPIRED');
  res.type(image.contentType).send(image.body);
});

const server = app.listen(PORT, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${PORT}`;
  console.log(`Page Image Collector is running at ${address}`);
  const browser = findBrowser();
  // PIC_NO_OPEN keeps automated runs from spawning a browser window on the desktop.
  if (browser && !process.env.PIC_NO_OPEN) execFile(browser, [address], { env: browserEnvironment() }, () => {});
  else console.log('Open the address above in a browser after installing Chrome or Edge.');
});

server.on('error', error => {
  // The default here is an unhandled 'error' event and a stack trace, which buries
  // the one thing worth saying.
  if (error.code === 'EADDRINUSE') {
    const entry = lookup('PORT_IN_USE');
    console.error(`\n${entry.message}\n\n${entry.fix}\n`);
    process.exit(1);
  }
  throw error;
});
