const form = document.querySelector('#scan-form');
const urlInput = document.querySelector('#url');
const limitInput = document.querySelector('#limit');
const scanButton = document.querySelector('#scan');
const status = document.querySelector('#status');
const progressWrap = document.querySelector('#progress-wrap');
const progressBar = document.querySelector('#progress-bar');
const results = document.querySelector('#results');
const grid = document.querySelector('#grid');
const count = document.querySelector('#count');
const saveButton = document.querySelector('#save');
const filters = document.querySelector('#filters');
const hint = document.querySelector('#hint');
const autoCapInput = document.querySelector('#auto-cap');
const urlPreview = document.querySelector('#url-preview');
// The title, which doubles as "start over". Read here with the rest so nothing later
// has to wonder whether it has been looked up yet.
const homeButton = document.querySelector('#home');
const homePanel = document.querySelector('#home-panel');
const recentRow = document.querySelector('#recent-row');
const recentList = document.querySelector('#recent');
const recentClear = document.querySelector('#recent-clear');
// Same catalogue the server uses, loaded here as a plain script.
const { lookup, repairUrl, isRetryable, isLocalHostname } = window.APP_ERRORS;
let images = [];
let activeTypes = new Set();
let progressTimer = null;

const TYPE_LABELS = {
  'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/webp': 'WebP',
  'image/svg+xml': 'SVG', 'image/avif': 'AVIF', 'image/x-icon': 'ICO',
  'image/vnd.microsoft.icon': 'ICO', 'image/bmp': 'BMP', 'image/tiff': 'TIFF'
};
function typeLabel(type) { return TYPE_LABELS[type] || (type || '').replace(/^image\//, '').toUpperCase() || 'OTHER'; }

function setStatus(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
function clearHint() { hint.hidden = true; hint.replaceChildren(); }

/**
 * Shows what an error means and what to do about it, plus any action the app can
 * take on the user's behalf. `actions` is a list of { label, run } pairs.
 */
function showHint(code, actions = []) {
  const entry = lookup(code);
  hint.replaceChildren();

  const title = document.createElement('strong');
  title.textContent = entry.code === 'UNKNOWN' ? 'What to try' : `What went wrong (${entry.code})`;
  const meaning = document.createElement('p');
  meaning.textContent = entry.meaning;
  const fix = document.createElement('p');
  fix.className = 'hint-fix';
  fix.textContent = entry.fix;
  hint.append(title, meaning, fix);

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'hint-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.onclick = () => action.run(button);
      row.append(button);
    }
    hint.append(row);
  }
  hint.hidden = false;
}
// A hidden image is not a selected image: filtering out a type must also stop it being saved.
function shown() { return images.filter(image => activeTypes.has(image.type)); }
function selected() { return [...document.querySelectorAll('.pick:checked')].map(box => images.find(image => image.id === box.value)).filter(image => image && activeTypes.has(image.type)); }
function updateCount() {
  const hidden = images.length - shown().length;
  count.textContent = `${selected().length} of ${shown().length} selected${hidden ? ` (${hidden} hidden)` : ''}`;
}

function buildFilters() {
  const counts = new Map();
  images.forEach(image => counts.set(image.type, (counts.get(image.type) || 0) + 1));
  activeTypes = new Set(counts.keys());
  filters.replaceChildren();
  if (!counts.size) return;
  const heading = document.createElement('span');
  heading.className = 'filters-label';
  heading.textContent = 'Show types';
  filters.append(heading);
  // Commonest type first, so the chip you most likely want to toggle is nearest the label.
  [...counts.entries()].sort((a, b) => b[1] - a[1] || typeLabel(a[0]).localeCompare(typeLabel(b[0]))).forEach(([type, total]) => {
    const chip = document.createElement('label');
    chip.className = 'chip';
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = true; box.dataset.type = type;
    box.addEventListener('change', () => {
      if (box.checked) activeTypes.add(type); else activeTypes.delete(type);
      applyFilter();
    });
    const name = document.createElement('span');
    name.textContent = typeLabel(type);
    const tally = document.createElement('span');
    tally.className = 'chip-count'; tally.textContent = total;
    chip.append(box, name, tally);
    filters.append(chip);
  });
}

function applyFilter() {
  grid.querySelectorAll('.card').forEach(card => { card.hidden = !activeTypes.has(card.dataset.type); });
  updateCount();
}
/* The server is polled a few times a second, but the bar is painted every
   animation frame. Decoupling the two is what removes the choppiness: without it
   the width jumps once per poll and then sits perfectly still in between.

   All the easing maths lives in progress.js so it can be tested without a
   browser - see public/progress.js and test/progress.test.js. */
const { advance } = window.APP_PROGRESS;

let targetPercent = 0;
let shownPercent = 0;
let progressFrame = null;
let lastFrameAt = 0;

// rAF hands us a timestamp, so elapsed time comes free. Passing it to advance()
// is what makes the animation identical on a 60Hz and a 144Hz display.
function paintProgress(now) {
  const dt = lastFrameAt ? now - lastFrameAt : 16;
  lastFrameAt = now;

  shownPercent = advance(shownPercent, targetPercent, dt);
  progressBar.style.width = `${shownPercent.toFixed(2)}%`;
  progressFrame = requestAnimationFrame(paintProgress);
}

function startProgress() {
  targetPercent = 0; shownPercent = 0; lastFrameAt = 0;
  progressBar.style.width = '0%';
  if (!progressFrame) progressFrame = requestAnimationFrame(paintProgress);
}

function stopProgress() {
  if (progressFrame) cancelAnimationFrame(progressFrame);
  progressFrame = null;
  lastFrameAt = 0;
}

// Monotonic on purpose: the server's percentage can fall when a page grows during
// scrolling, and a bar that retreats reads as broken even though nothing is wrong.
function setProgressTarget(percent) {
  targetPercent = Math.max(targetPercent, Math.min(100, Number(percent) || 0));
}

async function refreshProgress() {
  try {
    const progress = await fetch('/api/scan-progress').then(response => response.json());
    setProgressTarget(progress.percent);
    if (progress.phase === 'Idle') return;
    // With auto cap there is no denominator until the page has been inspected, and
    // even then it is an upper bound: whether a URL returns an image is only known
    // once it has been fetched, so some candidates will turn out to be 404s or not
    // images at all. The tilde says so rather than promising an exact total.
    const found = progress.images || 0;
    const counted = progress.limit == null
      ? `${found} image${found === 1 ? '' : 's'} found so far`
      : `${found} of ${progress.autoCap ? '~' : ''}${progress.limit} images`;
    setStatus(`${progress.phase} — ${Math.round(progress.percent || 0)}% (${counted})`);
  } catch { /* The completed scan will surface its own error message. */ }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The arrow on the "open in a new tab" control: a diagonal stroke with a head,
 * drawn rather than typed. The Unicode arrow renders as an emoji on some systems
 * and cannot be recoloured, so an inline SVG is the only way to be sure it stays
 * a thin green line at the angle it is meant to point.
 */
function arrowIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const shaft = document.createElementNS(SVG_NS, 'line');
  shaft.setAttribute('x1', '7'); shaft.setAttribute('y1', '17');
  shaft.setAttribute('x2', '16.5'); shaft.setAttribute('y2', '7.5');
  const head = document.createElementNS(SVG_NS, 'polyline');
  head.setAttribute('points', '9.5 7 17 7 17 14.5');
  svg.append(shaft, head);
  return svg;
}

/**
 * What the {} panel prints. Nulls are kept rather than dropped: "foundIn": null
 * states that nothing on the page declared this image, whereas a missing key
 * would read as the panel having failed to look.
 */
function locationReport(image) {
  const location = image.location || {};
  return {
    name: image.name,
    url: image.url,
    type: image.type,
    bytes: image.bytes,
    via: location.via || 'unknown',
    foundIn: location.foundIn ?? null,
    position: location.position ?? null,
    displayedSize: location.displayedSize ?? null
  };
}

function buildCard(image, index) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.type = image.type;
  // Staggers the entrance animation, capped so a large result set still appears promptly.
  card.style.setProperty('--i', Math.min(index, 20));

  // The frame clips the overlay to the picture, so the blur stops at the image edge
  // rather than washing over the filename underneath it.
  const frame = document.createElement('div');
  frame.className = 'frame';
  const preview = document.createElement('img');
  preview.alt = '';
  preview.src = `/api/image/${image.id}`;

  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const pick = document.createElement('label');
  pick.className = 'pick-box';
  pick.title = 'Select this image';
  const checkbox = document.createElement('input');
  checkbox.className = 'pick';
  checkbox.type = 'checkbox';
  checkbox.value = image.id;
  checkbox.checked = true;
  checkbox.setAttribute('aria-label', `Select ${image.name}`);
  pick.append(checkbox);

  // An anchor rather than a button, because it costs nothing and keeps the habits
  // people already have: middle-click, ctrl-click and "copy link address" all work.
  // It points at the captured bytes rather than the original address, so a host that
  // blocks hotlinking cannot break it, and what opens is exactly what would be saved.
  const open = document.createElement('a');
  open.className = 'overlay-action';
  open.href = `/api/image/${image.id}`;
  open.target = '_blank';
  open.rel = 'noopener';
  open.title = 'Open this image on its own in a new tab';
  open.setAttribute('aria-label', `Open ${image.name} in a new tab`);
  open.append(arrowIcon());

  const details = document.createElement('button');
  details.type = 'button';
  details.className = 'overlay-action overlay-json';
  details.title = 'Where this image sits on the page';
  details.setAttribute('aria-label', `Where ${image.name} sits on the page`);
  details.textContent = '{}';
  details.addEventListener('click', () => showDetails(image));

  overlay.append(pick, open, details);
  frame.append(preview, overlay);

  const name = document.createElement('span');
  name.className = 'name';
  name.title = image.url;
  name.textContent = image.name;
  card.append(frame, name);

  // The card used to be a <label>, which is what made a click anywhere on it select
  // the image. Buttons cannot live inside a label — every press would toggle the
  // checkbox as a side effect — so the card is now a plain element and that
  // behaviour is reproduced here, minus the clicks that belong to a control.
  card.addEventListener('click', event => {
    if (event.target.closest('.pick-box, .overlay-action')) return;
    checkbox.checked = !checkbox.checked;
    updateCount();
  });

  return card;
}

