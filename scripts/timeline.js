// Timeline compiler: turns an animation definition plus a playback context into a deterministic function
// of time → exact position and travel direction. Every client evaluates the same function, which is how
// motion stays perfectly in sync without streaming positions over the network.
// No Foundry dependencies (testable in Node).

import {LineLUT, PathLUT, dist, flattenCubic} from "./geometry.js";
import {buildShape} from "./shapes.js";

const EPS = 0.01;
const MAX_UNROLLED_PIECES = 60000;

/** Convert an animation speed to pixels per millisecond. */
export function speedPxPerMs(motion, dims) {
  const v = Math.max(0.001, Number(motion?.speed) || 0);
  switch ( motion?.speedUnit ) {
    case "px": return v / 1000;
    case "units": return (v * (dims.size / dims.distance)) / 1000;
    default: return (v * dims.size) / 1000;
  }
}

/* -------------------------------------------- */
/*  Pieces                                      */
/* -------------------------------------------- */

function lineMove(from, to, speed, step, win) {
  const lut = new LineLUT(from, to);
  return {kind: "move", lut, d0: 0, dir: 1, dist: lut.length, speed, step, connector: true, win};
}

function reversePiece(p) {
  if ( p.kind === "move" ) {
    // Mirror the piece's share of the step so height effects play back exactly in reverse
    const sd0 = p.slen > 0 ? p.slen - p.sd0 - p.dist : p.sd0;
    return {...p, d0: p.d0 + (p.dir * p.dist), dir: -p.dir, liftRev: !p.liftRev, sd0, homing: undefined};
  }
  if ( p.kind === "jump" ) return {...p, from: p.to, to: p.from};
  return {...p};
}

function pieceEnd(p) {
  if ( p.kind === "move" ) return p.lut.pointAt(p.d0 + (p.dir * p.dist));
  if ( p.kind === "jump" ) return p.to;
  return p.pos;
}

function pieceAngle(p, s) {
  const a = p.lut.angleAt(p.d0 + (p.dir * s));
  if ( a === null || a === undefined ) return null;
  return p.dir < 0 ? a + Math.PI : a;
}

/** Traverse one step: returns its start/end points and the move pieces it produces. */
function traverseStep(step, index, baseSpeed, win) {
  const built = buildShape(step.shape);
  const lut = built.lut;
  const L = lut.length;
  const speed = baseSpeed * Math.max(0.01, Number(step.speedMul) || 1);
  if ( (step.shape.type === "point") || (L <= EPS) ) {
    const p = lut.start;
    return {start: p, end: p, moves: [], speed, built};
  }
  const moves = [];
  let start;
  let end;
  if ( built.closed ) {
    const laps = Math.max(0.01, Number(step.laps) || 1);
    const dir = step.reverse ? -1 : 1;
    const d0 = lut.normalize((Number(step.startOffset) || 0) * L);
    const total = laps * L;
    moves.push({kind: "move", lut, d0, dir, dist: total, speed, step: index, sd0: 0, slen: total, win});
    start = lut.pointAt(d0);
    end = lut.pointAt(d0 + (dir * total));
  } else {
    const passes = Math.max(1, Math.round(Number(step.laps) || 1));
    let forward = !step.reverse;
    start = forward ? lut.start : lut.end;
    for ( let k = 0; k < passes; k++ ) {
      moves.push({kind: "move", lut, d0: forward ? 0 : L, dir: forward ? 1 : -1, dist: L, speed, step: index,
        sd0: k * L, slen: passes * L, win});
      end = forward ? lut.end : lut.start;
      forward = !forward;
    }
  }
  return {start, end, moves, speed, built};
}

/** Where a step starts and ends (respecting direction, start offset and laps), plus its built shape. */
export function stepEndpoints(step) {
  const tr = traverseStep(step, 0, 1);
  return {start: tr.start, end: tr.end, built: tr.built};
}

/** Link `from` to `to` with a travel line or a teleport. */
function connect(seq, from, to, mode, speed, step, win) {
  if ( dist(from, to) <= EPS ) return;
  if ( mode === "teleport" ) seq.push({kind: "jump", from, to, step});
  else seq.push(lineMove(from, to, speed, step, win));
}

/**
 * The curved flight of a homing leg from `a` to `b`, as an exact arc-length table.
 * `arc` bows the flight sideways (positive = to the right of travel), as a fraction of its length; `tolerance` is the
 * flattening error in the units of the points (pixels at run time).
 */
