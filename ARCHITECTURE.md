# Page Image Collector — Architecture

A reference for how this app is built and why. Written against the code as it stands;
line references point at `server.js` unless stated otherwise.

---

## 1. What the app does

You give it a web page address. It opens that page in a **real, visible browser it drives
automatically**, scrolls the whole page to trigger lazy-loaded images, captures every image
the page actually downloads, and presents them in a grid. You filter by file type, tick the
ones you want, and save them to a folder with the browser's native folder picker.

It runs entirely on your own machine. Nothing is uploaded anywhere.

## 2. Constraints that shape the design

These are the non-negotiables the whole design falls out of:

| Constraint | Consequence |
|---|---|
| Must not be hosted online | Binds `127.0.0.1` only (`server.js:230`) |
| Must not download a browser on Windows/macOS | Uses `playwright-core`, not `playwright`, and hunts for installed Chrome/Edge |
| Must catch lazy-loaded images | Needs a real browser that scrolls, not an HTTP fetch of the HTML |
| Must save real files to a real folder | Needs the File System Access API, so needs a Chromium-family browser |

## 3. Stack

- **Node.js** — the local server process
- **Express 4** — static file serving and three JSON endpoints
- **playwright-core** — browser automation, deliberately the `-core` package which contains
  **no bundled browsers**, so installing it downloads nothing
- **Vanilla JavaScript front-end** — no framework, no build step; three files in `public/`
- **@yao-pkg/pkg** (dev only) — packages everything into a single executable

There is no database, no ORM, no bundler for the front-end, and no test framework.

## 4. File layout

```
server.js               Entire backend: browser automation + 3 endpoints (236 lines)
public/index.html       Single-screen UI
public/app.js           Front-end logic: scan, poll, render, filter, save
public/style.css        All styling (one minified line)
package.json            Deps, npm scripts, pkg configuration
start-wsl.sh            Launcher for WSL/Linux (sources nvm, checks prerequisites)
Start Image Collector.bat      Windows launcher (requires installed Node.js)
Start Image Collector.command  macOS launcher
package-windows.sh      Builds the single-file Windows .exe
.wsl-browser-libs/      Unpacked .deb payloads: Linux browser libraries (WSL only)
dist/                   Build output
README.md               How to run it
WSL-COMPATIBILITY.md    Why the WSL setup looks the way it does
ARCHITECTURE.md         This file
```

## 5. Process model

Running the app produces up to **three** processes:

1. **The Node server** — holds all state, listens on `127.0.0.1:3719`
2. **The UI browser** — opened automatically at startup (`server.js:234`); this is where you
   click things. Its native folder picker decides where saved files can go.
3. **The automated browser** — launched per scan, visibly scrolls the target page, closed when
   the scan finishes (`server.js:218`)

The port `3719` is hard-coded (`server.js:8`). Two copies cannot run at once; the second gets
`EADDRINUSE`.

## 6. The scan pipeline

This is the heart of the app. `POST /api/scan` runs six stages in order.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ 0. Guard    single scan at a time; validate URL and limit     │
  ├─────────────────────────────────────────────────────────────┤
  │ 1. Launch   find a browser, launch it VISIBLE                 │
  │             attach the response listener BEFORE navigating    │
  ├─────────────────────────────────────────────────────────────┤
  │ 2. Navigate goto(url), waitUntil domcontentloaded             │
  ├─────────────────────────────────────────────────────────────┤
  │ 3. Scroll   step down the page, pausing 550ms each time,      │
  │             until it stops growing (scrollEverything)         │
  ├─────────────────────────────────────────────────────────────┤
  │ 4. Sweep    read declared image URLs out of the DOM and       │
  │             request any the page never fetched itself         │
  ├─────────────────────────────────────────────────────────────┤
  │ 5. Order    sort captured images into DOM order, name them,   │
  │             return metadata (not bytes) as JSON               │
  └─────────────────────────────────────────────────────────────┘
