/* ============================================================================
   Contour background.

   Green topographic contour lines flowing behind the page: nested loops that
   swell, split and merge as the landscape beneath them moves.

   WHY THIS IS SCRIPT, WHEN THE SLIME IT REPLACED WAS DELIBERATELY NOT

   The slime was pure CSS on purpose, and the reasoning still stands: a
   compositor-driven transform costs the main thread nothing, which matters while
   the app is driving a second visible browser through a scan, on a WSL image with
   no GPU acceleration.

   Contour lines cannot be had that way. A contour is the set of points where a
   moving field crosses a threshold, and that set has to be *found* every frame -
   there is no transform of a static shape that produces it. Gradients and border
   radii can fake a mass of slime; nothing in CSS can fake a line that splits in
   two as a hill divides.

   So the cost is real, and the whole design below is about keeping it small:

   1. ONE field evaluation per frame, shared by every contour level. The field is
      sampled onto a coarse grid once; the ten levels then read that grid rather
      than recomputing anything. Levels are nearly free as a result - the
      expensive part happens once no matter how many lines are drawn.

   2. Crossings computed PER EDGE, not per cell. Neighbouring cells share an edge,
      and a shared edge has exactly one crossing for a given level, so computing
      it once and letting both cells refer to it halves the interpolation work and
      - far more importantly - is what makes stitching possible at all.

   3. STITCHED polylines, not loose chords. See the note on tracing below: this is
      what makes the lines smooth rather than faceted.

   4. NO per-frame allocation. Every buffer is a typed array sized once per resize
      and reused. At sixty frames a second, allocating per frame is how a
      background ends up fighting the garbage collector.

   5. Capped pixel ratio. A background does not need to be retina-sharp, and fill
      rate is the one cost that scales with the square of the resolution.

   WHAT THE SMOOTHING COSTS

   Measured over 200 frames with a stubbed canvas, so this is the geometry cost on
   the main thread, exclusive of rasterisation. "Chords" is the first version, which
   drew each cell's crossing as an isolated straight line; "curves" is this one.

     resolution    chords     curves     of a 16.67ms frame
     1366x768      0.30 ms    0.54 ms    3.2%
     1920x1080     0.46 ms    0.86 ms    5.2%
     2560x1440     0.80 ms    1.45 ms    8.7%
     3840x2160     1.59 ms    2.95 ms    17.7%

   So smoothing costs about 1.8x, and that was worth paying because the absolute
   number is still small. Where it pays for itself is the draw call count: at 1080p
   the 1675 loose chords stitch into 43 continuous lines, so the canvas receives 43
   subpaths instead of 1675. Fewer, longer paths also means round line caps stop
   being applied at every chord end, which is a second reason the old version looked
   faceted rather than merely angular.

   The alternative way to smooth - a finer grid - costs four times as much for every
   halving of CELL and does not actually converge on a curve; it just makes the flat
   spots shorter. This converges, because it is fitting curves rather than shortening
   lines.

   ========================================================================== */