export function homingCurve(a, b, arc, tolerance=0.25) {
  const L = dist(a, b);
  const nx = L > 1e-9 ? -(b.y - a.y) / L : 0;
  const ny = L > 1e-9 ? (b.x - a.x) / L : 0;
  const c = {x: ((a.x + b.x) / 2) + (nx * arc * L), y: ((a.y + b.y) / 2) + (ny * arc * L)};
  const c1 = {x: a.x + ((2 / 3) * (c.x - a.x)), y: a.y + ((2 / 3) * (c.y - a.y))};
  const c2 = {x: b.x + ((2 / 3) * (c.x - b.x)), y: b.y + ((2 / 3) * (c.y - b.y))};
  const flat = [a.x, a.y];
  flattenCubic(a, c1, c2, b, tolerance, flat);
  return new PathLUT(flat, false);
}

/**
 * How much a symmetry copy's homing leg bows: copies alternate sides and fan out wider in pairs, so a volley of
 * copies at one target never overlaps.
 */
export function copyArc(arc, i=0, n=1) {
  if ( n <= 1 ) return arc;
  const side = i % 2 ? -1 : 1;
  const fan = 1 + (Math.floor(i / 2) * 0.6);
  return Math.max(-2, Math.min(2, arc * side * fan));
}

/**
 * Build one pass over all enabled steps.
 * @param {object} anim
 * @param {number} baseSpeed                  px per ms
 * @param {object} env
 * @param {{x:number,y:number}} env.originP   The token's start in path space
 * @param {{x:number,y:number}} env.offset    Relative-anchor translation (path space → scene)
 * @param {Function} [env.resolve]            spec → scene point at play time (homing destinations)
 * @param {number} env.grid                   Grid size in px
 */
function buildCycle(anim, baseSpeed, env={}) {
  const seq = [];
  let cursor = null;
  let start = null;
  let lastHoming = null;
  const centers = [];
  const offset = env.offset ?? {x: 0, y: 0};
  anim.steps.forEach((step, index) => {
    if ( step.enabled === false ) return;
    const win = Math.max(0, Number((step.facing ?? anim.facing)?.smoothing) || 0);
    if ( step.shape.type === "homing" ) {
      // A live leg: geometry comes from where everything stood at play time; clients re-aim it every frame
      const spec = step.shape;
      const speed = baseSpeed * Math.max(0.01, Number(step.speedMul) || 1);
      const p0 = cursor ?? env.originP ?? {x: 0, y: 0};
      const endScene = env.resolve?.(spec) ?? null;
      const p1 = endScene ? {x: endScene.x - offset.x, y: endScene.y - offset.y} : p0;
      const lut = homingCurve(p0, p1, spec.arc);
      const d = Math.max(0, lut.length - ((spec.stop || 0) * (env.grid || 100)));
      const from = lastHoming ? {kind: "homing", spec: lastHoming} : {kind: "point", x: p0.x, y: p0.y};
      const homing = {spec, from};
      start ??= p0;
      centers[index] = lut.pointAt(d);
      if ( d > EPS ) seq.push({kind: "move", lut, d0: 0, dir: 1, dist: d, speed, step: index, sd0: 0, slen: d, win, homing});
      const wait = Math.max(0, Number(step.wait) || 0);
      const end = lut.pointAt(d);
      if ( wait > 0 ) seq.push({kind: "wait", dur: wait, pos: end, step: index, hold: homing});
      cursor = end;
      lastHoming = spec;
      return;
    }
    lastHoming = null;
    const tr = traverseStep(step, index, baseSpeed, win);
    centers[index] = tr.built.center;
    if ( cursor ) connect(seq, cursor, tr.start, step.connector, tr.speed, index, win);
    else start = tr.start;
    seq.push(...tr.moves);
    const wait = Math.max(0, Number(step.wait) || 0);
    // A waypoint's height effect (e.g. drop & bounce in place) plays out over its wait
    if ( wait > 0 ) seq.push({kind: "wait", dur: wait, pos: tr.end, step: index, liftWait: !tr.moves.length});
    cursor = tr.end;
  });
  return {seq, start, end: cursor, centers};
}

/* -------------------------------------------- */
/*  Blocks & easing                             */
/* -------------------------------------------- */

