// Shape builders: turn a shape definition into an exact arc-length lookup table plus editing metadata.
// No Foundry dependencies (testable in Node).

import {FLATTEN_TOLERANCE} from "./const.js";
import {PathLUT, TAU, clamp, dist, flattenCubic, rotateAround, toRad} from "./geometry.js";

/** Handle length factor that turns 4 evenly spaced fully-smooth nodes into a near-perfect circle. */
export const SMOOTH_K = 0.39;

/* -------------------------------------------- */
/*  Defaults                                    */
/* -------------------------------------------- */

/** Create a node for a path shape. */
export function makeNode(x, y, extra={}) {
  return {x, y, smooth: 0, bend: 0, mode: "auto", hin: null, hout: null, ...extra};
}

/** Fill in missing fields of a shape definition. Returns a new object. */
export function normalizeShape(shape) {
  const s = {...shape};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  switch ( s.type ) {
    case "path":
      s.closed = !!s.closed;
      s.nodes = (s.nodes ?? []).map(n => ({
        x: num(n.x, 0), y: num(n.y, 0),
        smooth: clamp(num(n.smooth, 0), 0, 1),
        bend: clamp(num(n.bend, 0), -2, 2),
        mode: n.mode === "manual" ? "manual" : "auto",
        hin: n.hin ? {x: num(n.hin.x, 0), y: num(n.hin.y, 0)} : null,
        hout: n.hout ? {x: num(n.hout.x, 0), y: num(n.hout.y, 0)} : null
      }));
      break;
    case "ellipse":
      s.cx = num(s.cx, 0); s.cy = num(s.cy, 0);
      s.rx = Math.max(1, num(s.rx, 100)); s.ry = Math.max(1, num(s.ry, s.rx));
      s.rotation = num(s.rotation, 0);
      s.sweep = clamp(num(s.sweep, 360), 1, 360);
      break;
    case "rect":
      s.cx = num(s.cx, 0); s.cy = num(s.cy, 0);
      s.w = Math.max(1, num(s.w, 200)); s.h = Math.max(1, num(s.h, 200));
      s.rotation = num(s.rotation, 0);
      s.radius = clamp(num(s.radius, 0), 0, Math.min(s.w, s.h) / 2);
      break;
    case "polygon":
      s.cx = num(s.cx, 0); s.cy = num(s.cy, 0);
      s.radius = Math.max(1, num(s.radius, 100));
      s.sides = clamp(Math.round(num(s.sides, 6)), 3, 48);
      s.rotation = num(s.rotation, 0);
      s.star = clamp(num(s.star, 0), 0, 0.95);
      s.smooth = clamp(num(s.smooth, 0), 0, 1);
      break;
    case "spiral":
      s.cx = num(s.cx, 0); s.cy = num(s.cy, 0);
      s.r0 = Math.max(0, num(s.r0, 20)); s.r1 = Math.max(1, num(s.r1, 200));
      s.turns = clamp(num(s.turns, 3), 0.1, 50);
      s.rotation = num(s.rotation, 0);
      s.ccw = !!s.ccw;
      break;
    case "wave":
      s.x0 = num(s.x0, 0); s.y0 = num(s.y0, 0); s.x1 = num(s.x1, 300); s.y1 = num(s.y1, 0);
      s.amplitude = num(s.amplitude, 50);
      s.wavelength = Math.max(4, num(s.wavelength, 200));
      s.form = s.form === "zigzag" ? "zigzag" : "sine";
      break;
    case "figure8":
      s.cx = num(s.cx, 0); s.cy = num(s.cy, 0);
      s.w = Math.max(2, num(s.w, 300)); s.h = Math.max(2, num(s.h, 150));
      s.rotation = num(s.rotation, 0);
      break;
    case "point":
      s.x = num(s.x, 0); s.y = num(s.y, 0);
      break;
    case "homing":
      // A leg to a live destination: a targeted token, the token's start, the anchor token or a specific token
      s.to = ["target", "home", "anchor", "token"].includes(s.to) ? s.to : "target";
      s.index = Math.max(0, Math.round(num(s.index, 0)));
      s.tokenId = typeof s.tokenId === "string" ? s.tokenId : null;
      s.arc = clamp(num(s.arc, 0.25), -2, 2);
      s.stop = Math.max(0, num(s.stop, 0));
      break;
    default:
      throw new Error(`Unknown shape type "${s.type}"`);
  }
  return s;
}