```

### Stage 0 — the concurrency guard

`currentScan` is a module-level variable doing double duty: a **lock** and the **progress
object**. Non-null means a scan is running, so a second request gets HTTP 409
(`server.js:120`). It is cleared in a `finally` block so a crashed scan cannot wedge the app.

### Stage 1 — launch, listener first

The `response` listener is attached **before** `page.goto()` (`server.js:140` vs `154`). That
ordering is essential: images requested during initial page load would otherwise be missed.

The browser runs with `headless: false`. That is deliberate — some sites decline to run
lazy-loaders when they detect a headless browser, and a visible window makes progress obvious
to the user.

### Stage 3 — scrolling

`scrollEverything()` (`server.js:76`) is more subtle than it looks:

- It scrolls in **steps** of 70% of the viewport rather than jumping to a computed bottom,
  because infinite-scroll pages grow as you descend.
- It also scrolls **inner scrollable elements** — any element with `overflow-y: auto|scroll`
  taller than its own box — because app-style feeds scroll a `div`, not the document.
- The **550ms pause each step is the entire point**. That is the window in which the page's
  `IntersectionObserver` notices new images are near the viewport and requests them. Remove
  the pause and you capture almost nothing.
- It stops only once the page is at the end **and** has stopped growing for **6 consecutive
  steps**, capped at 1,200 steps.

### Stage 4 — the declared-source sweep

Scrolling only catches images the page *chose* to request. Stage 4 catches images the page
merely *mentions*. It reads, for every element:

`src`, `data-src`, `data-lazy-src`, `data-original`, `data-url`, `srcset`, `data-srcset`,
inline `style="...url(...)"`, computed `background-image`, and `img.currentSrc`.

Each unseen URL is then requested **from inside the page** (`server.js:197`) rather than from
Node, so the site's cookies, referrer and origin all apply.

Two details matter:

- **`{ mode: 'no-cors' }` is required.** A default `fetch()` is CORS-mode and is refused by
  any host that sends no `access-control-allow-origin`. An `<img src>` is a *no-cors* load and
  is always permitted — which is why such images display fine but a plain fetch cannot
  retrieve them. The response is opaque to the page, but Playwright reads bodies at the
  **network layer**, so the bytes are still captured.
- **`data:` URLs are decoded directly** (`server.js:182`) since there is nothing to fetch.

### Stage 5 — ordering and naming

Network responses arrive in whatever order the network delivers them, which looks random to a
user. So the sweep's DOM index becomes the sort key (`server.js:202-208`), producing a grid
ordered by position on the page.

`uniqueName()` (`server.js:64`) derives the extension from the **served content type, not the
URL**, because sites routinely serve WebP from a `.jpg` address and a file whose extension
lies will not open cleanly. Names are prefixed `001-`, `002-` … which also guarantees
uniqueness when two URLs share a filename.

## 7. How images are captured — four routes

An image reaches the store by one of four paths. Understanding these explains almost every
"why did/didn't it find that image" question:

| Route | Mechanism | Caught by |
|---|---|---|
| Normal `<img src>` | Page requests it during load | Response listener |
| Lazy-loaded | Page requests it once scrolled into view | Response listener, after scrolling |
| CSS `background-image` | Page requests it when the rule applies | Response listener |
| Declared but never requested | `data-src`/`srcset` with no load | Stage 4 sweep + no-cors fetch |

The key insight: capture is driven by **`Content-Type: image/*` on the network response**
(`server.js:143`), not by parsing HTML. Whatever the page genuinely downloaded gets caught,
however exotic the mechanism.

## 8. Data model and state

All state is **in memory in the Node process**:

```js
imageStore = Map<url, { url, contentType, body: Buffer }>
currentScan = { phase, percent, images, limit } | null
```

Consequences worth knowing:

- Each scan calls `imageStore.clear()` (`server.js:132`), so results are replaced, not merged.
- Restarting the server loses everything; `/api/image/:id` then honestly returns
  *"Image is no longer available. Scan again."*
- Image bytes are held in RAM. At the 5,000-image cap this could be several gigabytes.
- The **image cap counts all types**, so a page dominated by one format can hit the cap before
  other formats are reached. The per-type counts in the UI make that visible.

## 9. HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` and static files | The UI, served from `public/` |
| `POST` | `/api/scan` | Run a scan. Body `{ url, limit }`. Returns image **metadata** |
| `GET` | `/api/scan-progress` | Current `{ phase, percent, images, limit }`; polled every 300ms |
| `GET` | `/api/image/:id` | The image **bytes**. `id` is the URL, base64url-encoded |

`POST /api/scan` returns metadata only — id, name, type, bytes — never image data. The grid
then loads each preview from `/api/image/:id`. This keeps the JSON small and lets the browser
cache and lazily render previews.

The `id` is just `base64url(url)`. It is decoded and used as a **Map key lookup**
(`server.js:224`), never as a filesystem path, so a crafted id cannot escape anywhere — it
either matches a captured URL or 404s.

Error handling is deliberately user-facing: a timeout becomes *"The page took too long to
load"* rather than a stack trace (`server.js:215`).

## 10. Front-end

Four files, no build step, no framework.

State lives in two module-level variables in `public/app.js`:

```js
images      = []        // everything the scan returned
activeTypes = Set()     // which content types are currently shown
```

- **The animated background** (`#contours`) is green topographic contour lines flowing behind
  the page, drawn on a canvas by `public/contours.js`.

  **This is the one place where the app gave up a CSS-only animation on purpose.** The previous
  background was six drifting gradient masses — "slime" — and it was pure CSS precisely because
  it animates while the app drives a second visible browser, on a WSL image that often has no GPU
  acceleration. Those measurements still stand and are worth keeping:

  | Approach | Measured | Verdict |
  |---|---|---|
  | No background at all | 60 fps | the floor to aim for |
  | Gradients, `mix-blend-mode: screen` | 35 fps | rejected — cost 25 fps for no visible change |
  | Gradients, no blend mode | **60 fps** | the slime that shipped before |
  | `filter: blur(28px) contrast(1.5)` | 14 fps | rejected |
  | `filter: blur(60px) contrast(1.9)` | 9 fps | rejected |

  Contours cannot be done that way at all. A contour is wherever a moving scalar field crosses a
  threshold, and that set has to be *found* again every frame — no transform of a static shape
  produces it. So the work moved to a canvas, and the cost is now real rather than zero. Keeping
  it small is the whole design of `contours.js`: one field evaluation per frame shared by all ten
  levels, crossings computed per grid *edge* rather than per cell, and no per-frame allocation.

  Marching squares finds the crossings; they are then **stitched into continuous polylines** and
  drawn as quadratic curves through edge midpoints. The stitching is what makes them smooth — the
  first version drew each cell's crossing as an isolated chord, which looked faceted. Measured
  over 200 frames with a stubbed canvas (geometry only, no rasterisation):

  | Resolution | Loose chords | Stitched curves | Of a 16.67 ms frame |
  |---|---|---|---|
  | 1366×768 | 0.30 ms | 0.54 ms | 3.2% |
  | 1920×1080 | 0.46 ms | **0.86 ms** | 5.2% |
  | 2560×1440 | 0.80 ms | 1.45 ms | 8.7% |
  | 3840×2160 | 1.59 ms | 2.95 ms | 17.7% |

  Smoothing costs about 1.8×, and it pays for itself in draw calls: at 1080p the 1675 loose chords
  stitch into 43 continuous lines, so the canvas receives 43 subpaths rather than 1675. A finer
  grid — the obvious alternative — costs 4× per halving of cell size and never converges on a
  curve; it only shortens the flat spots.

  **The cursor displaces the field — a domain warp.** Near the pointer, each sample reads the
  field from slightly *behind* the direction of travel, so the lines already there are dragged
  along and then relax back. Nothing is added to the field's value, which is the whole point:
  nothing can be erased and no new shape can appear, so the only visible result is existing
  topography moving, the way a liquid's surface does when something is drawn through it.

  **Two earlier attempts were wrong, and measuring is what showed it.** The first raised a hill
  under the cursor; where the field was already high it pushed whole areas above the topmost
  level and the lines there *vanished* instead of moving — **33% less** line under the cursor than
  away from it. The second used a radial ripple, which fixed the erasing (**+107%**) but drew its
  own concentric rings: a bullseye stuck to the cursor, plainly a separate object rather than the
  landscape reacting. Only changing *where the field is sampled* rather than *what it evaluates
  to* does what was actually wanted.

  There is also deliberately **no global parallax lean**. An earlier version slid the whole field
  with the pointer, and a deterministic test — `requestAnimationFrame` replaced by a manual
  stepper, so two runs with identical frame sequences produce byte-identical fields — showed
  **193%** of lit pixels moving on the *far* side of the window from the cursor, as many as beside
  it. That is a rigid translation of everything, the opposite of a liquid, and it drowned the
  local effect. With it gone the same test reads **197% near the cursor, 0.1% far** — genuinely
  local.

  The drag magnitude comes free from the easing: the gap between where the cursor *is* and where
  the eased position has reached is already a velocity signal, opening while the pointer moves and
  closing to zero when it stops. So no velocity tracking, no timestamps, and the lines inherit the
  easing's settle time. The disturbance is centred on the **actual** cursor, not the eased
  position — using the eased one was a bug, since during a quick movement that lag is hundreds of
  pixels and the effect detached from the pointer entirely.

  Position and strength are eased on **elapsed time**, for the reason `progress.js` sets out — a
  per-frame fraction silently runs faster on a 144Hz display — with the frame delta clamped the
  same way so returning to a hidden tab does not teleport anything.

  It costs about **3%** (0.88–0.93 ms still, 0.93–0.95 ms with the cursor moving every frame),
  inside the run-to-run spread. Timing this needed a second attempt: dispatching one pointer move
  reported it as entirely free, because the lag closes after a single frame and the warp switches
  itself off. The warp has compact support and needs no divide, `exp` or square root — the falloff
  uses squared distance only. Under `prefers-reduced-motion` **no pointer listeners are registered
  at all**; cursor tracking is motion.

  Scroll-linked drift survived the move but changed mechanism: it was
  `animation-timeline: scroll()` on the layer, and is now a term added to the field, since the
  field is being recomputed anyway. `prefers-reduced-motion` is honoured **in JavaScript**, not
  CSS — no animation property reaches a canvas being painted from script — by drawing exactly one
  frame and never starting the loop.

  **The base colour lives on `html`, not `body`, and that is load-bearing.** A background on
  `body` is only handed to the page canvas under particular conditions; otherwise it paints as an
  ordinary element background *above* a negative-`z-index` sibling, hiding the whole layer. It
  fails totally and silently — the layer still renders and reports correct geometry — so
  `test/api.test.js` guards it, along with the presence of the canvas and its script.

- **Deselected cards grey out and fade**, driven entirely by CSS — `:has(input:not(:checked))`
  matches whether the box was clicked, toggled by a click anywhere on the card, or set by
  `Select all` / `Select none`, because `:checked` reflects the live property rather than the
  HTML attribute. No JavaScript maintains the state.

  The greyscale amount travels as a **custom property** (`--grey`), which is not decoration:
  `filter` is a single property and does not compose across rules, so a plain
  `filter: grayscale(1)` on the deselected card would be replaced wholesale by the hover rule's
  blur, and a deselected card would spring back to full colour under the pointer. Both filter
  declarations name `grayscale(var(--grey, 0))`, and `.card img` names it even at zero so the
  transition has something to interpolate from.

  **Bulk changes suppress the transition.** Fading and desaturating five hundred cards at once
  is a lurch, not an animation — measured at 500 cards, the worst frame went from ~150 ms
  (fade alone) to ~184 ms (fade plus greyscale). `setAllVisible()` adds `.bulk` to the grid for
  the frame in which the change lands, which brings it to ~136 ms, below the original baseline.
  It takes two nested `requestAnimationFrame` calls to remove: one frame is not enough, because
  the class has to survive the frame that paints the new state or the transition starts anyway.
  Individual clicks still animate. `test/api.test.js` guards both halves, since losing either
  restores the jank without anything looking wrong in a screenshot.
- **The home screen** (`#home-panel`) is what fills the page before a scan: three step cards and
  a note on what cannot be captured. It exists because the page was one form on an empty
  background, which read as unfinished rather than minimal, and because pressing the title needed
  something to return *to*. `app.js` owns its visibility, since only it knows the app's state —
  hidden while a scan runs and once there are results, shown again on reset or when a scan found
  nothing.

  **Recent addresses are the only thing persisted between runs**, in `localStorage` under
  `pic.recent`, capped at six and de-duplicated most-recent-first. This is deliberately the
  address *only*: captured images live in memory and are never written to disk, which is a stated
  promise, and a convenience feature is not reason enough to erode it. A `Clear` control sits
  beside the row, and `test/api.test.js` asserts that `localStorage.setItem` is only ever called
  with `RECENT_KEY` — so the promise is guarded rather than merely intended. `loadRecent()` treats
  storage as hostile: it can be disabled, full, or hold whatever an older version wrote, and a
  broken history degrades to no history rather than a broken page.

  One measured fix went in alongside: `--faint` is **4.02:1** against `--bg`, under the 4.5:1 AA
  minimum at these sizes. The panel note, the `Clear` label and both section labels use `--muted`
  (7.47:1) instead. `.filters-label` was changed too, so *SHOW TYPES* and *RECENT* stay identical.
- **The title is a "start over" control**, and it is a real `<button>` inside the `<h1>` rather
  than a click handler on the heading. Enter, Space, focus handling and the button role then come
  from the platform instead of being written — the same reasoning as using a native `<dialog>`
  for the `{}` panel. The stylesheet's `button` is a green pill, so `#home` uses `all: unset` to
  fall back to the heading's inherited type and drop the pill wholesale; listing the properties
  individually would silently miss anything later added to `button`. That also removes the focus
  ring, which is restated.

  It **refuses to run during a scan**, marked `aria-disabled` for the duration. This is not
  caution: a scan cannot be cancelled — the server allows one at a time and has no abort — so a
  reset mid-scan would be silently undone the moment the in-flight request returned and called
  `renderResults`, which reads as the photos coming back by themselves. The cap and Auto cap are
  deliberately not reset, being settings for the next scan rather than results of the last.
  `clearResults()` is shared with the submit handler, which needs to do exactly the same thing
  before starting a scan.
- **The hover overlay is revealed by `:hover` or `:has(:focus-visible)` — never
  `:focus-within`.** `:focus-within` is the intuitive choice and it is a bug: a mouse click on
  the tick box or on `{}` *focuses* that control, and `:focus-within` stays true after the
  pointer leaves. The overlay therefore sat open after every select and deselect until you
  clicked somewhere else on the page, which read as the card being stuck.

  `:focus-visible` is the distinction the platform already draws — it matches only where focus
  arrived in a way that warrants a visible indicator, which for a checkbox or a button means the
  keyboard, not a click. Measured in Chromium: after a mouse click the box reports
  `focused=true` but `:focus-visible=false`; after tabbing to it, both are true. So keyboard
  users keep the overlay and mouse users get it only while hovering.

  The wrapping `:has()` is required because the focus lands on a *descendant* and there is no
  `:focus-visible-within`. Specificity is unchanged, since `:has()` takes the specificity of its
  most specific argument. The `@media (hover: none)` override has to name the same selector or a
  tabbed-to card blurs on a touch screen. `test/api.test.js` asserts no `.card:focus-within` rule
  comes back, because the symptom is invisible in a screenshot.
- **Progress** is **polled**, not pushed: `setInterval(refreshProgress, 300)`. Simpler than
  WebSockets and adequate for a single local user.
- **The bar is painted every animation frame, not every poll**, and the easing that fills the
  gap lives in `public/progress.js` (`advance(shown, target, dtMs)`) so it can be tested without
  a browser — see `test/progress.test.js`. Three properties matter:
  - It eases on **elapsed time**, not per frame. Moving a fixed fraction of the remaining gap
    per frame secretly depends on the refresh rate, so the bar animated 2.4× faster on a 144 Hz
    display than a 60 Hz one, and every dropped frame became a visible hitch.
  - It is **monotonic**. A page that grows while being scrolled can honestly report a lower
    percentage than before, but a bar that retreats reads as a bug.
  - It **creeps** at most `CREEP_ROOM` (2%) past the reported figure during a stall, so the bar
    never looks frozen. This is the one part that shows motion not backed by real progress, and
    it is bounded to a few pixels for exactly that reason.
- **The server's percentage budget** gives every phase a slice it can move through, because no
  amount of animation can smooth a number that genuinely is not changing:

  | Phase | Range |
  |---|---|
  | Opening the page | 0% |
  | Scrolling through the page | 1 → 80% |
  | Confirming the page stopped growing (`SETTLE_STEPS`) | 80 → 86% |
  | Waiting for the last images to load (fixed 1.5 s) | 86 → 88% |
  | Checking the top of the page again (fixed 1.5 s) | 88 → 90% |
  | Collecting images the page declared (sweep) | 90 → 99% |
  | Finishing up | 99% |
  | Done | 100% |

  Percentages are reported to **one decimal place**. Rounding to whole percent meant the figure
  only changed every few polls, so the bar arrived and parked repeatedly — the choppiness was in
  the number, not the animation. Fixed-length waits are reported by `reportedWait()`, where
  elapsed-over-total is a completely truthful measure of progress.
- **Type filter** chips are built from the results (`buildFilters`), so only types actually
  found appear, each with a count, commonest first.
- **Hiding a type also deselects it.** `selected()` requires both `:checked` **and** an active
  type, so a filtered-out image can never be silently saved.
- **`Select all` / `Select none`** act only on visible cards (`.card:not([hidden])`).
- **Saving** uses `window.showDirectoryPicker()` — the File System Access API — so files are
  written straight into a folder you choose. Unsupported browsers get a clear message rather
  than a broken button.

## 11. Platform handling

`browserCandidates()` (`server.js:21`) returns early per platform, so each OS has an
independent list:

- **Windows** — Chrome and Edge under `PROGRAMFILES`, `PROGRAMFILES(X86)`, `LOCALAPPDATA`
- **macOS** — Chrome and Edge in `/Applications`
- **Linux/WSL** — `/usr/bin/...` system browsers, then **Playwright's own Chromium** as a
  fallback, appended **last** so a real system Chrome wins when present

### Why WSL needs its own path

Windows Chrome is visible from WSL at `/mnt/c/...` and the app would happily *find* it — then
fail to control it. **Playwright drives a browser over Linux process pipes, and WSL interop
cannot pass those to a Windows `.exe`.** So a Linux browser is mandatory for scanning.

That Linux Chromium needs NSS and ALSA libraries absent from this WSL image, which cannot be
installed system-wide without `sudo`. `browserEnvironment()` (`server.js:42`) therefore adds a
project-local `.wsl-browser-libs` directory to `LD_LIBRARY_PATH` — **for browser child
processes only**. It returns `process.env` untouched unless the platform is Linux *and* that
directory exists, which is what keeps Windows and macOS behaviour byte-for-byte unchanged.

A visible browser also needs a display; under WSL that means **WSLg**.

## 12. Packaging

Two shipping formats, both built from WSL:

**Single-file executable** — `./package-windows.sh` → `dist/PageImageCollector.exe`. One file
containing the Node runtime, the app, `node_modules` and the front-end. Nothing to install.

Three non-obvious problems had to be solved, each found by building the same bundle for Linux
and running it locally:

1. **`browsers.json` must be declared as a pkg asset.** playwright-core loads it at runtime
   through its browser registry, so the bundler cannot trace it from source.
2. **playwright-core requires Node's `inspector` at load time**, and pkg's prebuilt runtimes
   are compiled without it. Its only use is `!!inspector.url()` to detect an attached
   debugger, so the build patches that line to fall back to an undefined url — the correct
   answer when no debugger exists. `npm install` overwrites the patch, so the build re-applies
   it each time.
3. **`--no-bytecode` is mandatory.** pkg normally compiles JS to V8 bytecode, which destroys
   `Function.prototype.toString()`. But `page.evaluate(fn)` works by **stringifying your
   callback** and injecting the source into the page — so under bytecode every scan failed
   with `Passed function is not well-serializable!`.

`server.js:11` also derives `APP_DIR` from `process.execPath` when `process.pkg` is set,
because inside a packaged binary `__dirname` points into a **virtual snapshot** rather than the
real filesystem. Embedded assets (`public/`) are correctly read from the snapshot; external
files (`.wsl-browser-libs`) must be located relative to the executable.

## 13. Design decisions and trade-offs

**Capture everything, filter in the UI.** The scan is the expensive part — a minute or more of
scrolling. Filtering at capture time would use less memory and make the cap smarter, but you
would have to re-scan to change your mind. Trade accepted: more RAM, and a cap that counts all
types.

**`playwright-core` over `playwright`.** No 300MB browser download on first run, at the cost
of requiring Chrome or Edge to already exist. On Windows that is free — Edge ships with the OS.

**Visible browser over headless.** Slower and it steals focus, but some sites gate lazy
loading on headless detection, and users can see progress rather than staring at a spinner.

**Polling over WebSockets.** One local user, 450ms updates. A WebSocket would be strictly
better engineering and pointless here.

**Metadata in JSON, bytes over a separate endpoint.** Keeps the scan response small and lets
the browser handle image loading and caching normally.

## 14. Known limitations

- **No cancel button.** `shouldStop()` only fires when the image cap is reached; a scan must
  run to completion.
- **All bytes in RAM**, bounded only by the image cap.
- **One scan at a time**, and one instance per machine (hard-coded port).
- **Performance:** `document.querySelectorAll('*')` plus `getComputedStyle` on every element,
  on every scroll step, is slow on very large pages. In the sweep, the selector
  `'img, source, [style], *'` is redundant — the `*` already matches everything.
- **Sweep fetches are fire-and-forget** with a 600ms grace period, so on a page with hundreds
  of declared-but-unloaded images some may be missed.
- **`.wsl-browser-libs` is architecture- and release-specific** (`x86_64`, this Ubuntu).
- **The `.exe` is unsigned**, so SmartScreen warns, and machines with **WDAC** enforced will
  refuse to run it at all.

## 15. Testing notes

There is no automated test suite. Testing has been manual, driving the real UI with Playwright
and scanning a purpose-built local page that exercises all four capture routes.

Two lessons worth preserving:

- **Kill servers by port, not by process name.** `pkill -f "node server.js"` also matches the
  shell whose command line contains that string.
- **Assert your preconditions.** Twice during development a stale server held port 3719 and
  tests silently measured *old code*, producing confident but wrong conclusions. Tests now
  verify the port is free and that *this* process printed its own startup line before
  proceeding. A test that quietly measures the wrong thing is worse than no test, because it
  looks like evidence.