/**
 * Group pieces into blocks. Consecutive moves form a "run" travelled without stopping; waits and jumps are stops.
 * Easing ramps are applied at the start and end of each run (only where the run actually starts/ends at a stop).
 */
function makeSection(pieces, {startStop, endStop, easeIn, easeOut, wrap=false}) {
  const blocks = [];
  let run = null;
  const closeRun = () => {
    if ( run ) blocks.push(run);
    run = null;
  };
  for ( const p of pieces ) {
    if ( p.kind === "move" ) {
      if ( p.dist <= 1e-9 ) continue;
      if ( !run ) run = {kind: "run", pieces: [], U: 0, S: 0};
      p.u0 = run.U;
      p.s0 = run.S;
      run.U += p.dist / p.speed;
      run.S += p.dist;
      run.pieces.push(p);
    } else {
      closeRun();
      if ( p.kind === "wait" ) {
        blocks.push({kind: "wait", T: p.dur, pos: p.pos, step: p.step, intro: !!p.intro, liftWait: !!p.liftWait,
          hold: p.hold ?? null});
      }
      else blocks.push({kind: "jump", T: 0, from: p.from, to: p.to, step: p.step});
    }
  }
  closeRun();

  // A cyclic section with no stops at all is one endless run
  const noStops = blocks.every(b => b.kind === "run");
  const firstIsStop = blocks.length ? blocks[0].kind !== "run" : false;
  const lastIsStop = blocks.length ? blocks.at(-1).kind !== "run" : false;

  let t = 0;
  let lastDir = null;
  blocks.forEach((b, i) => {
    b.t0 = t;
    if ( b.kind === "run" ) {
      const isFirst = i === 0;
      const isLast = i === blocks.length - 1;
      const atStartStop = isFirst ? (wrap ? lastIsStop : startStop) : true;
      const atEndStop = isLast ? (wrap ? firstIsStop : endStop) : true;
      configureRun(b, atStartStop ? easeIn : 0, atEndStop ? easeOut : 0);
      b.wrap = wrap && noStops;
      const lp = b.pieces.at(-1);
      b.endDir = pieceAngle(lp, lp.dist);
      b.startDir = pieceAngle(b.pieces[0], 0);
      lastDir = b.endDir;
    } else if ( b.kind === "wait" ) {
      b.dir = lastDir;
    }
    t += b.T;
  });

  // Waits at the start of a wrapping cycle inherit the direction at the end of the cycle
  if ( wrap ) {
    for ( const b of blocks ) {
      if ( b.kind === "run" ) break;
      if ( b.kind === "wait" ) b.dir ??= lastDir;
    }
  }
  return {blocks, T: t};
}

/**
 * Configure a run's velocity profile. Ramps use a cosine velocity curve (zero acceleration jerk at the ends).
 * If the run is too short to reach full speed, the peak speed is reduced so the ramps still fit.
 */
function configureRun(run, rIn, rOut) {
  const U = run.U;
  rIn = Math.max(0, rIn);
  rOut = Math.max(0, rOut);
  if ( (rIn + rOut) === 0 ) {
    Object.assign(run, {rIn: 0, rOut: 0, k: 1, T: U});
    return;
  }
  if ( U >= (rIn + rOut) / 2 ) {
    Object.assign(run, {rIn, rOut, k: 1, T: U + ((rIn + rOut) / 2)});
    return;
  }
  const k = Math.sqrt((2 * U) / (rIn + rOut));
  Object.assign(run, {rIn: rIn * k, rOut: rOut * k, k, T: (rIn + rOut) * k});
}

/** Map real time t within a run to constant-speed time u (the time-warp that implements easing). */
function runU(run, t) {
  const {rIn, rOut, k, T, U} = run;
  if ( t <= 0 ) return 0;
  if ( t >= T ) return U;
  if ( (rIn === 0) && (rOut === 0) ) return t;
  if ( t < rIn ) return k * (t - ((rIn / Math.PI) * Math.sin((Math.PI * t) / rIn))) / 2;
  const cruiseEnd = T - rOut;
  if ( t <= cruiseEnd ) return (k * rIn / 2) + (k * (t - rIn));
  const tb = T - t;
  return U - (k * (tb - ((rOut / Math.PI) * Math.sin((Math.PI * tb) / rOut))) / 2);
}