function renderResults(data) {
  images = data.images;
  for (const [index, image] of images.entries()) grid.append(buildCard(image, index));
  results.hidden = false; buildFilters(); applyFilter();
  // Bring the grid into view once it exists. Only worth doing when there is
  // something to look at, and only when it is not already on screen.
  if (images.length && results.getBoundingClientRect().top > window.innerHeight * 0.8) {
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  /* The home panel gives way to the grid - but comes back when a scan found nothing,
     because otherwise the page is a form and a one-line apology, which is the emptiness
     the panel exists to fix. */
  if (homePanel) homePanel.hidden = images.length > 0;
  const limitNote = data.capped
    ? ` Reached the ${data.limit}-image limit.`
    : (data.autoCap ? ` Auto cap: took everything the page had.` : '');
  setStatus(images.length
    ? `Found ${images.length} image${images.length === 1 ? '' : 's'} using ${data.browser}, ordered by page position.${limitNote}`
    : 'No images were found on this page.');
}

/** One scan attempt. Returns the data, or throws an Error carrying a `code`. */
async function requestScan(url, limit, autoCap) {
  let response;
  try {
    response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, limit, autoCap })
    });
  } catch {
    // fetch only rejects on a network-level failure. The page is loaded and running,
    // so the server behind it has gone away.
    const error = new Error(lookup('SERVER_UNREACHABLE').message);
    error.code = 'SERVER_UNREACHABLE';
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || lookup('UNKNOWN').message);
    error.code = data.code || 'UNKNOWN';
    throw error;
  }
  return data;
}

