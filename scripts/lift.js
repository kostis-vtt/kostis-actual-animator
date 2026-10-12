// Height profiles ("lift"): vertical motion layered on top of a step's path — arcs, hops, drop-and-bounce,
// stone skipping and hovering. Heights are in grid squares. No Foundry dependencies (testable in Node).

export const LIFT_MODES = {
  none: {label: "Flat", icon: "fa-solid fa-minus", hint: "Stays on the ground."},
  arc: {label: "Arc", icon: "fa-solid fa-bezier-curve", hint: "One thrown arc over the whole step — a lob, a leap, a jump."},
  hops: {label: "Hops", icon: "fa-solid fa-paw", hint: "Equal hops all along the step (bunny hops, a skipping goblin)."},
  bounce: {label: "Drop & bounce", icon: "fa-solid fa-basketball", hint: "Falls from the height, hits the floor and bounces lower and lower until it settles."},
  skip: {label: "Skip", icon: "fa-solid fa-water", hint: "Like a stone skipping on water: each hop shorter and lower than the last."},
  bob: {label: "Hover", icon: "fa-solid fa-feather", hint: "Floats gently up and down (flying creatures, wisps, magic items)."}
};

/**
 * Split a height profile into hop segments. Each segment has a height and a relative length; physically, a
 * projectile moving at constant ground speed spends time proportional to √height in the air.
 * @returns {{h: number, w: number, drop?: boolean}[]}
 */
function segments(lift) {
  const H = Math.max(0, lift.height);
  const n = Math.max(1, Math.round(lift.count));
  const r = Math.min(0.95, Math.max(0.05, lift.decay));
  const segs = [];
  switch ( lift.mode ) {
    case "hops":
      for ( let k = 0; k < n; k++ ) segs.push({h: H, w: 1});
      break;
    case "skip":
      for ( let k = 0; k < n; k++ ) {
        const h = H * (r ** k);
        segs.push({h, w: Math.sqrt(h)});
      }
      break;
    case "bounce":
      // The fall from H takes half as long as a full hop of height H
      segs.push({h: H, w: 0.5 * Math.sqrt(H), drop: true});
      for ( let k = 1; k <= n; k++ ) {
        const h = H * (r ** k);
        segs.push({h, w: Math.sqrt(h)});
      }
      break;
    default:
      segs.push({h: H, w: 1});
  }
  const total = segs.reduce((t, s) => t + s.w, 0) || 1;
  let acc = 0;
  for ( const s of segs ) {
    s.f0 = acc / total;
    acc += s.w;
    s.f1 = acc / total;
  }
  return segs;
}

const cache = new Map();

/**
 * Height (in grid squares) at a point of a step.
 * @param {object} lift          The step's lift configuration {mode, height, count, decay, freq}
 * @param {number} frac          Progress through the step, 0..1
 * @param {number} seconds       Playback time in seconds (used by hovering)
 */
export function liftHeight(lift, frac, seconds=0) {
  if ( !lift || (lift.mode === "none") || !(lift.height > 0) ) return 0;
  if ( lift.mode === "bob" ) {
    const f = Math.max(0, lift.freq || 0.5);
    return lift.height * (1 - Math.cos(2 * Math.PI * f * seconds)) / 2;
  }
  if ( (frac === null) || (frac === undefined) ) return 0;
  frac = Math.min(1, Math.max(0, frac));
  if ( lift.mode === "arc" ) return 4 * lift.height * frac * (1 - frac);
  const key = `${lift.mode}|${lift.height}|${lift.count}|${lift.decay}`;
  let segs = cache.get(key);
  if ( !segs ) {
    segs = segments(lift);
    if ( cache.size > 200 ) cache.clear();
    cache.set(key, segs);
  }
  let lo = 0;
  let hi = segs.length - 1;
  while ( lo < hi ) {
    const m = (lo + hi) >> 1;
    if ( segs[m].f1 < frac ) lo = m + 1;
    else hi = m;
  }
  const s = segs[lo];
  const u = (s.f1 - s.f0) > 0 ? (frac - s.f0) / (s.f1 - s.f0) : 0;
  if ( s.drop ) return s.h * (1 - (u * u));
  return 4 * s.h * u * (1 - u);
}

/** Sample a lift profile for drawing (e.g. template thumbnails). */
export function liftProfile(lift, samples=120) {
  const out = [];
  for ( let i = 0; i <= samples; i++ ) {
    const f = i / samples;
    out.push(liftHeight(lift, f, lift.mode === "bob" ? f * 2 / Math.max(0.05, lift.freq || 0.5) : 0));
  }
  return out;
}
