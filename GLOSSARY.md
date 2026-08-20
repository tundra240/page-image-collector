# Glossary

Terms introduced while building this project, grouped by the part of the system they belong to.
Each one is defined once here so it can be used as the real term everywhere else.

---

## The browser and the page

**DOM** — Document Object Model. The live, in-memory tree of objects a browser builds from a
page's HTML. Every tag becomes an element in the tree, and each element knows its parent, its
children, its attributes and — once layout has run — where it sits and how big it is. JavaScript
running on a page reads and changes this tree, not the original HTML text. When you hear "the
DOM", read it as "the page as the browser currently holds it".

**CSS selector** — a pattern that identifies elements in the DOM, such as
`section.gallery > figure:nth-of-type(2) > img`. A dot means a class, `#` means an id, `>` means
"direct child of", and `:nth-of-type(2)` means "the second one of that tag among its siblings".
Used for styling, and in this project also as a written address for a single element.

**getBoundingClientRect()** — a DOM method returning an element's size and its position relative
to the *visible window*. Add `window.scrollY` to convert that into a position on the whole
document. Calling it can force the browser to compute layout on the spot, so it is not free and
should not be called in a tight loop over every element.

**event bubbling** — after an event fires on the element you actually interacted with, the browser
fires it again on that element's parent, then its grandparent, and so on up to the document. It is
what lets a single handler on a container respond to clicks on anything inside it, and what makes
guards necessary when some of those inner things have jobs of their own.

**closest()** — a DOM method that searches from an element upwards through its ancestors for the
first one matching a selector. The standard way to ask "did this click land inside a control?"

**:focus-within** — a CSS pseudo-class matching an element when it, or anything inside it,
currently has keyboard focus. The keyboard's equivalent of `:hover`, and the reason a hover-only
interface can still be reached without a mouse.

**pointer-events** — a CSS property controlling whether an element can be clicked at all. Set to
`none`, clicks pass straight through it to whatever is underneath.

**data URL** — an address that carries the data itself rather than pointing at a file, beginning
`data:image/png;base64,...`. Used for small images so a page needs one fewer request.

---

## Talking to a page you did not write

**CORS** — Cross-Origin Resource Sharing. The browser's rule that a page may not read data it
fetched from another site unless that site's response says it may. Note the word *read*: a page
can freely *display* an image from anywhere, which is why `fetch(url, { mode: 'no-cors' })` is
used in the scan — it loads the image the way an `<img>` tag would, without asking for permission
to read it.

**hotlink protection** — a site refusing to serve an image when the request did not come from one
of its own pages. Why this app's "open in a new tab" control points at its own captured copy
rather than at the original address.

**lazy loading** — a page deliberately not loading an image until it is about to come into view.
It is the reason the scan has to scroll the whole page rather than just reading the HTML.

---

## Progress bar smoothing

**Interpolation** — filling in values between two known ones. The server reports a percentage
a few times a second; the bar is drawn 60+ times a second. Interpolation invents the
in-between positions so the bar glides instead of jumping.

**`requestAnimationFrame` (rAF)** — a browser function that runs your code once before the next
screen repaint, and hands you a timestamp. Better than `setInterval` for animation because it
matches the display and pauses in hidden tabs.

**Frame rate / Hz** — how many times a second the display refreshes. 60 Hz is common, 144 Hz on
gaming monitors. Animation code that moves a fixed amount *per frame* runs 2.4× faster on the
latter — a bug, and the main one this change fixed.

**Exponential easing** — moving a proportion of the remaining distance each time, so motion
starts fast and slows as it arrives. Feels natural because it never stops abruptly.

**Time constant** — the tuning number for exponential easing: the time in which the remaining
gap shrinks to about 37% of its size. Smaller means snappier. Written as
`1 - Math.exp(-dt / timeConstant)`, which is exact for any step size — this is *why* easing on
elapsed time removes the frame-rate dependence.

**Asymptote** — a value something approaches forever without reaching. Exponential easing never
mathematically arrives, which is why the code snaps to the target once within `SNAP` of it.

**Monotonic** — only ever moving one way, never back. The progress bar is deliberately monotonic:
a page that grows while being scrolled can honestly report a *lower* percentage than a moment
ago, but a bar that goes backwards reads as broken.