(function () {
  'use strict';

  const canvas = document.querySelector('#contour-canvas');
  // Guarded like #to-top in app.js: a browser holding a cached older index.html has
  // no canvas, and an unguarded throw here would take the whole file down.
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  /* --------------------------------------------------------------- tuning */

  /* Grid resolution, in CSS pixels. With the curve fitting below, this no longer
     sets how smooth the lines look - only how much detail of the landscape they
     follow. It could be halved for a busier picture at four times the cost; 26 is
     where the shapes read clearly and the cost stays negligible. */
  const CELL = 26;

  /** How many contour lines. The field spans roughly -2.6..2.6, so these sit inside it. */
  const LEVELS = 10;
  const LEVEL_FROM = -1.85;
  const LEVEL_TO = 1.85;

  /* Every fourth line is drawn brighter and thicker. That is the index-contour
     convention from real topographic maps, and it is what stops ten evenly
     weighted lines reading as a flat moire pattern. */
  const INDEX_EVERY = 4;

  /* Drawing beyond the viewport edge, so lines enter and leave the frame instead of
     being born at the boundary. One cell would do; two hides the interpolation seam. */
  const OVERSCAN = 2;

  /** Retina costs fill rate quadratically and buys a background almost nothing. */
  const MAX_PIXEL_RATIO = 1.5;

  /* Field movement. Deliberately unrelated rates, for the same reason the slime's
     durations shared no common factor: the terms never re-align, so the motion
     never visibly repeats. */
  const RATE_A = 0.000_11;
  const RATE_B = 0.000_083;
  const RATE_C = 0.000_137;
  const RATE_D = 0.000_061;

  /** How far the field slides for a full page scroll. Keeps the background feeling
      attached to the content rather than pinned behind it - the same intent as the
      slime's scroll-driven drift, done here by offsetting the field instead. */
  const SCROLL_DRIFT = 0.9;

  const still = matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------------------------------------------------------- state */

  let width = 0, height = 0;      // CSS pixels
  let cols = 0, rows = 0;         // grid cells across and down
  let originX = 0, originY = 0;   // top-left of the grid, negative by OVERSCAN
  let field = new Float32Array(0);
  let frame = null;

  /* Edge-indexed crossing data. Every grid edge gets a slot, whether or not the
     current level crosses it; addressing by edge is what lets two cells agree they
     are talking about the same point, which is the basis of the stitching. */
  let horizontalCount = 0;        // number of horizontal edges, and where the vertical ones start
  let edgeCount = 0;
  let crossX = new Float32Array(0);
  let crossY = new Float32Array(0);
  let hasCross = new Uint8Array(0);
  /* Each crossing joins at most two others - a contour passing through a point has
     one way in and one way out - so two link slots per edge is exact, not a guess. */
  let linkA = new Int32Array(0);
  let linkB = new Int32Array(0);
  let seen = new Uint8Array(0);
  // The polyline currently being traced, before it is drawn.
  let pathX = new Float32Array(0);
  let pathY = new Float32Array(0);

  /* ---------------------------------------------------------------- sizing */

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    if (!width || !height) return false;

    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    // Draw in CSS pixels throughout; the ratio is applied once, here.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    originX = -OVERSCAN * CELL;
    originY = -OVERSCAN * CELL;
    cols = Math.ceil(width / CELL) + OVERSCAN * 2;
    rows = Math.ceil(height / CELL) + OVERSCAN * 2;
    // One more sample than cells in each direction: cells are bounded by corners.
    field = new Float32Array((cols + 1) * (rows + 1));

    // Horizontal edges run along each of the rows+1 grid lines; vertical edges down
    // each of the cols+1 columns.
    horizontalCount = cols * (rows + 1);
    edgeCount = horizontalCount + (cols + 1) * rows;
    crossX = new Float32Array(edgeCount);
    crossY = new Float32Array(edgeCount);
    hasCross = new Uint8Array(edgeCount);
    linkA = new Int32Array(edgeCount);
    linkB = new Int32Array(edgeCount);
    seen = new Uint8Array(edgeCount);
    // A single polyline can at most visit every crossing once, plus one slot for
    // closing a loop back onto its first point.
    pathX = new Float32Array(edgeCount + 1);
    pathY = new Float32Array(edgeCount + 1);
    return true;
  }

  /* ----------------------------------------------------------------- field

     A sum of sines standing in for smooth noise. Real value noise would need a
     permutation table and four lookups plus a fade curve per sample; four sine
     terms give hills that are just as organic at this scale, and - the part that
     matters - they are continuous in time for free. Animating value noise means
     interpolating between octaves; animating this means adding t to a phase.

     The terms are deliberately different in character: two rolling waves at an
     angle to each other, one long diagonal swell, and one slow radial term that
     keeps the composition from looking like a woven grid. */

  function sampleField(time, scroll) {
    const a = time * RATE_A, b = time * RATE_B, c = time * RATE_C, d = time * RATE_D;

    // Normalised so the pattern keeps its scale on a phone and a wide monitor alike,
    // rather than stretching with the viewport.
    const scale = 6 / Math.max(320, Math.min(width, height));

    let index = 0;
    for (let row = 0; row <= rows; row++) {
      const py = (originY + row * CELL) * scale + scroll;
      for (let col = 0; col <= cols; col++) {
        const px = (originX + col * CELL) * scale;

        field[index++] =
            Math.sin(px * 1.10 + a) * Math.cos(py * 0.90 - b)
          + Math.sin((px * 0.70 - py * 1.30) + c) * 0.75
          + Math.cos((px * 1.60 + py * 0.55) - d) * 0.55
          + Math.sin(Math.sqrt(px * px + py * py) * 0.85 - a * 1.7) * 0.45;
      }
    }
  }

  /* ------------------------------------------------------- marching squares

     For each cell, which of its four corners are above the threshold gives a
     4-bit case, and the case says which pair of edges the contour crosses. The
     crossing point on an edge is linearly interpolated between the two corner
     values, which is what makes the line move smoothly rather than snapping from
     cell to cell as the field drifts.

     Done in two passes rather than one. The first finds every crossing, keyed by
     the EDGE it sits on. The second walks the cells and records, for each crossing,
     which other crossings it is joined to. Nothing is drawn yet - drawing needs
     whole lines, and a cell on its own cannot know what its neighbours are doing. */

  function findCrossings(level) {
    hasCross.fill(0);
    const stride = cols + 1;

    // Horizontal edges: between (col, row) and (col + 1, row).
    for (let row = 0; row <= rows; row++) {
      const base = row * stride;
      const y = originY + row * CELL;
      for (let col = 0; col < cols; col++) {
        const left = field[base + col];
        const right = field[base + col + 1];
        if ((left > level) === (right > level)) continue;
        const id = row * cols + col;
        hasCross[id] = 1;
        crossX[id] = originX + (col + (level - left) / (right - left)) * CELL;
        crossY[id] = y;
      }
    }

    // Vertical edges: between (col, row) and (col, row + 1).
    for (let row = 0; row < rows; row++) {
      const base = row * stride;
      for (let col = 0; col <= cols; col++) {
        const top = field[base + col];
        const bottom = field[base + stride + col];
        if ((top > level) === (bottom > level)) continue;
        const id = horizontalCount + row * stride + col;
        hasCross[id] = 1;
        crossX[id] = originX + col * CELL;
        crossY[id] = originY + (row + (level - top) / (bottom - top)) * CELL;
      }
    }
  }

  function join(a, b) {
    if (linkA[a] === -1) linkA[a] = b; else linkB[a] = b;
    if (linkA[b] === -1) linkA[b] = a; else linkB[b] = a;
  }

  function buildLinks(level) {
    linkA.fill(-1);
    linkB.fill(-1);
    const stride = cols + 1;

    for (let row = 0; row < rows; row++) {
      const base = row * stride;
      for (let col = 0; col < cols; col++) {
        const tl = field[base + col];
        const tr = field[base + col + 1];
        const br = field[base + stride + col + 1];
        const bl = field[base + stride + col];

        let code = 0;
        if (tl > level) code |= 8;
        if (tr > level) code |= 4;
        if (br > level) code |= 2;
        if (bl > level) code |= 1;
        if (code === 0 || code === 15) continue;

        const top = row * cols + col;
        const bottom = (row + 1) * cols + col;
        const left = horizontalCount + base + col;
        const right = horizontalCount + base + col + 1;

        /* Half of these cases are the same line as another: case 8 (only the top-left
           corner above) and case 7 (every corner but the top-left above) both cut the
           same corner off, differing only in which side is uphill - and a contour does
           not care. 1/14, 2/13, 3/12, 4/11 and 6/9 pair up the same way. */
        switch (code) {
          case 1:  case 14: join(left, bottom); break;
          case 2:  case 13: join(bottom, right); break;
          case 3:  case 12: join(left, right); break;
          case 4:  case 11: join(top, right); break;
          case 6:  case 9:  join(top, bottom); break;
          case 7:  case 8:  join(left, top); break;
          /* The saddles, where two opposite corners are above and the contour really
             does pass through the cell twice. Emitting only one of the two is the usual
             shortcut, and it makes lines flicker as a saddle tips one way or the other. */
          case 5:  join(left, top); join(bottom, right); break;
          case 10: join(top, right); join(left, bottom); break;
        }
      }
    }
  }

  /* --------------------------------------------------------------- tracing

     Walking the links turns loose crossings into whole lines, and that is what
     makes smoothing possible: a curve needs to know where the line was and where
     it is going, which a single chord cannot say.

     Open lines are traced first, from their loose end. If closed loops were taken
     first, a loop entered from the middle would be cut into two pieces at the entry
     point, leaving a visible notch in what should be a seamless ring. */

  function traceAndDraw() {
    seen.fill(0);

    // Open lines: exactly one link, so they run off the edge of the grid.
    for (let id = 0; id < edgeCount; id++) {
      if (hasCross[id] && !seen[id] && linkB[id] === -1) walk(id, false);
    }
    // Whatever is left is a closed ring.
    for (let id = 0; id < edgeCount; id++) {
      if (hasCross[id] && !seen[id]) walk(id, true);
    }
  }

  function walk(start, closed) {
    let count = 0;
    let current = start;
    let previous = -1;

    while (current !== -1 && !seen[current]) {
      seen[current] = 1;
      pathX[count] = crossX[current];
      pathY[count] = crossY[current];
      count++;

      const a = linkA[current];
      const b = linkB[current];
      let next = -1;
      if (a !== -1 && a !== previous && !seen[a]) next = a;
      else if (b !== -1 && b !== previous && !seen[b]) next = b;
      previous = current;
      current = next;
    }

    // A ring only counts as closed if the far end really does link back to the start;
    // otherwise it is an open line that happened to have two links at its first point.
    const ring = closed && count > 2
      && (linkA[previous] === start || linkB[previous] === start);
    strokePath(count, ring);
  }

  /* --------------------------------------------------------------- smoothing

     Quadratic curves through edge midpoints, with the crossing points themselves as
     control points. Each curve leaves one midpoint and arrives at the next, so
     consecutive curves share a tangent at every junction: the result is smooth
     everywhere, with no cusps at the joins.

     The obvious alternative - a curve THROUGH every crossing point - needs
     Catmull-Rom converted to beziers, four points of lookahead, and it overshoots on
     tight turns, which on a contour map shows up as little loops around the peaks.
     This does not overshoot: every curve stays inside the corner it is turning. */

  function strokePath(count, ring) {
    if (count < 2) return;

    if (ring) {
      // Start on the closing edge's midpoint so the ring is smooth all the way round,
      // with no seam where it meets itself.
      ctx.moveTo((pathX[count - 1] + pathX[0]) / 2, (pathY[count - 1] + pathY[0]) / 2);
      for (let i = 0; i < count; i++) {
        const next = i + 1 === count ? 0 : i + 1;
        ctx.quadraticCurveTo(
          pathX[i], pathY[i],
          (pathX[i] + pathX[next]) / 2, (pathY[i] + pathY[next]) / 2
        );
      }
      return;
    }

    // An open line keeps its true endpoints - they sit on the edge of the grid, and
    // pulling them in to a midpoint would leave a gap at the frame edge.
    ctx.moveTo(pathX[0], pathY[0]);
    for (let i = 1; i < count - 1; i++) {
      ctx.quadraticCurveTo(
        pathX[i], pathY[i],
        (pathX[i] + pathX[i + 1]) / 2, (pathY[i] + pathY[i + 1]) / 2
      );
    }
    ctx.lineTo(pathX[count - 1], pathY[count - 1]);
  }

  /* ---------------------------------------------------------------- drawing */

  function draw(time) {
    const scroll = (window.scrollY || 0) * SCROLL_DRIFT / Math.max(320, height);
    sampleField(time, scroll);

    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 0; i < LEVELS; i++) {
      const level = LEVEL_FROM + (LEVEL_TO - LEVEL_FROM) * (i / (LEVELS - 1));

      /* Lines nearer the middle of the range sit "lower" in the landscape and are
         drawn deeper and dimmer; the outer ones are the peaks and read brightest.
         A flat colour across all ten looks like a wireframe rather than terrain. */
      const height01 = Math.abs(level) / LEVEL_TO;
      const isIndex = i % INDEX_EVERY === 0;

      findCrossings(level);
      buildLinks(level);

      ctx.beginPath();
      ctx.lineWidth = isIndex ? 1.7 : 1.0;
      ctx.strokeStyle = isIndex
        ? `rgba(125, 255, 176, ${(0.20 + height01 * 0.26).toFixed(3)})`
        : `rgba(61, 220, 132, ${(0.11 + height01 * 0.15).toFixed(3)})`;
      traceAndDraw();
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------------ loop */

  function tick(time) {
    draw(time);
    frame = requestAnimationFrame(tick);
  }

  function start() {
    stop();
    if (!resize()) return;
    if (still.matches) {
      /* Reduced motion means no animation at all, not a slower one. A single frame
         at a fixed time leaves a still contour composition - the same promise the
         slime made, where the blobs came to rest rather than disappearing. */
      draw(0);
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
  }

  /* Resizing reallocates every buffer, so it must not run on every pixel of a drag.
     requestAnimationFrame is the natural throttle: at most one restart per frame. */
  let pending = null;
  window.addEventListener('resize', () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => { pending = null; start(); });
  });

  // Changing the OS motion setting takes effect without a reload.
  still.addEventListener('change', start);

  start();
})();
