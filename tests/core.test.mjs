import {fileURLToPath, pathToFileURL} from "node:url";
const base = fileURLToPath(new URL("../scripts/", import.meta.url));
const imp = f => import(pathToFileURL(base + f).href);
const {PathLUT, dist} = await imp("geometry.js");
const {buildShape, makeNode, shapeToPath} = await imp("shapes.js");
const {compileTimeline} = await imp("timeline.js");

let fails = 0;
const ok = (cond, msg) => { if ( !cond ) { fails++; console.log("FAIL:", msg); } else console.log("ok  :", msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const dims = {size: 100, distance: 5};

// --- Circle precision: every LUT point within 0.1px of the true circle; length ~ 2πr
{
  const b = buildShape({type: "ellipse", cx: 500, cy: 400, rx: 1000, ry: 1000, rotation: 0, sweep: 360});
  let maxErr = 0;
  for ( let d = 0; d < b.lut.length; d += 3.7 ) {
    const p = b.lut.pointAt(d);
    maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.x - 500, p.y - 400) - 1000));
  }
  ok(maxErr <= 0.05, `circle r=1000 max radial error ${maxErr.toFixed(4)}px <= 0.05`);
  ok(near(b.lut.length, 2 * Math.PI * 1000, 0.5), `circle length ${b.lut.length.toFixed(3)} ≈ ${(2*Math.PI*1000).toFixed(3)}`);
  ok(b.closed, "circle is closed");
  ok(b.lut.count < 2000, `circle sample count reasonable (${b.lut.count})`);
}

// --- Constant speed along a smooth bezier path: equal time steps -> equal arc lengths
{
  const shape = {type: "path", closed: false, nodes: [makeNode(0, 0), makeNode(300, 0, {smooth: 1}), makeNode(300, 300, {smooth: 1}), makeNode(600, 300)]};
  const anim = {steps: [{id: "a", shape, enabled: true, laps: 1}], motion: {speed: 2, speedUnit: "grid", loop: "none", approach: "teleport", anchor: "absolute"}, facing: {smoothing: 0}};
  const tl = compileTimeline(anim, {origin: {x: 0, y: 0}, dims});
  const L = buildShape(shape).lut.length;
  ok(near(tl.duration, L / (200 / 1000), 1e-6), `duration ${tl.duration.toFixed(3)}ms matches L/v`);
  let prev = tl.evaluate(1e-9);
  let maxDev = 0;
  const dt = 16.6667;
  for ( let t = dt; t < tl.duration; t += dt ) {
    const e = tl.evaluate(t);
    const step = Math.hypot(e.x - prev.x, e.y - prev.y);
    // chord <= arc; deviation from v*dt must be tiny
    maxDev = Math.max(maxDev, Math.abs(step - (200 / 1000) * dt));
    prev = e;
  }
  ok(maxDev < 0.05, `per-frame travel deviation ${maxDev.toFixed(5)}px (constant speed)`);
  const end = tl.evaluate(tl.duration + 1);
  ok(end.done && near(end.x, 600, 1e-6) && near(end.y, 300, 1e-6), "path ends exactly on last node");
}

// --- Closed square with smooth=1 approximates circle; closing joins seamlessly
{
  const r = 200;
  const nodes = [0, 1, 2, 3].map(k => makeNode(r * Math.cos(k * Math.PI / 2), r * Math.sin(k * Math.PI / 2), {smooth: 1}));
  const b = buildShape({type: "path", closed: true, nodes});
  let maxErr = 0;
  for ( let d = 0; d < b.lut.length; d += 1 ) {
    const p = b.lut.pointAt(d);
    maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.x, p.y) - r));
  }
  ok(maxErr < 0.01 * r, `4 smooth nodes ≈ circle (max err ${maxErr.toFixed(3)} for r=${r})`);
  const s = b.lut.pointAt(0);
  const e = b.lut.pointAt(b.lut.length - 1e-9);
  ok(dist(s, e) < 1e-3, "closed path end meets its start");
}