const MAX_WAITS = 20;      // ~60s of waiting for another scan to finish
const WAIT_SECONDS = 3;

/* A live preview of the address that will actually be used.

   The repair itself is not new - a bare domain has always been completed on submit -
   but it happened silently, and the placeholder showed a full "https://..." address,
   so the app read as though a scheme were compulsory. A feature nobody can tell is
   there may as well not be. This makes the completion visible while typing. */
/* Half-typed addresses resolve to complete nonsense - on the way to
   "www.example.com" the input passes through "www.", "www.e", "www.ex" - and each one
   is a hostname the repair will cheerfully complete. Showing every step means the
   preview flickers through gibberish and looks broken.

   Two guards. This one rejects a hostname that does not look finished: a real one ends
   in a dot followed by at least two letters. Local addresses are exempt because
   "localhost" has no dot and "127.0.0.1" ends in a digit, and both are legitimate. */
function looksFinished(url) {
  try {
    const host = new URL(url).hostname;
    return isLocalHostname(host) || /\.[a-z]{2,}$/i.test(host);
  } catch {
    return false;
  }
}

function renderUrlPreview() {
  const typed = urlInput.value.trim();
  const repaired = typed ? repairUrl(typed) : null;

  if (repaired && repaired !== typed && looksFinished(repaired)) {
    // Worth saying: the app is about to use something different from what was typed.
    urlPreview.textContent = `Will scan ${repaired}`;
    urlPreview.className = '';
    urlPreview.hidden = false;
    return;
  }

  // Only complain about input that looks like a finished attempt at an address.
  // Nagging at "e" on the way to "example.com" would be pure noise.
  if (!repaired && /[.:]/.test(typed)) {
    urlPreview.textContent = 'That is not a usable web address yet.';
    urlPreview.className = 'preview-warn';
    urlPreview.hidden = false;
    return;
  }

  urlPreview.hidden = true;
}

