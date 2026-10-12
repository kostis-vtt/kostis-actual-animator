// Token facing: turns a timeline sample into a token rotation according to the facing configuration.

import {ART_FACING} from "./const.js";
import {toDeg} from "./geometry.js";
import {transformRotation} from "./symmetry.js";

const IDENTITY = Object.freeze({identity: true});

/** Convert a travel direction (radians, screen space) to a token rotation (degrees). */
export function directionToRotation(rad, facing) {
  return toDeg(rad) + artOffset(facing) + (facing.offset || 0) + (facing.reverse ? 180 : 0);
}

export function artOffset(facing) {
  return ART_FACING[facing.art]?.offset ?? -90;
}

/** Normalise degrees to [0, 360). */
export function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

/**
 * Compute the rotation a token should have for a timeline sample.
 * @param {object} facing                 Facing configuration in effect
 * @param {object} sample                 Timeline sample {x, y, dir, before, done, returned, step}, already moved
 *                                        into place for symmetry copies
 * @param {object} ctx
 * @param {number} ctx.tau                Playback time (ms)
 * @param {number} ctx.originRotation     Rotation the token had when playback started
 * @param {{x:number,y:number}|null} ctx.center    Centre of the current shape (scene space, transformed)
 * @param {{x:number,y:number}} ctx.offset         Relative-anchor translation
 * @param {(id: string) => ({x:number,y:number}|null)} ctx.tokenCenter
 * @param {(facing: object, pos: {x:number,y:number}) => ({x:number,y:number}|null)} [ctx.targetCenter]
 * @param {number|null} [ctx.rawDir]      Untransformed travel direction (for "turn")
 * @param {number|null} [ctx.startDir]    Travel direction at the start of the path (for "turn")
 * @param {object} [ctx.transform]        Symmetry copy transform
 * @returns {number|undefined}            The rotation in degrees, or undefined to leave rotation untouched
 */
export function facingRotation(facing, sample, ctx) {
  const t = ctx.transform ?? IDENTITY;
  const art = artOffset(facing);
  const intrinsic = r => (r === undefined ? undefined : transformRotation(t, r, art));
  if ( sample.done && sample.returned ) return normDeg(intrinsic(ctx.originRotation));
  if ( sample.before ) return t.identity ? undefined : normDeg(intrinsic(ctx.originRotation));

  const pos = sample;
  const towards = target => {
    if ( !target ) return undefined;
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    if ( Math.hypot(dx, dy) < 0.5 ) return undefined;
    return directionToRotation(Math.atan2(dy, dx), facing);
  };

  let r;
  switch ( facing.mode ) {
    case "keep":
      r = (facing.swayAmp || !t.identity) ? intrinsic(ctx.originRotation) : undefined;
      break;
    case "fixed":
      r = intrinsic(facing.angle);
      break;
    case "spin":
      r = intrinsic(ctx.originRotation + ((facing.spinSpeed * ctx.tau) / 1000));
      break;
    case "turn": {
      // Keep the starting facing and turn exactly as much as the path turns
      const raw = ctx.rawDir ?? sample.dir;
      if ( (sample.step < 0) || (raw === null) || (raw === undefined) || (ctx.startDir === null) || (ctx.startDir === undefined) ) {
        r = t.identity ? undefined : intrinsic(ctx.originRotation);
      } else r = intrinsic(ctx.originRotation + toDeg(raw - ctx.startDir) + (facing.offset || 0));
      break;
    }
    case "path":
      r = (sample.dir === null) || (sample.dir === undefined) ? undefined : directionToRotation(sample.dir, facing);
      break;
    case "center":
      r = towards(ctx.center);
      break;
    case "point": {
      const p = facing.point ? {x: facing.point.x + ctx.offset.x, y: facing.point.y + ctx.offset.y} : null;
      r = towards(p);
      break;
    }
    case "token":
      r = towards(facing.tokenId ? ctx.tokenCenter(facing.tokenId) : null);
      break;
    case "target":
      r = towards(ctx.targetCenter ? ctx.targetCenter(facing, pos) : null);
      break;
  }
  if ( r === undefined ) return undefined;
  if ( facing.swayAmp ) r += facing.swayAmp * Math.sin((2 * Math.PI * facing.swayFreq * ctx.tau) / 1000);
  return normDeg(r);
}
