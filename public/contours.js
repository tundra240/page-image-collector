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

   WHAT THE POINTER COSTS

   About 3%, which is inside the run-to-run spread. Three runs at 1920x1080, cursor
   still against cursor moving on every single frame:

     cursor still    0.91  0.93  0.88 ms
     cursor moving   0.95  0.93  0.94 ms

   Measuring this correctly took a second attempt. Dispatching one pointer move and
   then timing 200 frames reported the feature as entirely free - but the drag is
   derived from the gap between the cursor and its eased position, so after a single
   frame that gap closes, the warp switches itself off, and the run was timing a
   settled cursor. Moving it every frame is the honest worst case.

   It stays cheap because the warp has COMPACT SUPPORT: samples outside the radius do
   two comparisons and move on, and the ones inside do a handful of multiplies - no
   divide, no exp, and no square root anywhere, since the falloff needs only squared
   distance. The listener does nothing but store two numbers, leaving the
   already-running rAF loop to read them.

   HOW STICKY IT FEELS, AND HOW THAT WAS TUNED

   Mean displacement still remaining in a patch beside the cursor, at intervals after
   the cursor stopped dead. Both columns measured the same way, against a cursor-free
   run of the identical frame sequence:

     after the cursor stops     0ms     100ms    200ms    300ms    500ms
     first attempt             16.0px   14.5px   14.9px   11.8px    6.6px
     now                       17.1px   16.0px   15.2px    8.3px    2.3px

   The first attempt was still a third displaced half a second after the pointer had
   stopped, which is what read as clinging. Halving the settle time gets that down to
   2.3px - the lines follow the cursor and then let go.

   Peak displacement came DOWN at the same time, from about 67px to 43px, while the
   radius went UP. That combination is deliberate: a narrow strong disturbance reads as
   a grip on one spot, a wide gentle one reads as a body of liquid moving. The mean
   above barely changed because the same amount of movement is spread over a wider area.

   Note the metric. An earlier attempt counted changed pixels and was useless - the
   lines are a pixel or two wide, so any residual offset past that pins the figure at
   ~200% whether the lines are 2px or 60px out of place. Distance to the nearest line in
   the undisturbed frame is what actually measures a displacement.
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

  /* ---------------------------------------------------------------- pointer

     The cursor DISPLACES the existing contours rather than adding anything of its own.

     Two earlier attempts got this wrong in instructive ways. The first raised a hill
     under the cursor, which pushed whole areas above the topmost level and erased the
     lines there instead of moving them - measured at 33% LESS line under the cursor
     than away from it. The second replaced the hill with a radial ripple, which fixed
     the erasing (+107% line) but produced its own set of concentric rings: a bullseye
     stuck to the cursor, clearly a separate object drawn on top rather than the
     landscape reacting.

     The fix for both is to stop changing the field's VALUE and change where it is
     SAMPLED FROM - a domain warp. Near the cursor, each sample reads the field from
     slightly behind the direction of travel, so the lines already there are dragged
     along and then settle back. Nothing is added, so nothing can be erased and no new
     shape can appear: the only thing that happens is the existing topography moving,
     the way the surface of a liquid does when something is drawn through it. */

  /* There is deliberately NO global parallax lean. An earlier version slid the whole
     field with the pointer, and a deterministic comparison showed why that was wrong:
     with the lean active, 193% of lit pixels moved in a region on the FAR side of the
     window from the cursor - as many as next to it. That is a rigid translation of
     everything, which is the opposite of a liquid, and it drowned the local effect it
     was supposed to support. The cursor now only ever does local work. */

  /* How strongly the drag displaces the pattern, against the cursor's own movement.
     Raised in step with the shorter settle time below: the drag is derived from the lag
     that easing leaves behind, so halving the settle time halves the lag, and without
     this the effect would have quietly become half as strong at the same time. */
  const POINTER_FLOW = 1.2;

  /* Ceiling on that displacement, in field units. A violent flick produces a lag of
     several hundred pixels, and left unbounded that shears the pattern into streaks -
     the surface tears instead of flowing.

     Tuned down from 1.15 after measuring: at that value a brisk drag moved 192% of the
     lit pixels near the cursor, meaning essentially every line had left where it was.
     Accurate to the physics, far more than "subtle". */
  const POINTER_FLOW_MAX = 0.32;

  /* Reach of the disturbance, in field units. Wide on purpose - a narrow one reads as
     something gripping a spot and pulling it, where a wide one reads as a body of
     liquid moving. This is the main dial for how "magnetic" it feels. */
  const POINTER_RADIUS = 2.9;

  /* Time constant for easing the tracked position toward the real one, in the sense
     used by progress.js: the remaining gap shrinks to about 37% of itself in this
     many milliseconds. Eased on ELAPSED TIME rather than per frame for exactly the
     reason set out there - a per-frame fraction silently runs faster on a 144Hz
     display, and every dropped frame becomes a visible hitch. */
  /* How long the lines take to flow back once the cursor stops.

     This is the dial for "sticky". At 300ms the surface stayed displaced well after the
     pointer had moved on, so the lines read as clinging to it - dragged along like
     something magnetic rather than something being stirred. Halved, they return almost
     as fast as they were pushed, which is what a thin liquid does.

     It has a second effect, which is why the flow constant above moved with it: the drag
     comes from the gap this easing leaves behind, so a shorter settle also means a
     smaller gap. */
  const POINTER_EASE_MS = 150;

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

  /* Pointer state. `target` is where the cursor actually is, in CSS pixels; `shown` is
     the eased position the field is drawn from. Keeping them apart is what stops a fast
     flick across the window from snapping the landscape sideways. */
  let pointerTargetX = 0, pointerTargetY = 0;
  let pointerShownX = 0, pointerShownY = 0;
  /* How much of the effect to apply, 0 to 1, eased like the position. A boolean was not
     enough: switching the drag off the instant the cursor left the window froze the
     lines mid-displacement rather than letting them relax, which reads as the surface
     seizing up. This fades instead, so they always flow back. */
  let pointerTargetStrength = 0;
  let pointerStrength = 0;
  /** Whether the cursor has ever been located, which is when there is a position to snap to. */
  let pointerLocated = false;
  let pointerLast = 0;

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

    /* Where the disturbance is centred, in field units. Put through the SAME transform
       as the samples below, or the lines move somewhere other than under the cursor.

       Centred on where the cursor ACTUALLY is, not on the eased position. Using the
       eased one was a bug: the lag it leaves behind is hundreds of pixels during a
       quick movement, so the disturbance trailed that far behind the pointer and, at
       speed, detached from it completely - measured as no local change at all where
       the cursor had just been. The eased position still has a job, but it is the one
       below: supplying the drag, not the location. */
    const ringX = pointerTargetX * scale;
    const ringY = pointerTargetY * scale + scroll;
    const invR2 = 1 / (POINTER_RADIUS * POINTER_RADIUS);

    /* The drag direction and strength, taken from the gap between where the cursor IS
       and where the eased position has got to.

       That gap is already a velocity signal and costs nothing to obtain: it opens up
       while the pointer is moving and closes to zero once it stops, which is exactly
       the behaviour wanted. No separate velocity tracking, no timestamps, and it
       inherits the easing's settle time - so when the cursor halts, the lines relax
       back over the same couple of hundred milliseconds rather than snapping. */
    let flowX = (pointerTargetX - pointerShownX) * scale * POINTER_FLOW * pointerStrength;
    let flowY = (pointerTargetY - pointerShownY) * scale * POINTER_FLOW * pointerStrength;
    const flow2 = flowX * flowX + flowY * flowY;
    if (flow2 > POINTER_FLOW_MAX * POINTER_FLOW_MAX) {
      // Clamped by length rather than per axis, so a diagonal flick is not allowed to
      // travel further than a straight one.
      const shrink = POINTER_FLOW_MAX / Math.sqrt(flow2);
      flowX *= shrink;
      flowY *= shrink;
    }
    /* Below this the displacement is a small fraction of a pixel. Skipping the whole
       branch is what makes this free while the cursor is still, and free entirely when
       it has never entered the window. */
    const flowing = flow2 > 1e-8;

    let index = 0;
    for (let row = 0; row <= rows; row++) {
      const rowY = (originY + row * CELL) * scale + scroll;
      const dy = rowY - ringY;
      const dy2 = dy * dy;

      for (let col = 0; col <= cols; col++) {
        const colX = (originX + col * CELL) * scale;

        /* The warp. Where a sample READS FROM is shifted, not what it evaluates to -
           so the field's own shape is untouched and the only visible result is the
           contours already there being moved.

           Reading from BEHIND the direction of travel (hence minus) is what drags the
           pattern forward with the cursor. Reading from ahead would push it away,
           which looks like a repelling force rather than something being stirred.

           A squared falloff with COMPACT SUPPORT: it reaches exactly zero at the
           radius rather than trailing off forever. That matters twice - the
           disturbance has a definite edge instead of subtly warping the whole
           picture, and every sample outside the radius skips the work entirely, so
           the cost is paid near the cursor rather than across the grid. No square
           root anywhere in here: the falloff needs only the squared distance. */
        let px = colX;
        let py = rowY;
        if (flowing) {
          const dx = colX - ringX;
          const falloff = 1 - (dx * dx + dy2) * invR2;
          if (falloff > 0) {
            /* Smoothstep rather than the square this used to be, and the difference is
               how magnetic the thing feels. A square peaks to a point directly under the
               cursor, so the strongest displacement is concentrated at one spot and the
               eye reads it as a grip. Smoothstep is flat at BOTH ends - a broad soft
               plateau near the cursor easing to nothing at the rim - so a whole area
               moves together and the shearing happens out in the surrounding ring, which
               is where a liquid's motion actually shows. */
            const weight = falloff * falloff * (3 - 2 * falloff);
            px -= flowX * weight;
            py -= flowY * weight;
          }
        }

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

  /* Eases the drawn pointer position toward the real one.

     Clamped the way progress.js clamps its frame delta and for the same reason:
     requestAnimationFrame stops in a hidden tab, so coming back to one reports a gap
     of seconds. Unclamped, that would teleport the landscape in a single frame. */
  function easePointer(time) {
    const dt = pointerLast ? Math.min(time - pointerLast, 100) : 16;
    pointerLast = time;
    const k = 1 - Math.exp(-dt / POINTER_EASE_MS);
    pointerShownX += (pointerTargetX - pointerShownX) * k;
    pointerShownY += (pointerTargetY - pointerShownY) * k;
    pointerStrength += (pointerTargetStrength - pointerStrength) * k;
  }

  function tick(time) {
    easePointer(time);
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

  /* Pointer tracking.

     The listener does nothing but record two numbers - no drawing, no maths. That is
     deliberate: pointermove fires far more often than the screen refreshes, and doing
     work in it is the classic way to make a page feel heavy. The rAF loop is already
     running, so it reads the latest position when it happens to need it, which is a
     throttle that costs nothing.

     pointermove rather than mousemove so a touch drag moves the landscape too.
     `passive` says this never calls preventDefault, so scrolling is never held up
     waiting for it. */
  if (!still.matches) {
    window.addEventListener('pointermove', event => {
      pointerTargetX = event.clientX;
      pointerTargetY = event.clientY;
      pointerTargetStrength = 1;
      if (!pointerLocated) {
        /* First sighting: put the eased position AT the cursor. Without this the eased
           position starts at the origin, so the gap to the cursor is enormous - and
           since that gap IS the drag, the first frame would shove the landscape halfway
           across the window. */
        pointerShownX = pointerTargetX;
        pointerShownY = pointerTargetY;
        pointerLocated = true;
      }
    }, { passive: true });

    /* Leaving the window fades the drag out rather than cutting it, so the lines finish
       relaxing instead of stopping wherever they had got to. The position is left where
       it was as it fades: returning to roughly the same place then picks up from there
       rather than dragging the surface across the whole window on the way back. */
    document.addEventListener('pointerleave', () => { pointerTargetStrength = 0; });
    // A window that loses focus usually means the cursor is somewhere else entirely.
    window.addEventListener('blur', () => { pointerTargetStrength = 0; });
  }

  // Changing the OS motion setting takes effect without a reload.
  still.addEventListener('change', start);

  start();
})();