/* And this one waits for a pause in typing - the second guard. Rendering on every
   keystroke draws the eye to something changing under the cursor while the user is
   still mid-word; waiting until they stop makes it a confirmation instead. */
const PREVIEW_DELAY_MS = 350;
let previewTimer = null;

function updateUrlPreview() {
  clearTimeout(previewTimer);
  // Retract a stale preview at once, but never show a new one early: a line that
  // still describes an older value is worse than no line.
  if (!urlPreview.hidden) urlPreview.hidden = true;
  previewTimer = setTimeout(renderUrlPreview, PREVIEW_DELAY_MS);
}

urlInput.addEventListener('input', updateUrlPreview);
// Paste and autofill can both land without a keystroke.
urlInput.addEventListener('change', updateUrlPreview);
// Leaving the field is a definite pause, so show the preview immediately.
urlInput.addEventListener('blur', () => { clearTimeout(previewTimer); renderUrlPreview(); });

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearHint();

  // Self-repair before asking: a missing scheme is the mistake people actually make,
  // and failing the request first would be a worse experience than fixing it.
  const typed = urlInput.value;
  const repaired = repairUrl(typed);
  if (repaired && repaired !== typed) {
    urlInput.value = repaired;
    setStatus(`Using ${repaired}`);
  } else if (!repaired) {
    setStatus(lookup('INVALID_URL').message, true);
    showHint('INVALID_URL');
    return;
  }

  clearTimeout(previewTimer); urlPreview.hidden = true;
  scanButton.disabled = true; limitInput.disabled = true;
  // Inert while a scan owns the page — see resetToHome().
  homeButton?.setAttribute('aria-disabled', 'true');
  clearResults();
  // The steps have served their purpose once a scan is under way; the progress bar is
  // the thing to look at.
  if (homePanel) homePanel.hidden = true;
  progressWrap.hidden = false;
  startProgress();
  setStatus('Opening the page and scrolling through it…');
  progressTimer = setInterval(refreshProgress, 300);
  refreshProgress();

  try {
    let data;
    for (let attempt = 0; ; attempt++) {
      try {
        data = await requestScan(urlInput.value, Number(limitInput.value), autoCapInput.checked);
        break;
      } catch (error) {
        // Retry only what is genuinely worth retrying unchanged, and give up rather
        // than loop forever.
        if (!isRetryable(error.code) || attempt >= MAX_WAITS) throw error;
        for (let left = WAIT_SECONDS; left > 0; left--) {
          setStatus(`${lookup(error.code).message} Retrying in ${left}s…`);
          await new Promise(done => setTimeout(done, 1000));
        }
      }
    }
    renderResults(data);
    // Only a scan that actually completed is worth offering again.
    rememberAddress(urlInput.value);
  } catch (error) {
    setStatus(error.message, true);
    showHint(error.code, actionsFor(error.code));
    // Nothing to show, so put the home screen back rather than leaving a bare page
    // under the error.
    if (homePanel) homePanel.hidden = false;
  } finally {
    clearInterval(progressTimer); progressTimer = null;
    setProgressTarget(100);
    // Let the bar reach the end before it disappears, rather than vanishing mid-slide.
    setTimeout(() => { stopProgress(); progressWrap.hidden = true; }, 320);
    scanButton.disabled = false;
    limitInput.disabled = autoCapInput.checked;
    homeButton?.removeAttribute('aria-disabled');
  }
});

/* -------------------------------------------------------------- recent addresses */

/* The only thing the app remembers between runs.

   Deliberately the ADDRESS ONLY, never results. Captured images live in memory and
   are never written to disk — that is a documented promise, and a convenience feature
   is not a good enough reason to quietly break it. A Clear button sits next to the row
   because a list of pages somebody visited, however short, should not be keepable
   without a way to remove it. */
const RECENT_KEY = 'pic.recent';
const RECENT_MAX = 6;

