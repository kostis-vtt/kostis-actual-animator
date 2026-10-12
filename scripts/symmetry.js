// Symmetry ("kaleidoscope") transforms: copy i of n is the original motion rotated (or mirrored) around a centre.
// No Foundry dependencies (testable in Node).

export const SYMMETRY_MODES = {
  rotate: {label: "Radial", icon: "fa-solid fa-arrows-spin", hint: "Copies are rotated evenly around the centre (×2 = opposite side, ×3 = every 120°…)."},
  mirror: {label: "Kaleidoscope", icon: "fa-solid fa-snowflake", hint: "Every other copy is a mirror image, like the slices of a kaleidoscope."}
};

const RAD = Math.PI / 180;

/**
 * Describe copy i of n.
 * @param {{i:number, n:number, mode:string, cx:number, cy:number, axis?:number}} sym
 * @returns {{identity: boolean, mirror: boolean, angle: number, cx: number, cy: number}}
 *   angle: rotation (degrees) for rotations, or the mirror-axis angle for reflections
 */
export function copyTransform(sym) {
  const n = Math.max(1, sym?.n ?? 1);
  const i = ((sym?.i ?? 0) % n + n) % n;
  if ( !sym || (n <= 1) || (i === 0) ) return {identity: true, mirror: false, angle: 0, cx: sym?.cx ?? 0, cy: sym?.cy ?? 0};
  const w = 360 / n;
  if ( (sym.mode === "mirror") && (i % 2 === 1) ) {
    return {identity: false, mirror: true, angle: (((i + 1) / 2) * w) + (sym.axis || 0), cx: sym.cx, cy: sym.cy};
  }
  return {identity: false, mirror: false, angle: i * w, cx: sym.cx, cy: sym.cy};
}

/** Transform a point. */
export function transformPoint(t, p) {
  if ( t.identity ) return {x: p.x, y: p.y};
  const dx = p.x - t.cx;
  const dy = p.y - t.cy;
  if ( t.mirror ) {
    const c = Math.cos(2 * t.angle * RAD);
    const s = Math.sin(2 * t.angle * RAD);
    return {x: t.cx + (c * dx) + (s * dy), y: t.cy + (s * dx) - (c * dy)};
  }
  const c = Math.cos(t.angle * RAD);
  const s = Math.sin(t.angle * RAD);
  return {x: t.cx + (c * dx) - (s * dy), y: t.cy + (s * dx) + (c * dy)};
}

/** Transform a direction of travel (radians). */
export function transformDirection(t, rad) {
  if ( t.identity || (rad === null) || (rad === undefined) ) return rad;
  if ( t.mirror ) return (2 * t.angle * RAD) - rad;
  return rad + (t.angle * RAD);
}

/**
 * Transform a token rotation (degrees). Mirroring is approximated by reflecting the direction the art faces.
 * @param {number} artOffset    Degrees added to a travel direction to get the token rotation for this art
 */
export function transformRotation(t, deg, artOffset=-90) {
  if ( t.identity || (deg === undefined) ) return deg;
  if ( t.mirror ) return (2 * t.angle) - deg + (2 * artOffset);
  return deg + t.angle;
}
