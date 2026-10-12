// SVG thumbnails of animations: the real traced paths, their symmetry copies and a side view of any height effect.

import {animationCenter, firstGeometricStep, isGeometric, normalizeAnimation, symmetryCenterFor} from "./model.js";
import {buildShape} from "./shapes.js";
import {copyArc, homingCurve, stepEndpoints} from "./timeline.js";
import {copyTransform, transformPoint} from "./symmetry.js";
import {liftProfile} from "./lift.js";

const MAX_POINTS = 260;

function samplePoints(lut) {
  const n = lut.count;
  const stride = Math.max(1, Math.ceil(n / MAX_POINTS));
  const pts = [];
  for ( let i = 0; i < n; i += stride ) pts.push({x: lut.xs[i], y: lut.ys[i]});
  pts.push({x: lut.xs[n - 1], y: lut.ys[n - 1]});
  return pts;
}

const fmt = v => (Math.round(v * 1000) / 1000).toString();

/**
 * Render an SVG preview.
 * @param {object} data                 An animation or template (any units)
 * @param {object} [options]
 * @param {number} [options.width=160]
 * @param {number} [options.height=100]
 * @param {number} [options.symmetry]   Override the number of copies drawn
 * @returns {string}                    SVG markup
 */
export function animationSVG(data, {width=160, height=100, symmetry}={}) {
  const anim = normalizeAnimation(data);
  const steps = anim.steps.filter(s => s.enabled !== false);
  if ( !steps.length ) {
    return `<svg class="kaa-thumb" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="55%" text-anchor="middle" fill="currentColor" opacity="0.4" font-size="11">empty</text></svg>`;
  }
  // Homing legs fly to stand-in targets placed to the right of the token (or of the token it follows)
  const S = data.unit === "grid" ? 1 : (globalThis.canvas?.dimensions?.size ?? 100);
  const geo = firstGeometricStep(anim);
  const follows = anim.motion.anchor === "token";
  const anchorPt = follows ? (data.anchorOrigin ? {x: data.anchorOrigin.x * S, y: data.anchorOrigin.y * S}
    : (animationCenter(anim) ?? {x: 0, y: 0})) : null;
  const origin = geo && !follows ? stepEndpoints(geo).start : (follows ? {x: anchorPt.x - (3 * S), y: anchorPt.y} : {x: 0, y: 0});
  const homingSteps = steps.filter(s => !isGeometric(s));
  const nTargets = Math.max(1, ...homingSteps.filter(s => s.shape.to === "target").map(s => s.shape.index + 1));
  const base = anchorPt ?? origin;
  const targets = Array.from({length: homingSteps.some(s => s.shape.to === "target") ? nTargets : 0},
    (_, k) => ({x: base.x + (4.5 * S), y: base.y + ((k - ((nTargets - 1) / 2)) * 2.2 * S)}));
  const tokenPt = {x: base.x + (4.5 * S), y: base.y + (2.4 * S)};
  const start = geo && (steps[0] === geo) ? stepEndpoints(geo).start : origin;
  const n = symmetry ?? anim.symmetry.count;
  const center = symmetryCenterFor(anim, start);
  const transforms = [];
  for ( let i = 0; i < n; i++ ) {
    transforms.push(copyTransform({i, n, mode: anim.symmetry.mode, axis: anim.symmetry.axis, cx: center.x, cy: center.y}));
  }
  const fixed = steps.map(s => {
    if ( !isGeometric(s) ) return null;
    const lut = buildShape(s.shape).lut;
    return {pts: lut.count > 1 ? samplePoints(lut) : [lut.start], point: lut.count < 2, end: stepEndpoints(s).end};
  });

  // Every copy: its transformed shapes, plus homing legs re-aimed from wherever it is at that moment
  const all = transforms.map((t, ci) => {
    let cursor = transformPoint(t, origin);
    const out = [];
    steps.forEach((s, si) => {
      const f = fixed[si];
      if ( f ) {
        out.push({pts: f.pts.map(p => transformPoint(t, p)), point: f.point});
        cursor = transformPoint(t, f.end);
        return;
      }
      const spec = s.shape;
      const to = {
        target: targets.length ? targets[(spec.index + ci) % targets.length] : null,
        home: transformPoint(t, origin),
        anchor: anchorPt,
        token: tokenPt
      }[spec.to];
      if ( !to ) return;
      const lut = homingCurve(cursor, to, copyArc(spec.arc, ci, n), S * 0.002);
      const L = Math.max(0, lut.length - ((spec.stop || 0) * S));
      const pts = [];
      const k = 24;
      for ( let j = 0; j <= k; j++ ) pts.push(lut.pointAt((L * j) / k));
      out.push({pts, dashed: true});
      cursor = pts.at(-1);
    });
    return out;
  });
  const markers = [...targets.map(p => ({...p, kind: "target"})), ...(anchorPt ? [{...anchorPt, kind: "anchor"}] : []),
    ...(homingSteps.some(s => s.shape.to === "token") ? [{...tokenPt, kind: "token"}] : [])];

  // Bounds over every copy and marker
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = p => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  };
  for ( const copy of all ) for ( const l of copy ) for ( const p of l.pts ) grow(p);
  for ( const m of markers ) grow(m);
  grow(start);
  const lifted = steps.find(s => s.lift && (s.lift.mode !== "none"));
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const pad = span * 0.12;
  minX -= pad;
  minY -= pad;
  let w = (maxX - minX) + pad;
  let h = (maxY - minY) + pad;
  // Keep the aspect ratio of the box
  const ratio = width / height;
  if ( w / h > ratio ) {
    const nh = w / ratio;
    minY -= (nh - h) / 2;
    h = nh;
  } else {
    const nw = h * ratio;
    minX -= (nw - w) / 2;
    w = nw;
  }
  const sw = Math.max(w, h) / 70;
  const parts = [];
  all.forEach((copy, ci) => {
    const opacity = ci === 0 ? 1 : 0.45;
    for ( const l of copy ) {
      if ( l.point || (l.pts.length < 2) ) {
        const p = l.pts[0];
        parts.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(sw * 2.2)}" fill="${anim.color}" opacity="${opacity}"/>`);
        continue;
      }
      const d = l.pts.map((p, i) => `${i ? "L" : "M"}${fmt(p.x)} ${fmt(p.y)}`).join("");
      const dash = l.dashed ? ` stroke-dasharray="${fmt(sw * 2.6)} ${fmt(sw * 1.8)}"` : "";
      parts.push(`<path d="${d}" fill="none" stroke="${anim.color}" stroke-width="${fmt(ci === 0 ? sw * 1.6 : sw)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${dash}/>`);
    }
  });
  for ( const m of markers ) {
    const r = sw * 4;
    if ( m.kind === "anchor" ) {
      parts.push(`<circle cx="${fmt(m.x)}" cy="${fmt(m.y)}" r="${fmt(r)}" fill="#9aa0ff" fill-opacity="0.35" stroke="#9aa0ff" stroke-width="${fmt(sw)}"/>`);
      continue;
    }
    const c = m.kind === "token" ? "#f2c14e" : "#ff4f4f";
    parts.push(`<g stroke="${c}" stroke-width="${fmt(sw)}" fill="none"><circle cx="${fmt(m.x)}" cy="${fmt(m.y)}" r="${fmt(r)}"/>`
      + `<path d="M${fmt(m.x - (r * 1.5))} ${fmt(m.y)}H${fmt(m.x + (r * 1.5))}M${fmt(m.x)} ${fmt(m.y - (r * 1.5))}V${fmt(m.y + (r * 1.5))}"/></g>`);
  }
  // Where each copy starts (copies sharing one loop would otherwise be invisible)
  transforms.forEach((t, ci) => {
    if ( ci === 0 ) return;
    const p = transformPoint(t, start);
    parts.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(sw * 1.7)}" fill="${anim.color}" stroke="#000" stroke-width="${fmt(sw * 0.4)}" opacity="0.85"/>`);
  });
  parts.push(`<circle cx="${fmt(start.x)}" cy="${fmt(start.y)}" r="${fmt(sw * 2.4)}" fill="#3ddc84" stroke="#000" stroke-width="${fmt(sw * 0.5)}"/>`);

  // Side view of the height profile
  let strip = "";
  if ( lifted ) {
    const prof = liftProfile(lifted.lift, 90);
    const peak = Math.max(...prof, 1e-6);
    const sh = height * 0.28;
    const pts = prof.map((z, i) => `${i ? "L" : "M"}${fmt((i / (prof.length - 1)) * (width - 16) + 8)} ${fmt(height - 6 - ((z / peak) * (sh - 4)))}`).join("");
    strip = `<g class="kaa-thumb-lift"><line x1="8" y1="${height - 6}" x2="${width - 8}" y2="${height - 6}" stroke="currentColor" stroke-opacity="0.35" stroke-width="1"/><path d="${pts}" fill="none" stroke="#ffb347" stroke-width="1.5" stroke-dasharray="3 2"/></g>`;
  }
  return `<svg class="kaa-thumb" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">`
    + `<svg x="0" y="0" width="${width}" height="${lifted ? height * 0.74 : height}" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(w)} ${fmt(h)}" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`
    + `${strip}</svg>`;
}