/* -------------------------------------------- */
/*  Path (Bézier) helpers                       */
/* -------------------------------------------- */

/**
 * Compute the in/out handle offsets of node i (relative to the node).
 * Auto nodes derive their handles from their neighbours and their smoothness; manual nodes use stored handles.
 */
export function nodeHandles(nodes, i, closed) {
  const n = nodes.length;
  const node = nodes[i];
  if ( node.mode === "manual" ) {
    return {hin: node.hin ?? {x: 0, y: 0}, hout: node.hout ?? {x: 0, y: 0}};
  }
  const prev = i > 0 ? nodes[i - 1] : (closed ? nodes[n - 1] : null);
  const next = i < n - 1 ? nodes[i + 1] : (closed ? nodes[0] : null);
  const s = node.smooth ?? 0;
  if ( !prev || !next || (s <= 0) ) return {hin: {x: 0, y: 0}, hout: {x: 0, y: 0}};
  let dx = next.x - prev.x;
  let dy = next.y - prev.y;
  const len = Math.hypot(dx, dy);
  if ( len < 1e-9 ) return {hin: {x: 0, y: 0}, hout: {x: 0, y: 0}};
  dx /= len;
  dy /= len;
  const kOut = dist(node, next) * SMOOTH_K * s;
  const kIn = dist(prev, node) * SMOOTH_K * s;
  return {hin: {x: -dx * kIn, y: -dy * kIn}, hout: {x: dx * kOut, y: dy * kOut}};
}

/** Cubic Bézier control points for every segment of a path shape. */
export function pathCurves(shape) {
  const nodes = shape.nodes;
  const n = nodes.length;
  const closed = shape.closed && (n >= 2);
  const segCount = closed ? n : n - 1;
  const handles = nodes.map((_node, i) => nodeHandles(nodes, i, closed));
  const curves = [];
  for ( let i = 0; i < segCount; i++ ) {
    const j = (i + 1) % n;
    const a = nodes[i];
    const b = nodes[j];
    const c1 = {x: a.x + handles[i].hout.x, y: a.y + handles[i].hout.y};
    const c2 = {x: b.x + handles[j].hin.x, y: b.y + handles[j].hin.y};

    // Segment bend: bulge the segment sideways (bend 1 ≈ a half circle on the right of travel)
    const bend = a.bend ?? 0;
    if ( bend ) {
      const L = dist(a, b);
      if ( L > 1e-9 ) {
        const nx = -(b.y - a.y) / L;
        const ny = (b.x - a.x) / L;
        const off = (2 / 3) * bend * L;
        c1.x += nx * off; c1.y += ny * off;
        c2.x += nx * off; c2.y += ny * off;
      }
    }
    curves.push({p0: {x: a.x, y: a.y}, c1, c2, p3: {x: b.x, y: b.y}, index: i});
  }
  return {curves, handles, closed};
}

/* -------------------------------------------- */
/*  Parametric sampling                         */
/* -------------------------------------------- */

/**
 * Adaptively sample a parametric curve fn(t) on [t0, t1] so that the polyline stays within tol of the curve.
 * Pushes x,y pairs (excluding fn(t0), including fn(t1)) onto out.
 */
function sampleParametric(fn, t0, t1, tol, out, initial=64) {
  const step = (t1 - t0) / initial;
  let prevT = t0;
  let prev = fn(t0);
  for ( let k = 1; k <= initial; k++ ) {
    const t = k === initial ? t1 : t0 + (step * k);
    const p = fn(t);
    refine(fn, prevT, prev, t, p, tol, out, 0);
    prevT = t;
    prev = p;
  }
}

function refine(fn, ta, a, tb, b, tol, out, depth) {
  if ( depth < 16 ) {
    const tm = (ta + tb) / 2;
    const m = fn(tm);
    const q1 = fn((ta + tm) / 2);
    const q3 = fn((tm + tb) / 2);
    const dev = Math.max(chordDistance(a, b, m), chordDistance(a, b, q1), chordDistance(a, b, q3));
    if ( dev > tol ) {
      refine(fn, ta, a, tm, m, tol, out, depth + 1);
      refine(fn, tm, m, tb, b, tol, out, depth + 1);
      return;
    }
  }
  out.push(b.x, b.y);
}