// --- Laps, start offset, reverse on a closed circle; looping & wrap
{
  const shape = {type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 100, rotation: 0, sweep: 360};
  const anim = {steps: [{shape, laps: 2, startOffset: 0.25, reverse: true}], motion: {speed: 100, speedUnit: "px", loop: "none", approach: "teleport"}, facing: {}};
  const tl = compileTimeline(anim, {origin: {x: 0, y: 100}, dims});
  const L = buildShape(shape).lut.length;
  ok(near(tl.duration, (2 * L) / 0.1, 1e-6), "2 laps duration");
  const st = tl.evaluate(1e-9);
  ok(near(st.x, 0, 0.01) && near(st.y, 100, 0.01), `startOffset 0.25 starts at bottom (${st.x.toFixed(2)},${st.y.toFixed(2)})`);
  const q = tl.evaluate((L / 4) / 0.1);
  ok(near(q.x, 100, 0.05) && near(q.y, 0, 0.05), `reverse travels counter-clockwise to (100,0): (${q.x.toFixed(2)},${q.y.toFixed(2)})`);
}

// --- Infinite loop with phase spread
{
  const shape = {type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 100, rotation: 0, sweep: 360};
  const anim = {steps: [{shape}], motion: {speed: 100, speedUnit: "px", loop: "loop", loopCount: 0, approach: "teleport"}, facing: {}};
  const tl = compileTimeline(anim, {origin: {x: 100, y: 0}, dims});
  ok(tl.infinite && tl.duration === Infinity, "infinite loop");
  const C = tl.cycleDuration;
  const a = tl.evaluate(1000);
  const b = tl.evaluate(1000 + C * 7);
  ok(near(a.x, b.x, 1e-6) && near(a.y, b.y, 1e-6), "periodic after 7 cycles");
  const tl2 = compileTimeline(anim, {origin: {x: 100, y: 0}, dims, phase: C / 2});
  const h = tl2.evaluate(1e-6);
  ok(near(h.x, -100, 0.5), "phase spread: teleport approach lands on the phase point immediately");
  const h2 = tl2.evaluate(1);
  ok(near(h2.x, -100, 0.5) && near(h2.y, 0, 0.5), `phase C/2 runs on the opposite side (${h2.x.toFixed(2)},${h2.y.toFixed(2)})`);
}

// --- Easing: starts from rest, reaches full speed, ends at rest, still lands exactly
{
  const shape = {type: "path", nodes: [makeNode(0, 0), makeNode(1000, 0)]};
  const anim = {steps: [{shape}], motion: {speed: 100, speedUnit: "px", loop: "none", easeIn: 1000, easeOut: 1000, approach: "teleport"}, facing: {}};
  const tl = compileTimeline(anim, {origin: {x: 0, y: 0}, dims});
  ok(near(tl.duration, 10000 + 1000, 1e-6), `eased duration ${tl.duration} = 11000`);
  const e0 = tl.evaluate(10), e1 = tl.evaluate(20);
  ok((e1.x - e0.x) < 0.05, "starts slowly");
  const m0 = tl.evaluate(5000), m1 = tl.evaluate(5010);
  ok(near(m1.x - m0.x, 1, 1e-6), "cruises at full speed");
  const end = tl.evaluate(11000.0001);
  ok(near(end.x, 1000, 1e-9), "lands exactly at end");
  // Short run with large ramps: monotonic & lands
  const anim2 = {...anim, steps: [{shape: {type: "path", nodes: [makeNode(0, 0), makeNode(20, 0)]}}]};
  const tl2 = compileTimeline(anim2, {origin: {x: 0, y: 0}, dims});
  let px = -1, mono = true;
  for ( let t = 0.001; t < tl2.duration; t += 5 ) { const e = tl2.evaluate(t); if ( e.x < px - 1e-9 ) mono = false; px = e.x; }
  ok(mono && near(tl2.evaluate(tl2.duration + 1).x, 20, 1e-9), `short eased run monotonic, duration ${tl2.duration.toFixed(1)}`);
}

