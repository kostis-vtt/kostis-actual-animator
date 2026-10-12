// Pure geometry helpers: Bézier flattening, arc-length lookup tables and point utilities.
// This module has no Foundry dependencies so it can be unit-tested in plain Node.

export const TAU = Math.PI * 2;

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const lerp = (a, b, t) => a + ((b - a) * t);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const toRad = deg => deg * Math.PI / 180;
export const toDeg = rad => rad * 180 / Math.PI;

/** Rotate point p around center c by angle (radians). */
export function rotateAround(p, c, angle) {
  if ( !angle ) return {x: p.x, y: p.y};
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return {x: c.x + (dx * cos) - (dy * sin), y: c.y + (dx * sin) + (dy * cos)};
}

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(a) {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}

/* -------------------------------------------- */
/*  Bézier flattening                           */
/* -------------------------------------------- */

/**
 * Adaptively flatten a cubic Bézier into a polyline.
 * Pushes points (excluding p0, including p3) as x,y pairs onto `out`.
 * The polyline never deviates from the true curve by more than `tol` pixels.
 */
export function flattenCubic(p0, p1, p2, p3, tol, out, depth=0) {
  if ( depth >= 18 || isFlat(p0, p1, p2, p3, tol) ) {
    out.push(p3.x, p3.y);
    return;
  }
  // De Casteljau split at t=0.5
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenCubic(p0, p01, p012, m, tol, out, depth + 1);
  flattenCubic(m, p123, p23, p3, tol, out, depth + 1);
}

function mid(a, b) {
  return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
}

/**
 * A cubic is flat enough when both control points lie within tol/0.75 of the chord and project inside it
 * (the curve deviates from its chord by at most 3/4 of the control point deviation).
 */
function isFlat(p0, p1, p2, p3, tol) {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const len2 = (dx * dx) + (dy * dy);
  const limit = tol / 0.75;
  if ( len2 < 1e-12 ) return (dist(p0, p1) <= limit) && (dist(p0, p2) <= limit);
  const len = Math.sqrt(len2);
  for ( const p of [p1, p2] ) {
    const ex = p.x - p0.x;
    const ey = p.y - p0.y;
    const cross = Math.abs((ex * dy) - (ey * dx)) / len;
    if ( cross > limit ) return false;
    const t = ((ex * dx) + (ey * dy)) / len2;
    if ( (t < -0.001) || (t > 1.001) ) return false;
  }
  return true;
}

/* -------------------------------------------- */
/*  Arc-length lookup table                     */
/* -------------------------------------------- */

/**
 * An arc-length parameterised polyline. Positions are queried by travelled distance,
 * which is what makes constant-speed motion along arbitrary curves exact.
 */
export class PathLUT {
  /**
   * @param {number[]|Float64Array} flat   Points as [x0, y0, x1, y1, ...]
   * @param {boolean} closed               Whether the polyline is a closed loop (last point joins the first)
   */
  constructor(flat, closed=false) {
    // Copy points, dropping consecutive duplicates
    const xs = [];
    const ys = [];
    for ( let i = 0; i < flat.length; i += 2 ) {
      const x = flat[i];
      const y = flat[i + 1];
      const n = xs.length;
      if ( n && (Math.abs(xs[n - 1] - x) < 1e-9) && (Math.abs(ys[n - 1] - y) < 1e-9) ) continue;
      xs.push(x);
      ys.push(y);
    }
    if ( !xs.length ) {
      xs.push(0);
      ys.push(0);
    }

    // Closed loops end exactly where they start
    if ( closed && (xs.length > 1) ) {
      const n = xs.length;
      if ( (Math.abs(xs[n - 1] - xs[0]) > 1e-9) || (Math.abs(ys[n - 1] - ys[0]) > 1e-9) ) {
        xs.push(xs[0]);
        ys.push(ys[0]);
      }
    }

    this.closed = closed && (xs.length > 2);
    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    const n = xs.length;
    this.cum = new Float64Array(n);
    for ( let i = 1; i < n; i++ ) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    this.length = this.cum[n - 1];
  }

  get count() {
    return this.xs.length;
  }

  get start() {
    return {x: this.xs[0], y: this.ys[0]};
  }

  get end() {
    const n = this.xs.length - 1;
    return {x: this.xs[n], y: this.ys[n]};
  }

  /** Normalise a distance: wrap for closed loops, clamp for open paths. */
  normalize(d) {
    const L = this.length;
    if ( L <= 0 ) return 0;
    if ( this.closed ) return ((d % L) + L) % L;
    return clamp(d, 0, L);
  }