/** Relative speed (0..1 of full speed) at real time t within a run. */
function runSpeedFactor(run, t) {
  const {rIn, rOut, k, T} = run;
  if ( t < rIn ) return k * (1 - Math.cos((Math.PI * t) / rIn)) / 2;
  if ( t > T - rOut ) return k * (1 - Math.cos((Math.PI * (T - t)) / rOut)) / 2;
  return k;
}

function findLast(arr, key, v) {
  let lo = 0;
  let hi = arr.length - 1;
  if ( hi < 0 ) return -1;
  if ( arr[0][key] > v ) return -1;
  while ( lo < hi ) {
    const m = (lo + hi + 1) >> 1;
    if ( arr[m][key] <= v ) lo = m;
    else hi = m - 1;
  }
  return lo;
}

function runPieceAtDistance(run, s) {
  const i = Math.max(0, findLast(run.pieces, "s0", s));
  return run.pieces[i];
}

function runPointAt(run, s) {
  if ( run.wrap ) s = ((s % run.S) + run.S) % run.S;
  else s = Math.min(Math.max(s, 0), run.S);
  const p = runPieceAtDistance(run, s);
  return p.lut.pointAt(p.d0 + (p.dir * (s - p.s0)));
}

/** Evaluate a section at time t (0 <= t < T). */
function evalSection(section, t, window) {
  const blocks = section.blocks;
  let bi = findLast(blocks, "t0", t);
  if ( bi < 0 ) bi = 0;
  // Skip zero-length blocks (jumps) that share their start time with the next block
  while ( (bi < blocks.length - 1) && (blocks[bi].T === 0) ) bi++;
  const b = blocks[bi];
  if ( !b ) return null;
  if ( b.kind === "wait" ) {
    return {x: b.pos.x, y: b.pos.y, dir: b.dir ?? null, step: b.step, moving: false, intro: b.intro,
      liftFrac: b.liftWait && (b.T > 0) ? Math.min(1, Math.max(0, (t - b.t0) / b.T)) : null,
      homing: b.hold ? {...b.hold, frac: 1} : null};
  }
  if ( b.kind === "jump" ) return {x: b.to.x, y: b.to.y, dir: null, step: b.step, moving: false};

  const local = t - b.t0;
  const u = runU(b, local);
  const pi = Math.max(0, findLast(b.pieces, "u0", u));
  const p = b.pieces[pi];
  const s = Math.min(Math.max((u - p.u0) * p.speed, 0), p.dist);
  const pos = p.lut.pointAt(p.d0 + (p.dir * s));
  let dir;
  window = p.win ?? window;
  if ( window > 0.5 ) {
    const sigma = p.s0 + s;
    const a = runPointAt(b, sigma - (window / 2));
    const c = runPointAt(b, sigma + (window / 2));
    dir = (Math.abs(c.x - a.x) + Math.abs(c.y - a.y)) > 1e-6 ? Math.atan2(c.y - a.y, c.x - a.x) : pieceAngle(p, s);
  } else {
    dir = pieceAngle(p, s);
  }
  const speed = p.speed * runSpeedFactor(b, local);
  let liftFrac = null;
  if ( p.slen > 0 ) {
    liftFrac = Math.min(1, Math.max(0, (p.sd0 + s) / p.slen));
    if ( p.liftRev ) liftFrac = 1 - liftFrac;
  }
  const homing = p.homing ? {...p.homing, frac: p.dist > 0 ? s / p.dist : 1} : null;
  return {x: pos.x, y: pos.y, dir, step: p.step, moving: true, speed, liftFrac, homing};
}

function sectionEnd(section) {
  const b = section.blocks.at(-1);
  if ( !b ) return null;
  if ( b.kind === "run" ) {
    const p = b.pieces.at(-1);
    const e = pieceEnd(p);
    return {x: e.x, y: e.y, dir: b.endDir, homing: p.homing ? {...p.homing, frac: 1} : null};
  }
  if ( b.kind === "jump" ) return {x: b.to.x, y: b.to.y, dir: null};
  return {x: b.pos.x, y: b.pos.y, dir: b.dir ?? null, homing: b.hold ? {...b.hold, frac: 1} : null};
}

/* -------------------------------------------- */
/*  Compilation                                 */
/* -------------------------------------------- */

/**
 * @typedef PlaybackContext
 * @property {{x:number,y:number}} origin   Token centre when playback started (scene space)
 * @property {{size:number,distance:number}} dims  Scene grid size (px) and distance (units)
 * @property {number} [delay=0]             Milliseconds to wait at the origin before starting
 * @property {number} [phase=0]             Cycle offset in ms for endless loops (spread tokens along a loop)
 */