// --- Ping-pong returns to start each cycle; finite count; finish return
{
  const shape = {type: "path", nodes: [makeNode(0, 0), makeNode(100, 0)]};
  const anim = {steps: [{shape}], motion: {speed: 100, speedUnit: "px", loop: "pingpong", loopCount: 2, approach: "travel", finish: "stay"}, facing: {}};
  const tl = compileTimeline(anim, {origin: {x: 0, y: 0}, dims});
  ok(near(tl.duration, 4000, 1e-6), `pingpong x2 duration ${tl.duration}`);
  ok(near(tl.evaluate(1000).x, 100, 1e-6) && near(tl.evaluate(2000).x, 0, 1e-6) && near(tl.evaluate(3000).x, 100, 1e-6), "pingpong positions");
}

// --- Relative anchor: path follows the token
{
  const shape = {type: "path", nodes: [makeNode(0, 0), makeNode(100, 0)]};
  const anim = {steps: [{shape}], motion: {speed: 100, speedUnit: "px", anchor: "relative"}, facing: {}};
  const tl = compileTimeline(anim, {origin: {x: 500, y: 500}, dims});
  const e = tl.evaluate(500);
  ok(near(e.x, 550, 1e-6) && near(e.y, 500, 1e-6), "relative anchor offsets path to token");
}

// --- Multi-step with travel connector, teleport connector, waypoint wait, facing direction
{
  const anim = {steps: [
    {shape: {type: "path", nodes: [makeNode(0, 0), makeNode(100, 0)]}},
    {shape: {type: "point", x: 100, y: 100}, wait: 500, connector: "travel"},
    {shape: {type: "path", nodes: [makeNode(300, 300), makeNode(300, 400)]}, connector: "teleport"}
  ], motion: {speed: 100, speedUnit: "px", approach: "teleport"}, facing: {smoothing: 0}};
  const tl = compileTimeline(anim, {origin: {x: 0, y: 0}, dims});
  ok(near(tl.duration, 1000 + 1000 + 500 + 1000, 1e-6), `multi-step duration ${tl.duration}`);
  const w = tl.evaluate(2200);
  ok(near(w.x, 100, 1e-9) && near(w.y, 100, 1e-9) && !w.moving, "waits at waypoint");
  ok(near(w.dir, Math.PI / 2, 1e-6), "keeps travel direction while waiting");
  const t = tl.evaluate(2500.001);
  ok(near(t.x, 300, 0.01) && near(t.y, 300, 0.2), `teleports to third step (${t.x.toFixed(2)},${t.y.toFixed(2)})`);
  const d = tl.evaluate(500);
  ok(near(d.dir, 0, 1e-6), "direction along +x is 0 rad");
}

// --- Every shape type builds
{
  for ( const s of [
    {type: "rect", cx: 0, cy: 0, w: 200, h: 100, rotation: 30, radius: 20},
    {type: "polygon", cx: 0, cy: 0, radius: 100, sides: 5, star: 0.5, smooth: 0.3},
    {type: "spiral", cx: 0, cy: 0, r0: 10, r1: 200, turns: 3},
    {type: "wave", x0: 0, y0: 0, x1: 500, y1: 0, amplitude: 40, wavelength: 120, form: "sine"},
    {type: "wave", x0: 0, y0: 0, x1: 500, y1: 0, amplitude: 40, wavelength: 120, form: "zigzag"},
    {type: "figure8", cx: 0, cy: 0, w: 300, h: 150},
    {type: "point", x: 5, y: 5}
  ] ) {
    const b = buildShape(s);
    ok(Number.isFinite(b.lut.length) && b.lut.count >= 1, `${s.type}${s.form ? "/" + s.form : ""} builds (len ${b.lut.length.toFixed(1)}, ${b.lut.count} pts, closed=${b.closed})`);
    const p = shapeToPath(s);
    ok(p.type === "path" && p.nodes.length >= 1, `${s.type} converts to editable path (${p.nodes.length} nodes)`);
  }
  // rect perimeter with radius: 2(w+h) - 8r + 2πr
  const rb = buildShape({type: "rect", cx: 0, cy: 0, w: 200, h: 100, rotation: 0, radius: 20});
  const expect = 2 * (200 + 100) - 8 * 20 + 2 * Math.PI * 20;
  ok(near(rb.lut.length, expect, 0.15), `rounded rect perimeter ${rb.lut.length.toFixed(3)} ≈ ${expect.toFixed(3)}`);
  // A plain rectangle converts to exactly its four corners, from its start (sampling would cut the corners off)
  const plain = shapeToPath({type: "rect", cx: 100, cy: 50, w: 200, h: 100, rotation: 0, radius: 0});
  ok(plain.closed && plain.nodes.map(n => `${n.x},${n.y},${n.smooth}`).join(" ") === "0,0,0 200,0,0 200,100,0 0,100,0",
    "a plain rectangle converts to its four corners, sharp");
  const turned = shapeToPath({type: "rect", cx: 100, cy: 50, w: 200, h: 100, rotation: 30, radius: 0});
  ok(turned.nodes.length === 4 && turned.nodes.every(n => near(Math.hypot(n.x - 100, n.y - 50), Math.hypot(100, 50), 1e-9))
    && near(buildShape(turned).lut.length, 600, 1e-6), "(turned ones too, keeping their size)");
}