function chordDistance(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if ( len < 1e-12 ) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(((p.x - a.x) * dy) - ((p.y - a.y) * dx)) / len;
}

/* -------------------------------------------- */
/*  Builders                                    */
/* -------------------------------------------- */

const cache = new Map();
const CACHE_LIMIT = 400;

/**
 * Build a shape into its exact traced form.
 * @returns {{lut: PathLUT, closed: boolean, center: {x:number,y:number}, flat: number[], shape: object,
 *   curves?: object[], handles?: object[], nodeDistances?: number[]}}
 */
export function buildShape(shape) {
  const key = JSON.stringify(shape);
  const hit = cache.get(key);
  if ( hit ) return hit;
  const s = normalizeShape(shape);
  const built = BUILDERS[s.type](s);
  built.shape = s;
  built.lut = new PathLUT(built.flat, built.closed);
  built.closed = built.lut.closed;
  if ( cache.size >= CACHE_LIMIT ) cache.delete(cache.keys().next().value);
  cache.set(key, built);
  return built;
}

const BUILDERS = {

  path(s) {
    const nodes = s.nodes;
    if ( nodes.length === 0 ) return {flat: [0, 0], closed: false, center: {x: 0, y: 0}, curves: [], handles: []};
    const {curves, handles, closed} = pathCurves(s);
    const flat = [nodes[0].x, nodes[0].y];
    const nodeFlatIndex = [0];
    for ( const c of curves ) {
      flattenCubic(c.p0, c.c1, c.c2, c.p3, FLATTEN_TOLERANCE, flat);
      nodeFlatIndex.push(flat.length / 2 - 1);
    }
    const cx = nodes.reduce((t, n) => t + n.x, 0) / nodes.length;
    const cy = nodes.reduce((t, n) => t + n.y, 0) / nodes.length;
    return {flat, closed, center: {x: cx, y: cy}, curves, handles, nodeFlatIndex};
  },

  ellipse(s) {
    const c = {x: s.cx, y: s.cy};
    const rot = toRad(s.rotation);
    const sweep = toRad(s.sweep);
    const fn = t => rotateAround({x: s.cx + (s.rx * Math.cos(t)), y: s.cy + (s.ry * Math.sin(t))}, c, rot);
    const p0 = fn(0);
    const flat = [p0.x, p0.y];
    sampleParametric(fn, 0, sweep, FLATTEN_TOLERANCE, flat, Math.max(8, Math.ceil(sweep / (Math.PI / 16))));
    return {flat, closed: s.sweep >= 360, center: c};
  },

  rect(s) {
    const c = {x: s.cx, y: s.cy};
    const rot = toRad(s.rotation);
    const hw = s.w / 2;
    const hh = s.h / 2;
    const r = s.radius;
    const local = [];
    const push = (x, y) => local.push({x, y});
    const arc = (acx, acy, a0, a1) => {
      const tmp = [];
      sampleParametric(t => ({x: acx + (r * Math.cos(t)), y: acy + (r * Math.sin(t))}), a0, a1,
        FLATTEN_TOLERANCE, tmp, 8);
      for ( let i = 0; i < tmp.length; i += 2 ) push(tmp[i], tmp[i + 1]);
    };
    push(-hw + r, -hh);
    push(hw - r, -hh);
    if ( r > 0 ) arc(hw - r, -hh + r, -Math.PI / 2, 0);
    push(hw, hh - r);
    if ( r > 0 ) arc(hw - r, hh - r, 0, Math.PI / 2);
    push(-hw + r, hh);
    if ( r > 0 ) arc(-hw + r, hh - r, Math.PI / 2, Math.PI);
    push(-hw, -hh + r);
    if ( r > 0 ) arc(-hw + r, -hh + r, Math.PI, Math.PI * 1.5);
    const flat = [];
    for ( const p of local ) {
      const q = rotateAround({x: p.x + s.cx, y: p.y + s.cy}, c, rot);
      flat.push(q.x, q.y);
    }
    return {flat, closed: true, center: c};
  },

  polygon(s) {
    const n = s.star > 0 ? s.sides * 2 : s.sides;
    const nodes = [];
    for ( let k = 0; k < n; k++ ) {
      const a = toRad(s.rotation - 90 + ((360 / n) * k));
      const r = (s.star > 0) && (k % 2 === 1) ? s.radius * s.star : s.radius;
      nodes.push(makeNode(s.cx + (r * Math.cos(a)), s.cy + (r * Math.sin(a)), {smooth: s.smooth}));
    }
    const built = BUILDERS.path({type: "path", nodes, closed: true});
    built.center = {x: s.cx, y: s.cy};
    built.vertices = nodes;
    return built;
  },

  spiral(s) {
    const c = {x: s.cx, y: s.cy};
    const T = TAU * s.turns;
    const dir = s.ccw ? -1 : 1;
    const rot = toRad(s.rotation);
    const fn = t => {
      const r = s.r0 + ((s.r1 - s.r0) * (t / T));
      const a = (dir * t) + rot;
      return {x: s.cx + (r * Math.cos(a)), y: s.cy + (r * Math.sin(a))};
    };
    const p0 = fn(0);
    const flat = [p0.x, p0.y];
    sampleParametric(fn, 0, T, FLATTEN_TOLERANCE, flat, Math.ceil(s.turns * 32));
    return {flat, closed: false, center: c};
  },

  wave(s) {
    const a = {x: s.x0, y: s.y0};
    const b = {x: s.x1, y: s.y1};
    const L = dist(a, b);
    const flat = [a.x, a.y];
    if ( L < 1e-6 ) return {flat, closed: false, center: a};
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const nx = -uy;
    const ny = ux;
    const at = (sd, off) => ({x: a.x + (ux * sd) + (nx * off), y: a.y + (uy * sd) + (ny * off)});
    const lambda = s.wavelength;
    if ( s.form === "zigzag" ) {
      // Triangle wave: exact corners at every peak
      const tri = sd => {
        const ph = ((sd / lambda) % 1 + 1) % 1;
        let v;
        if ( ph < 0.25 ) v = ph * 4;
        else if ( ph < 0.75 ) v = 2 - (ph * 4);
        else v = (ph * 4) - 4;
        return v * s.amplitude;
      };
      for ( let sd = lambda / 4; sd < L; sd += lambda / 2 ) {
        const p = at(sd, tri(sd));
        flat.push(p.x, p.y);
      }
      const e = at(L, tri(L));
      flat.push(e.x, e.y);
    } else {
      const fn = sd => at(sd, s.amplitude * Math.sin(TAU * sd / lambda));
      sampleParametric(fn, 0, L, FLATTEN_TOLERANCE, flat, Math.max(8, Math.ceil(L / lambda) * 8));
    }
    return {flat, closed: false, center: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}};
  },

  figure8(s) {
    const c = {x: s.cx, y: s.cy};
    const rot = toRad(s.rotation);
    const fn = t => rotateAround({x: s.cx + ((s.w / 2) * Math.sin(t)), y: s.cy + ((s.h / 2) * Math.sin(2 * t))}, c, rot);
    const p0 = fn(0);
    const flat = [p0.x, p0.y];
    sampleParametric(fn, 0, TAU, FLATTEN_TOLERANCE, flat, 64);
    return {flat, closed: true, center: c};
  },

  point(s) {
    return {flat: [s.x, s.y], closed: false, center: {x: s.x, y: s.y}};
  },

  homing() {
    return {flat: [0, 0], closed: false, center: {x: 0, y: 0}, dynamic: true};
  }
};