function loadRecent() {
  /* Every step here can fail in a way that is not this app's fault: storage can be
     disabled or full, and the value can be whatever an older version wrote. A broken
     history must degrade to no history rather than take the page down with it. */
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => typeof item === 'string' && item).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function rememberAddress(address) {
  if (!address) return;
  // Most recent first, and de-duplicated: rescanning one page should move it to the
  // front rather than fill the row with six copies of itself.
  const next = [address, ...loadRecent().filter(item => item !== address)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* full or disabled */ }
  renderRecent();
}

function renderRecent() {
  if (!recentRow || !recentList) return;
  const addresses = loadRecent();
  recentList.replaceChildren();
  // An empty "Recent" heading is worse than no heading, so the whole row goes.
  recentRow.hidden = addresses.length === 0;

  for (const address of addresses) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recent-chip';
    // The scheme is dropped for display only — it is nearly always https and eats
    // width that the actual page path needs. The full address is in the tooltip.
    chip.textContent = address.replace(/^https?:\/\//, '');
    chip.title = address;
    chip.addEventListener('click', () => {
      urlInput.value = address;
      // Straight to the preview rather than through the debounce: a click is already
      // a definite choice, so there is nothing to wait for.
      clearTimeout(previewTimer);
      renderUrlPreview();
      urlInput.focus();
    });
    recentList.append(chip);
  }
}

if (recentClear) {
  recentClear.addEventListener('click', () => {
    try { localStorage.removeItem(RECENT_KEY); } catch { /* nothing that can be done */ }
    renderRecent();
    urlInput.focus();
  });
}

renderRecent();

/* ------------------------------------------------------------------- start over */

/** Empties the results and the state describing them. Shared with the submit handler,
    which has to do exactly the same thing before a new scan. */
function clearResults() {
  results.hidden = true;
  grid.replaceChildren();
  images = [];
  filters.replaceChildren();
  activeTypes = new Set();
}

/* Clicking the title returns the page to how it started.

   Deliberately does nothing while a scan is running, rather than being clever about
   it. There is no way to cancel a scan — the server allows one at a time and has no
   abort — so a reset mid-scan would be silently undone the moment the in-flight
   request came back and rendered its results, which looks like the photos returning
   by themselves. The control is marked aria-disabled for the duration instead, which
   also gives it a `wait` cursor.

   The image cap and Auto cap are left alone on purpose. They are settings for the
   next scan rather than results of the last one, and clearing them would throw away
   a choice the user made rather than tidying up after the app. */
function resetToHome() {
  if (homeButton?.getAttribute('aria-disabled') === 'true') return;

  clearResults();
  clearHint();
  setStatus('');
  // Back to the home screen, which is the whole point of the control.
  if (homePanel) homePanel.hidden = false;

  urlInput.value = '';
  clearTimeout(previewTimer);
  urlPreview.hidden = true;
  urlPreview.textContent = '';

  progressWrap.hidden = true;
  stopProgress();
  targetPercent = 0;
  shownPercent = 0;
  progressBar.style.width = '0%';

  // Ready to type, which is what "home" is for. html has scroll-behavior: smooth, so
  // the jump back up is animated without asking for it here.
  window.scrollTo({ top: 0 });
  urlInput.focus();
}

// Guarded like #to-top: a cached older index.html has no button, and an unguarded
// throw here would stop every handler defined below from being attached.
if (homeButton) homeButton.addEventListener('click', resetToHome);

/** Fixes the app can carry out itself, offered as buttons under the explanation. */
function actionsFor(code) {
  if (code === 'NO_BROWSER') {
    return [{
      label: 'Download Chromium for me',
      run: async button => {
        button.disabled = true;
        setStatus('Downloading Chromium (about 115 MB). This runs once…');
        try {
          const response = await fetch('/api/self-heal/install-browser', { method: 'POST' });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'The download failed.');
          clearHint();
          setStatus('Chromium installed. Press Find images to try again.');
        } catch (error) {
          setStatus(error.message, true);
          button.disabled = false;
        }
      }
    }];
  }
  if (code === 'SERVER_UNREACHABLE') {
    return [{
      label: 'Check again',
      run: async button => {
        button.disabled = true;
        try {
          await fetch('/api/scan-progress');
          setStatus('The server is back. Press Find images to try again.');
          clearHint();
        } catch {
          setStatus('Still no answer. Start the server, then press Check again.', true);
          button.disabled = false;
        }
      }
    }];
  }
  return [];
}

