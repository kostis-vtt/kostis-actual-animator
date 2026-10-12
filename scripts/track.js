// The drawn geometry of an animation as a "track": every step's shape as a polyline in the order (and direction) a
// token travels it, with exact corners. Other modules draw effects along it (walls of fire, chains, trails).

import {buildShape} from "./shapes.js";
import {stepEndpoints} from "./timeline.js";

/**
 * @typedef {object} TrackPiece
 * @property {Float64Array} points   [x0, y0, x1, y1, ...] in travel order
 * @property {boolean} closed        The piece is a loop (its last point is its first)
 * @property {number} length         In pixels
 * @property {string} stepId
 */

/**
 * Build the track of an animation.
 * @param {object} anim                  A normalized animation
 * @param {object} [options]
 * @param {number} [options.spacing=6]   Longest gap between points (pixels); corners are always kept
 * @returns {TrackPiece[]}
 */
export function animationTrack(anim, {spacing=6}={}) {
  // Never 0 (or nonsense): the gaps are filled in steps of this size
  spacing = Math.max(0.5, Number(spacing) || 6);
  const pieces = [];
  for ( const step of anim?.steps ?? [] ) {
    if ( (step.enabled === false) || ["homing", "point"].includes(step.shape?.type) ) continue;
    const lut = buildShape(step.shape).lut;
    const L = lut.length;
    if ( (lut.count < 2) || !(L > 0) ) continue;
    const closed = lut.closed;
    const dir = step.reverse ? -1 : 1;
    const d0 = closed ? lut.normalize((Number(step.startOffset) || 0) * L) : (dir > 0 ? 0 : L);
    // Travel distance s ↦ distance d along the shape
    const toD = s => (closed ? lut.normalize(d0 + (dir * s)) : (dir > 0 ? s : L - s));
    // Every vertex, in travel order, so corners stay sharp
    const ss = [0, L];
    for ( let i = 0; i < lut.count; i++ ) {
      let s = dir > 0 ? lut.cum[i] - d0 : d0 - lut.cum[i];
      if ( closed ) s = ((s % L) + L) % L;
      if ( (s > 1e-6) && (s < L - 1e-6) ) ss.push(s);
    }
    ss.sort((a, b) => a - b);
    const out = [];
    const p = {x: 0, y: 0};
    let prev = null;
    for ( const s of ss ) {
      if ( prev !== null ) {
        const gap = s - prev;
        if ( gap < 1e-6 ) continue;
        const n = Math.ceil(gap / spacing);
        for ( let k = 1; k < n; k++ ) {
          lut.pointAt(toD(prev + ((gap * k) / n)), p);
          out.push(p.x, p.y);
        }
      }
      lut.pointAt(closed && (s >= L - 1e-6) ? d0 : toD(s), p);
      out.push(p.x, p.y);
      prev = s;
    }
    pieces.push({points: Float64Array.from(out), closed, length: L, stepId: step.id});
  }
  return pieces;
}

/**
 * Where a token runs an animation relative to where it is drawn: relative animations are moved so they begin at the
 * token (by the playback's origin); absolute ones run where drawn ({x: 0, y: 0}).
 * @param {object} anim        A normalized animation
 * @param {object} pb          The token's playback flag
 * @param {{x:number,y:number}} pivot   The token's top-left → centre offset
 */
export function trackOffset(anim, pb, pivot) {
  if ( (anim?.motion?.anchor !== "relative") || !pb || (pb.anim !== anim.id) ) return {x: 0, y: 0};
  const first = anim.steps.find(st => st.enabled !== false);
  if ( !first || (first.shape.type === "homing") ) return {x: 0, y: 0};
  const start = stepEndpoints(first).start;
  return {x: (Number(pb.ox) || 0) + pivot.x - start.x, y: (Number(pb.oy) || 0) + pivot.y - start.y};
}