/**
 * Compile an animation into a Timeline.
 * @param {object} anim                 The animation definition
 * @param {PlaybackContext} ctx
 */
export function compileTimeline(anim, ctx) {
  const motion = anim.motion ?? {};
  const v = speedPxPerMs(motion, ctx.dims);
  const easeIn = Math.max(0, Number(motion.easeIn) || 0);
  const easeOut = Math.max(0, Number(motion.easeOut) || 0);

  // Anchor: absolute paths are run where drawn; relative paths are moved so they begin at the token.
  // A leading homing leg starts from the token itself, so it never shifts the path.
  const relative = motion.anchor === "relative";
  const firstStep = anim.steps.find(st => st.enabled !== false);
  const firstStart = firstStep && (firstStep.shape.type !== "homing") ? stepEndpoints(firstStep).start : null;
  const offset = relative && firstStart ? {x: ctx.origin.x - firstStart.x, y: ctx.origin.y - firstStart.y} : {x: 0, y: 0};
  const originP = {x: ctx.origin.x - offset.x, y: ctx.origin.y - offset.y};
  const cyc = buildCycle(anim, v, {originP, offset, resolve: ctx.resolve, grid: ctx.dims.size});
  const window = Math.max(0, Number(anim.facing?.smoothing) || 0);
  const tl = new Timeline();
  tl.window = window;
  tl.centers = cyc.centers;
  const firstMove = cyc.seq.find(p => (p.kind === "move") && (p.dist > 1e-9));
  tl.startDir = firstMove ? pieceAngle(firstMove, 0) : null;

  // No steps: stay put
  if ( !cyc.start ) {
    tl.offset = {x: 0, y: 0};
    tl.origin = {...ctx.origin};
    tl.prefix = {blocks: [], T: 0};
    tl.final = {x: ctx.origin.x, y: ctx.origin.y, dir: null, returned: false};
    tl.duration = 0;
    return tl;
  }

  tl.offset = offset;
  tl.origin = {...ctx.origin};
  tl.startPos = {x: cyc.start.x + offset.x, y: cyc.start.y + offset.y};

  // Loop structure
  const loopMode = motion.loop ?? "none";
  let count = loopMode === "none" ? 1 : Math.max(0, Math.round(Number(motion.loopCount) || 0));
  let infinite = (loopMode !== "none") && (count === 0);
  const gap = Math.max(0, Number(motion.loopGap) || 0);
  let cycleSeq = cyc.seq;
  if ( loopMode === "pingpong" ) {
    cycleSeq = cyc.seq.concat(cyc.seq.slice().reverse().map(reversePiece));
  }
  const cycleEnd = loopMode === "pingpong" ? cyc.start : cyc.end;
  const firstStepIndex = anim.steps.findIndex(s => s.enabled !== false);
  const between = [];
  const firstWin = Math.max(0, Number((anim.steps[firstStepIndex]?.facing ?? anim.facing)?.smoothing) || 0);
  if ( loopMode === "loop" ) connect(between, cycleEnd, cyc.start, motion.loopConnector, v, firstStepIndex, firstWin);
  if ( gap > 0 ) between.push({kind: "wait", dur: gap, pos: cyc.start, step: firstStepIndex});

  // Intro: initial delay and the approach to the start of the path
  const delay = Math.max(0, Number(ctx.delay) || 0);
  const intro = [];
  if ( delay > 0 ) intro.push({kind: "wait", dur: delay, pos: originP, step: -1, intro: true});
  const ease = {easeIn, easeOut};

  // A loop that takes no time (e.g. a single waypoint without a wait) can't repeat: play it once instead
  const steadySeq = cycleSeq.concat(between);
  const steady = infinite ? makeSection(steadySeq.map(p => ({...p})), {...ease, wrap: true, startStop: false, endStop: false}) : null;
  if ( infinite && !(steady.T > 0) ) {
    infinite = false;
    count = 1;
  }

  if ( infinite ) {
    // Endless loops run on a shared cycle clock: cycle time = (time since joining + phase) mod cycle length.
    // Tokens spread along a loop therefore keep exact spacing no matter how far each had to travel to join.
    tl.steady = steady;
    const phase = tl.steady ? ((Number(ctx.phase) || 0) % steady.T + steady.T) % steady.T : 0;
    tl.shift = phase;
    let target = cyc.start;
    if ( tl.steady ) {
      const e = evalSection(steady, phase, 0);
      if ( e ) target = {x: e.x, y: e.y};
    }
    if ( !relative ) connect(intro, originP, target, motion.approach, v, -1);
    tl.prefix = makeSection(intro.map(p => ({...p})), {...ease, startStop: true, endStop: false});
    // Without an approach run there is nothing to accelerate on, so ease the loop itself in from rest
    const approaches = tl.prefix.blocks.some(b => b.kind === "run");
    tl.startRamp = !approaches ? easeIn : 0;
    tl.joinTime = tl.prefix.T;
    tl.duration = Infinity;
    tl.infinite = true;
  } else {
    if ( !relative ) connect(intro, originP, cyc.start, motion.approach, v, -1);
    const seq = intro.slice();
    const cycles = Math.max(1, count);
    for ( let k = 0; k < cycles; k++ ) {
      // Every cycle needs its own copies: pieces are annotated with timing when the section is built
      if ( k > 0 ) for ( const p of between ) seq.push({...p});
      for ( const p of cycleSeq ) seq.push({...p});
      if ( seq.length > MAX_UNROLLED_PIECES ) break;
    }
    // Finish: stay, travel back to the origin, or teleport back
    const finish = motion.finish ?? "stay";
    const lastEnd = seq.length ? pieceEnd(seq.at(-1)) : cyc.end;
    if ( finish === "return" ) connect(seq, lastEnd, originP, "travel", v, -1);
    else if ( finish === "teleport" ) connect(seq, lastEnd, originP, "teleport", v, -1);
    tl.prefix = makeSection(seq, {...ease, startStop: true, endStop: true});
    tl.duration = tl.prefix.T;
    tl.infinite = false;
    const end = sectionEnd(tl.prefix) ?? {x: originP.x, y: originP.y, dir: null};
    tl.final = {x: end.x + offset.x, y: end.y + offset.y, dir: end.dir, returned: finish !== "stay",
      homing: finish === "stay" ? end.homing ?? null : null};
  }
  return tl;
}