// A number the app is going to ignore should not look editable.
autoCapInput.addEventListener('change', () => { limitInput.disabled = autoCapInput.checked; });

/* ----------------------------------------------------------------- {} panel */
/* One dialog reused by every card rather than a panel per card: a 500-image grid
   would otherwise carry 500 hidden panels, and a card is far too narrow to read a
   full URL or DOM path inside. A native <dialog> also brings Esc-to-close and
   focus handling without any of it having to be written here. */

const detailsDialog = document.querySelector('#details');
const detailsTitle = document.querySelector('#details-title');
const detailsJson = document.querySelector('#details-json');
const detailsCopy = document.querySelector('#details-copy');
const detailsClose = document.querySelector('#details-close');

function showDetails(image) {
  // Guarded like #to-top below: a browser holding a cached older index.html has no
  // dialog to show, and throwing here would take the rest of this file down with it.
  if (!detailsDialog) return;
  detailsTitle.textContent = image.name;
  detailsJson.textContent = JSON.stringify(locationReport(image), null, 2);
  detailsDialog.showModal();
}

if (detailsDialog) {
  detailsClose.onclick = () => detailsDialog.close();
  // Clicking the backdrop closes it. The dialog element itself covers the whole
  // viewport, so a click landing on it rather than on its contents is a backdrop click.
  detailsDialog.addEventListener('click', event => {
    if (event.target === detailsDialog) detailsDialog.close();
  });
  detailsCopy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(detailsJson.textContent);
      detailsCopy.textContent = 'Copied';
    } catch {
      // Clipboard access can be refused outright, and silently doing nothing would
      // look like the button is broken.
      detailsCopy.textContent = 'Select it and press Ctrl+C';
    }
    setTimeout(() => { detailsCopy.textContent = 'Copy'; }, 1600);
  };
}

const toTop = document.querySelector('#to-top');
// Guarded because a browser holding a cached copy of an older index.html would have
// no #to-top element, and an unguarded throw here would stop every handler defined
// below it from ever being attached.
if (toTop) {
  // passive: true tells the browser this listener never calls preventDefault, so it
  // does not have to wait for us before scrolling.
  window.addEventListener('scroll', () => {
    toTop.classList.toggle('visible', window.scrollY > 380);
  }, { passive: true });
  toTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
}

grid.addEventListener('change', updateCount);

/* Ticks or unticks every visible card at once.

   The transition is suppressed while the change lands, and that is not a
   micro-optimisation. Each card fades and desaturates when it is deselected, which
   is right for one card and wrong for five hundred: animating a filter on every
   card in the grid simultaneously took the worst frame to 189ms in a headless
   measurement - a visible lurch. Suppressed, the new state simply appears, which is
   what a bulk command should look like in any case. Individual clicks still animate,
   because the class is gone again by the next frame.

   One frame is not enough to remove it: the class has to survive the frame in which
   the new state is painted, or the transition it exists to prevent starts anyway. */
function setAllVisible(checked) {
  grid.classList.add('bulk');
  grid.querySelectorAll('.card:not([hidden]) .pick').forEach(box => { box.checked = checked; });
  updateCount();
  requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.remove('bulk')));
}

// Both act on what is on screen; a filtered-out type is left untouched rather than silently selected.
document.querySelector('#all').onclick = () => setAllVisible(true);
document.querySelector('#none').onclick = () => setAllVisible(false);

saveButton.onclick = async () => {
  const chosen = selected();
  if (!chosen.length) return setStatus('Select at least one image first.', true);
  if (!window.showDirectoryPicker) return setStatus('Your browser does not support the native folder picker. Open this app in current Chrome or Edge.', true);
  try {
    const folder = await window.showDirectoryPicker({ mode: 'readwrite' });
    saveButton.disabled = true;
    for (let i = 0; i < chosen.length; i++) {
      setStatus(`Saving ${i + 1} of ${chosen.length}…`);
      const image = chosen[i]; const response = await fetch(`/api/image/${image.id}`);
      if (!response.ok) throw new Error(`Could not read ${image.name}. Scan again and retry.`);
      const file = await folder.getFileHandle(image.name, { create: true });
      const writable = await file.createWritable(); await writable.write(await response.blob()); await writable.close();
    }
    setStatus(`Saved ${chosen.length} image${chosen.length === 1 ? '' : 's'} to the folder you chose.`);
  } catch (error) {
    if (error.name !== 'AbortError') setStatus(error.message || 'Saving was cancelled.', true);
  } finally { saveButton.disabled = false; }
};