// --- Height profiles
{
  const {liftHeight} = await imp("lift.js");
  ok(near(liftHeight({mode: "arc", height: 2}, 0.5), 2, 1e-12) && liftHeight({mode: "arc", height: 2}, 0) === 0, "arc peaks at the middle");
  const b = {mode: "bounce", height: 3, count: 3, decay: 0.5};
  ok(near(liftHeight(b, 0), 3, 1e-12) && near(liftHeight(b, 1), 0, 1e-9), "drop & bounce starts at full height and settles on the ground");
  // Local maxima after the initial fall are the bounce peaks
  let peaks = [], prev = liftHeight(b, 0), rising = false;
  for ( let f = 0.0005; f <= 1; f += 0.0005 ) { const z = liftHeight(b, f); if ( z < prev && rising ) peaks.push(prev); rising = z > prev; prev = z; }
  ok(peaks.length === 3 && near(peaks[0], 1.5, 0.01) && near(peaks[1], 0.75, 0.01) && near(peaks[2], 0.375, 0.01), `bounces decay ×0.5 (${peaks.map(p => p.toFixed(2)).join(", ")})`);
  const sk = {mode: "skip", height: 1, count: 4, decay: 0.5};
  // Landings are the local minima; hop lengths are the gaps between them
  let lens = [], start = 0, prevZ = 0, falling = false;
  for ( let f = 0.0001; f <= 1.00001; f += 0.0001 ) { const z = liftHeight(sk, f); if ( z > prevZ && falling ) { lens.push(f - start); start = f; } falling = z < prevZ; prevZ = z; }
  ok(lens.length >= 3 && lens[1] < lens[0] && lens[2] < lens[1], `skips get shorter (${lens.slice(0, 4).map(l => l.toFixed(3)).join(", ")})`);
  ok(near(liftHeight({mode: "bob", height: 1, freq: 0.5}, null, 1), 1, 1e-12), "hover peaks every 1/freq seconds");
}

// --- Symmetry transforms
{
  const {copyTransform, transformPoint, transformDirection} = await imp("symmetry.js");
  const c = {cx: 100, cy: 100};
  const p = {x: 200, y: 100};
  const pts = [0, 1, 2, 3].map(i => transformPoint(copyTransform({i, n: 4, mode: "rotate", ...c}), p));
  ok(near(pts[1].x, 100, 1e-9) && near(pts[1].y, 200, 1e-9) && near(pts[2].x, 0, 1e-9) && near(pts[3].y, 0, 1e-9), "radial ×4 places copies every 90°");
  const m = copyTransform({i: 1, n: 2, mode: "mirror", ...c, axis: 90});
  const q = transformPoint(m, {x: 150, y: 120});
  ok(near(q.x, 50, 1e-9) && near(q.y, 120, 1e-9), "kaleidoscope copy mirrors across its axis");
  ok(near(transformDirection(m, 0), Math.PI * 2, 1e-9) || near(Math.cos(transformDirection(m, 0)), -1, 1e-9), "mirrored copies travel the mirrored direction");
  const ring = Array.from({length: 7}, (_, i) => transformPoint(copyTransform({i, n: 7, mode: "rotate", ...c}), p));
  ok(ring.every(r => near(Math.hypot(r.x - 100, r.y - 100), 100, 1e-9)), "every copy stays the same distance from the centre");
}