/* -------------------------------------------- */
/*  Transforms                                  */
/* -------------------------------------------- */

/** Translate a shape by (dx, dy). Returns a new shape. */
export function translateShape(shape, dx, dy) {
  const s = foundryClone(shape);
  switch ( s.type ) {
    case "path":
      for ( const n of s.nodes ) {
        n.x += dx;
        n.y += dy;
      }
      break;
    case "wave":
      s.x0 += dx; s.y0 += dy; s.x1 += dx; s.y1 += dy;
      break;
    case "point":
      s.x += dx; s.y += dy;
      break;
    case "homing":
      break;
    default:
      s.cx += dx;
      s.cy += dy;
  }
  return s;
}

/**
 * Rotate and/or scale a shape around a point. Returns a new shape.
 * @param {object} shape
 * @param {{scale?: number, rotate?: number, about: {x:number,y:number}}} t   rotate in degrees
 */
export function transformShape(shape, {scale=1, rotate=0, about}) {
  const s = foundryClone(shape);
  const rad = toRad(rotate);
  const P = (x, y) => rotateAround({x: about.x + ((x - about.x) * scale), y: about.y + ((y - about.y) * scale)}, about, rad);
  const V = v => (v ? rotateAround({x: v.x * scale, y: v.y * scale}, {x: 0, y: 0}, rad) : v);
  const C = () => {
    const c = P(s.cx, s.cy);
    s.cx = c.x;
    s.cy = c.y;
    s.rotation = (s.rotation ?? 0) + rotate;
  };
  switch ( s.type ) {
    case "path":
      for ( const n of s.nodes ) {
        const q = P(n.x, n.y);
        n.x = q.x;
        n.y = q.y;
        n.hin = V(n.hin);
        n.hout = V(n.hout);
      }
      break;
    case "homing":
      // Its stopping distance is in grid squares, so it is unaffected by scaling
      break;
    case "point": {
      const q = P(s.x, s.y);
      s.x = q.x;
      s.y = q.y;
      break;
    }
    case "wave": {
      const a = P(s.x0, s.y0);
      const b = P(s.x1, s.y1);
      Object.assign(s, {x0: a.x, y0: a.y, x1: b.x, y1: b.y, amplitude: s.amplitude * scale, wavelength: s.wavelength * scale});
      break;
    }
    case "ellipse":
      C();
      s.rx *= scale;
      s.ry *= scale;
      break;
    case "rect":
      C();
      s.w *= scale;
      s.h *= scale;
      s.radius *= scale;
      break;
    case "polygon":
      C();
      s.radius *= scale;
      break;
    case "spiral":
      C();
      s.r0 *= scale;
      s.r1 *= scale;
      break;
    case "figure8":
      C();
      s.w *= scale;
      s.h *= scale;
      break;
  }
  return s;
}