  /** Index i such that cum[i] <= d <= cum[i+1]. */
  segmentAt(d) {
    const cum = this.cum;
    let lo = 0;
    let hi = cum.length - 1;
    if ( hi <= 0 ) return 0;
    if ( d >= cum[hi] ) return hi - 1;
    while ( hi - lo > 1 ) {
      const m = (lo + hi) >> 1;
      if ( cum[m] <= d ) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Exact position at travelled distance d. */
  pointAt(d, out={x: 0, y: 0}) {
    const n = this.xs.length;
    if ( n === 1 ) {
      out.x = this.xs[0];
      out.y = this.ys[0];
      return out;
    }
    d = this.normalize(d);
    const i = this.segmentAt(d);
    const seg = this.cum[i + 1] - this.cum[i];
    const t = seg > 0 ? (d - this.cum[i]) / seg : 0;
    out.x = this.xs[i] + ((this.xs[i + 1] - this.xs[i]) * t);
    out.y = this.ys[i] + ((this.ys[i + 1] - this.ys[i]) * t);
    return out;
  }

  /**
   * Direction of travel (radians) at distance d, measured over a small window so that the
   * tangent is stable on densely-flattened curves.
   */
  angleAt(d, window=2) {
    if ( this.length <= 0 ) return null;
    const h = Math.min(window, this.length / 4);
    let a = d - h;
    let b = d + h;
    if ( !this.closed ) {
      a = clamp(a, 0, this.length);
      b = clamp(b, 0, this.length);
      if ( b - a < 1e-6 ) return null;
    }
    const p = this.pointAt(a);
    const q = this.pointAt(b);
    if ( (Math.abs(q.x - p.x) < 1e-9) && (Math.abs(q.y - p.y) < 1e-9) ) return null;
    return Math.atan2(q.y - p.y, q.x - p.x);
  }

  /** Closest point on the polyline to (x, y). Returns {d, dist, x, y, index}. */
  nearest(x, y) {
    let best = {d: 0, dist: Infinity, x: this.xs[0], y: this.ys[0], index: 0};
    const n = this.xs.length;
    if ( n === 1 ) {
      best.dist = Math.hypot(x - this.xs[0], y - this.ys[0]);
      return best;
    }
    for ( let i = 0; i < n - 1; i++ ) {
      const ax = this.xs[i];
      const ay = this.ys[i];
      const dx = this.xs[i + 1] - ax;
      const dy = this.ys[i + 1] - ay;
      const len2 = (dx * dx) + (dy * dy);
      let t = len2 > 0 ? (((x - ax) * dx) + ((y - ay) * dy)) / len2 : 0;
      t = clamp(t, 0, 1);
      const px = ax + (dx * t);
      const py = ay + (dy * t);
      const dd = Math.hypot(x - px, y - py);
      if ( dd < best.dist ) {
        best = {d: this.cum[i] + ((this.cum[i + 1] - this.cum[i]) * t), dist: dd, x: px, y: py, index: i};
      }
    }
    return best;
  }

  /** Axis-aligned bounds of the polyline. */
  get bounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for ( let i = 0; i < this.xs.length; i++ ) {
      minX = Math.min(minX, this.xs[i]);
      maxX = Math.max(maxX, this.xs[i]);
      minY = Math.min(minY, this.ys[i]);
      maxY = Math.max(maxY, this.ys[i]);
    }
    return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
  }
}

/** A straight segment with the PathLUT query interface (used for connectors and approach legs). */
export class LineLUT {
  constructor(a, b) {
    this.a = {x: a.x, y: a.y};
    this.b = {x: b.x, y: b.y};
    this.length = dist(a, b);
    this.closed = false;
    this.angle = this.length > 0 ? Math.atan2(b.y - a.y, b.x - a.x) : null;
  }

  get start() {
    return this.a;
  }

  get end() {
    return this.b;
  }

  normalize(d) {
    return clamp(d, 0, this.length);
  }

  pointAt(d, out={x: 0, y: 0}) {
    const t = this.length > 0 ? clamp(d / this.length, 0, 1) : 0;
    out.x = this.a.x + ((this.b.x - this.a.x) * t);
    out.y = this.a.y + ((this.b.y - this.a.y) * t);
    return out;
  }

  angleAt() {
    return this.angle;
  }
}

/* -------------------------------------------- */
/*  Polyline simplification (freehand input)    */
/* -------------------------------------------- */

/** Ramer–Douglas–Peucker simplification of an array of {x, y}. */
export function simplifyRDP(points, epsilon) {
  if ( points.length < 3 ) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while ( stack.length ) {
    const [s, e] = stack.pop();
    const a = points[s];
    const b = points[e];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = -1;
    let idx = -1;
    for ( let i = s + 1; i < e; i++ ) {
      const p = points[i];
      const d = Math.abs(((p.x - a.x) * dy) - ((p.y - a.y) * dx)) / len;
      if ( d > maxD ) {
        maxD = d;
        idx = i;
      }
    }
    if ( maxD > epsilon ) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_p, i) => keep[i]);
}