// --- Regressions from the code review
{
  // Finite loops with 3+ cycles and a travel connector: constant speed the whole way, no freezes or jumps
  const anim = {steps: [{shape: {type: "path", nodes: [makeNode(0, 0), makeNode(300, 0)]}}],
    motion: {speed: 100, speedUnit: "px", loop: "loop", loopCount: 4, loopConnector: "travel", approach: "teleport"}, facing: {}};
  const tl = compileTimeline(anim, {origin: {x: 0, y: 0}, dims});
  ok(near(tl.duration, (4 * 3000) + (3 * 3000), 1e-6), `4 cycles with travel back: ${tl.duration} ms`);
  let prev = tl.evaluate(1e-6), worst = 0;
  for ( let t = 10; t < tl.duration; t += 10 ) {
    const e = tl.evaluate(t);
    worst = Math.max(worst, Math.abs(Math.hypot(e.x - prev.x, e.y - prev.y) - 1));
    prev = e;
  }
  ok(worst < 1e-6, `moves at exactly 1 px / 10 ms through every cycle (worst deviation ${worst.toExponential(1)})`);
  const gapAnim = {...anim, motion: {...anim.motion, loopGap: 500}};
  const tg = compileTimeline(gapAnim, {origin: {x: 0, y: 0}, dims});
  let maxJump = 0; prev = tg.evaluate(1e-6);
  for ( let t = 10; t < tg.duration; t += 10 ) { const e = tg.evaluate(t); maxJump = Math.max(maxJump, Math.hypot(e.x - prev.x, e.y - prev.y)); prev = e; }
  ok(maxJump <= 1 + 1e-6, `no teleports with a pause between cycles (largest step ${maxJump.toFixed(3)} px)`);

  // Endless loop that takes no time plays once and stays put
  const pt = {steps: [{shape: {type: "point", x: 200, y: 0}}], motion: {speed: 100, speedUnit: "px", loop: "loop", loopCount: 0, approach: "travel"}, facing: {}};
  const tp = compileTimeline(pt, {origin: {x: 0, y: 0}, dims});
  const endP = tp.evaluate(10000);
  ok(!tp.infinite && near(endP.x, 200, 1e-6) && endP.done, `zero-length endless loop rests at the waypoint (${endP.x})`);

  // Back & forth on a multi-pass path: the height plays back smoothly in reverse
  const {liftHeight} = await imp("lift.js");
  const lifted = {steps: [{shape: {type: "path", nodes: [makeNode(0, 0), makeNode(200, 0)]}, laps: 2, lift: {mode: "arc", height: 1}}],
    motion: {speed: 100, speedUnit: "px", loop: "pingpong", loopCount: 1, approach: "teleport"}, facing: {}};
  const tlift = compileTimeline(lifted, {origin: {x: 0, y: 0}, dims});
  let lastZ = 0, jump = 0;
  for ( let t = 1; t < tlift.duration; t += 5 ) {
    const e = tlift.evaluate(t);
    const z = liftHeight(lifted.steps[0].lift, e.liftFrac, t / 1000);
    jump = Math.max(jump, Math.abs(z - lastZ));
    lastZ = z;
  }
  ok(jump < 0.02, `height is continuous through the turnaround (largest change per frame ${jump.toFixed(4)})`);

  // Per-step turn smoothing is used by that step
  const sm = {steps: [
    {shape: {type: "path", nodes: [makeNode(0, 0), makeNode(100, 0), makeNode(100, 100)]}, facing: {smoothing: 0}},
    {shape: {type: "path", nodes: [makeNode(100, 100), makeNode(200, 100), makeNode(200, 200)]}, facing: {smoothing: 80}}
  ], motion: {speed: 100, speedUnit: "px", approach: "teleport"}, facing: {smoothing: 0}};
  const tsm = compileTimeline(sm, {origin: {x: 0, y: 0}, dims});
  const d1 = tsm.evaluate(950).dir;
  const d2 = tsm.evaluate(2990).dir;
  ok(near(d1, 0, 1e-6) && d2 > 0.05 && d2 < Math.PI / 2, `step 1 turns sharply, step 2 rounds its corner (${d1.toFixed(3)} vs ${d2.toFixed(3)} rad)`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