/* -------------------------------------------- */
/*  Timeline                                    */
/* -------------------------------------------- */

export class Timeline {
  prefix = {blocks: [], T: 0};
  steady = null;
  shift = 0;
  startRamp = 0;
  joinTime = 0;
  infinite = false;
  duration = 0;
  offset = {x: 0, y: 0};
  origin = {x: 0, y: 0};
  startPos = null;
  final = null;
  window = 0;
  centers = [];
  startDir = null;

  /**
   * Evaluate the timeline at playback time tau (ms).
   * @returns {{x:number, y:number, dir:number|null, step:number, done:boolean, moving:boolean, before:boolean,
   *   speed?:number}}
   */
  evaluate(tau) {
    if ( !(tau > 0) ) {
      return {x: this.origin.x, y: this.origin.y, dir: null, step: -1, done: false, moving: false, before: true};
    }
    let r = null;
    if ( tau < this.prefix.T ) r = evalSection(this.prefix, tau, this.window);
    else if ( this.steady ) {
      let ts = tau - this.prefix.T;
      const ramp = this.startRamp;
      if ( ramp > 0 ) ts = ts < ramp ? (ts - ((ramp / Math.PI) * Math.sin((Math.PI * ts) / ramp))) / 2 : ts - (ramp / 2);
      const t = ((ts + this.shift) % this.steady.T + this.steady.T) % this.steady.T;
      r = evalSection(this.steady, t, this.window);
    } else if ( this.final ) {
      return {x: this.final.x, y: this.final.y, dir: this.final.dir, step: -1, done: true, moving: false,
        returned: this.final.returned, homing: this.final.homing ?? null};
    }
    if ( !r ) return {x: this.origin.x, y: this.origin.y, dir: null, step: -1, done: !this.infinite, moving: false};
    r.x += this.offset.x;
    r.y += this.offset.y;
    r.done = false;
    r.before = !!r.intro && (r.step === -1);
    return r;
  }

  /** Centre of the shape of a step, in scene space. */
  stepCenter(index) {
    const c = this.centers[index];
    if ( !c ) return null;
    return {x: c.x + this.offset.x, y: c.y + this.offset.y};
  }

  /** Duration of one steady cycle (endless loops) or of the whole run. */
  get cycleDuration() {
    return this.steady ? this.steady.T : this.duration;
  }
}