/** Convert any shape into an editable free-form path (nodes). */
export function shapeToPath(shape) {
  const s = normalizeShape(shape);
  if ( s.type === "path" ) return foundryClone(s);
  if ( s.type === "polygon" ) {
    const built = buildShape(s);
    return {type: "path", closed: true, nodes: built.vertices.map(v => makeNode(v.x, v.y, {smooth: s.smooth}))};
  }
  if ( s.type === "point" ) return {type: "path", closed: false, nodes: [makeNode(s.x, s.y)]};
  // A plain rectangle is exactly its four corners (sampling it would cut them off), from its start, the top left
  if ( (s.type === "rect") && !(s.radius > 0) ) {
    const c = {x: s.cx, y: s.cy};
    const rot = toRad(s.rotation);
    const corners = [[-s.w / 2, -s.h / 2], [s.w / 2, -s.h / 2], [s.w / 2, s.h / 2], [-s.w / 2, s.h / 2]];
    return {type: "path", closed: true, nodes: corners.map(([x, y]) => {
      const q = rotateAround({x: s.cx + x, y: s.cy + y}, c, rot);
      return makeNode(q.x, q.y, {smooth: 0});
    })};
  }
  // Sample the traced polyline sparsely and let auto-smoothing restore the curve
  const built = buildShape(s);
  const lut = built.lut;
  const count = clamp(Math.round(lut.length / 60), built.closed ? 8 : 4, 64);
  const nodes = [];
  const last = built.closed ? count : count + 1;
  for ( let k = 0; k < last; k++ ) {
    const p = lut.pointAt(lut.length * (k / count));
    nodes.push(makeNode(p.x, p.y, {smooth: s.type === "rect" ? 0 : 1}));
  }
  return {type: "path", closed: built.closed, nodes};
}

function foundryClone(o) {
  return JSON.parse(JSON.stringify(o));
}