**Quantisation** — losing detail by rounding to steps. Reporting whole percentages quantised the
progress figure so it only changed every few polls; sending one decimal place removed it.

**Polling** — asking "any news?" on a timer, rather than being told when something happens
(*pushing*, e.g. WebSockets). Simpler, and fine for one local user.

---

## Rendering and animation

**compositor** — the part of the browser that assembles already-painted layers into the final
picture, usually on the GPU. Moving a layer with `transform` is a compositor job and is cheap;
changing width or colour forces a repaint first, which is not.

**stacking context** — a self-contained group deciding what paints in front of what. Certain
properties silently create one, including `transform`, `opacity` below 1, `filter`, `isolation`
and `mix-blend-mode`. Most z-index confusion comes from a stacking context nobody meant to make.

**canvas background propagation** — the rule that a background set on `body` is normally handed
to the page canvas and painted beneath everything. It only applies under particular conditions;
otherwise body's background paints as an ordinary element background, which sits *above* a
sibling with a negative `z-index`. This hid the entire background layer, and the symptom —
everything rendering correctly but nothing being visible — gave no hint of the cause.

**`mix-blend-mode`** — how an element's colours combine with what is behind it. `screen`
brightens where layers overlap, so it looks additive. It also stops the layer being animated as a
pure compositor transform: here it halved the frame rate while looking, at these alphas over a
near-black page, identical to plain alpha compositing.

**scroll-driven animation** — `animation-timeline: scroll()`, which ties an animation's progress
to scroll position rather than to time. Runs on the compositor with no JavaScript, so it replaces
a scroll listener that would otherwise need throttling through `requestAnimationFrame`.

**`vmax` / `vmin`** — units equal to the larger (or smaller) of the viewport's width and height,
so a size stays proportional on both a tall phone and a wide monitor.

**contrast ratio** — a measure of how distinguishable text is from its background, from 1:1 to
21:1. WCAG asks for at least 4.5:1 for normal text. Worth measuring rather than eyeballing: the
intro text over the background came out at 4.64:1, which passes but leaves little room on a
background that is moving.

---

## Interface behaviour

**debounce** — waiting for a pause before acting on repeated input, rather than reacting to every
keystroke. The address preview is debounced by 350 ms: without it, typing `www.example.com` made
the preview flicker through `https://www./`, `https://www.e/` and so on, because every half-typed
fragment is a hostname that can technically be completed.

**placeholder** — the greyed-out example text inside an empty input. Easy to underestimate: it is
read as an instruction, so a placeholder of `https://example.com/page` made the scheme look
compulsory when it never was.

**`aria-live`** — an attribute telling a screen reader to announce an element when its contents
change, without moving the user's focus. Set to `polite`, it waits for a natural pause instead of
interrupting.

---

## Building and testing

**fixture** — a small, deliberately-built piece of test data. In this project, a web page written
specifically so that the right answer is known before the test runs.

**design token** — a named value, such as `--green` or `--mono`, defined in one place and referred
to everywhere else, so the look can be changed centrally rather than hunted down.

**worktree** — a second working copy of the same git repository, checked out to a different branch
in a different folder. Lets work happen on a branch without disturbing the main copy.

**Test-driven development (TDD)** — write the failing test first, then the code that passes it.
The test is a specification you can run.

**Red / green** — a failing test is "red", a passing one "green". "Red for the right reason"
means it failed because the feature is missing, not because the test itself is broken.

**Testability seam** — a deliberate place where code is split so it can be tested in isolation.
`public/progress.js` is one: pulling the easing maths out of the animation loop made it testable
without a browser at all.

**Pure function** — same inputs always give the same output, and it changes nothing outside
itself. Trivial to test, because there is no setup and nothing to clean up.

**Test harness** — the scaffolding a test uses to drive the code (here, `simulate()`, which
replays frames). Worth remembering that the harness can be the buggy part: a red test is
evidence something is wrong, not proof it is the *code* that is wrong.

**Precondition** — something that must be true before a script may proceed. A failed
precondition must **stop the script**, not print a warning and continue.

**regression test** — a test written to make sure something that once worked does not quietly
stop working later. A *regression* is the bug itself: something that used to work and no longer
does. The error-catalogue tests are regression tests — they fail if a code is documented but
missing, or reported but undocumented — and so is the guard that keeps the URL field as
`type="text"`, because native validation once silently disabled the URL repair.
