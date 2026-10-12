// Built-in animation templates. Coordinates are in grid squares with the token starting at (0, 0); every built-in
// template is "relative to each token", so it can be dropped onto any token on any scene.

import {makeNode} from "./shapes.js";

export const TEMPLATE_CATEGORIES = {
  movement: {label: "Movement", icon: "fa-solid fa-person-running"},
  loops: {label: "Loops & orbits", icon: "fa-solid fa-arrows-spin"},
  height: {label: "Bounces & height", icon: "fa-solid fa-basketball"},
  kaleidoscope: {label: "Kaleidoscope", icon: "fa-solid fa-snowflake"},
  behaviour: {label: "Behaviours", icon: "fa-solid fa-eye"},
  attacks: {label: "Attacks", icon: "fa-solid fa-hand-fist"},
  mine: {label: "My templates", icon: "fa-solid fa-star"}
};

const N = (x, y, smooth=0) => makeNode(x, y, {smooth});
const step = (shape, extra={}) => ({shape, ...extra});
const lift = (mode, height, count=4, decay=0.5, freq=0.5) => ({mode, height, count, decay, freq});

/** Shared defaults for built-in templates. */
function tpl(id, category, name, description, data) {
  return {
    id: `builtin-${id}`,
    builtin: true,
    unit: "grid",
    category,
    name,
    description,
    color: data.color ?? "#ff6b35",
    steps: data.steps,
    motion: {anchor: "relative", approach: "travel", speed: 3, speedUnit: "grid", ...(data.motion ?? {})},
    facing: {mode: "path", art: "down", smoothing: 0.5, ...(data.facing ?? {})},
    symmetry: data.symmetry ?? {count: 1},
    height: data.height ?? {},
    stagger: data.stagger ?? {mode: "none"},
    // Templates that follow a token are drawn around it, with that token at (0, 0)
    anchorOrigin: data.motion?.anchor === "token" ? {x: 0, y: 0} : null
  };
}

const LOOP = {loop: "loop", loopCount: 0};
const FOLLOW = {anchor: "token", anchorToken: "target"};
const SPIN = rps => ({mode: "spin", spinSpeed: rps * 360});
const home = (arc=0, extra={}) => step({type: "homing", to: "home", arc}, extra);
const hit = (arc=0, extra={}, index=0, stop=0) => step({type: "homing", to: "target", index, arc, stop}, extra);
const ring = r => step({type: "ellipse", cx: 0, cy: 0, rx: r, ry: r, rotation: 0, sweep: 360});

export const BUILTIN_TEMPLATES = [
  /* Movement ------------------------------------------------------------------ */
  tpl("pace", "movement", "Pace back & forth", "Walks a line and back, pausing at each end — sentries, caged beasts.", {
    color: "#3fa7ff",
    steps: [step({type: "path", nodes: [N(0, 0), N(4, 0)]}, {wait: 600})],
    motion: {loop: "pingpong", loopCount: 0, speed: 2.5, easeIn: 250, easeOut: 250}
  }),
  tpl("zigzag", "movement", "Zig-zag charge", "Darts forward in sharp zig-zags, then stops.", {
    color: "#ff4f79",
    steps: [step({type: "wave", x0: 0, y0: 0, x1: 8, y1: 0, amplitude: 1, wavelength: 2, form: "zigzag"})],
    motion: {speed: 9, easeOut: 300}
  }),
  tpl("serpent", "movement", "Serpentine", "Slithers along a smooth S-curve and back.", {
    color: "#5ad17a",
    steps: [step({type: "wave", x0: 0, y0: 0, x1: 8, y1: 0, amplitude: 1, wavelength: 4, form: "sine"})],
    motion: {loop: "pingpong", loopCount: 0, speed: 3, easeIn: 300, easeOut: 300}
  }),
  tpl("charge", "movement", "Charge & return", "Rushes forward, pauses, and walks back to where it started.", {
    color: "#f78c40",
    steps: [step({type: "path", nodes: [N(0, 0), N(6, 0)]}, {wait: 500})],
    motion: {speed: 12, easeIn: 150, easeOut: 150, finish: "return"}
  }),
  tpl("shake", "movement", "Shake / tremble", "A fast tiny jitter in place — fear, cold, earthquakes, rage.", {
    color: "#e6e6e6",
    steps: [step({type: "path", nodes: [N(0, 0), N(0.08, 0)]})],
    motion: {loop: "pingpong", loopCount: 0, speed: 1.6},
    facing: {mode: "keep"}
  }),

  /* Loops & orbits ------------------------------------------------------------ */
  tpl("circle", "loops", "Circle loop", "Runs a circle that starts where the token stands, forever.", {
    color: "#3fa7ff",
    steps: [step({type: "ellipse", cx: -2, cy: 0, rx: 2, ry: 2, rotation: 0, sweep: 360})],
    motion: {...LOOP, speed: 3}
  }),
  tpl("orbit-face", "loops", "Orbit, facing inward", "Circles while always facing the centre — guarding, stalking, a bodyguard.", {
    color: "#9aa0ff",
    steps: [step({type: "ellipse", cx: -2, cy: 0, rx: 2, ry: 2, rotation: 0, sweep: 360})],
    motion: {...LOOP, speed: 2},
    facing: {mode: "center"}
  }),
  tpl("figure8", "loops", "Figure eight", "A smooth infinity loop.", {
    color: "#c56cf0",
    steps: [step({type: "figure8", cx: 0, cy: 0, w: 6, h: 3, rotation: 0})],
    motion: {...LOOP, speed: 3}
  }),
  tpl("square", "loops", "Square patrol", "Walks the four sides of a square, turning at each corner.", {
    color: "#f2c14e",
    steps: [step({type: "rect", cx: 2, cy: 2, w: 4, h: 4, rotation: 0, radius: 0})],
    motion: {...LOOP, speed: 2},
    facing: {mode: "path", smoothing: 0.4}
  }),
  tpl("pendulum", "loops", "Pendulum swing", "Swings along an arc and back, slowing at each end.", {
    color: "#2ed3c6",
    steps: [step({type: "ellipse", cx: -2.1213, cy: -2.1213, rx: 3, ry: 3, rotation: 45, sweep: 90})],
    motion: {loop: "pingpong", loopCount: 0, speed: 3, easeIn: 700, easeOut: 700},
    facing: {mode: "keep"}
  }),
  tpl("wander", "loops", "Wander loop", "Meanders around a smooth, irregular loop.", {
    color: "#5ad17a",
    steps: [step({type: "path", closed: true, nodes: [N(0, 0, 1), N(2, -1, 1), N(3.5, 0.8, 1), N(1.5, 2.6, 1), N(-1.2, 1.6, 1)]})],
    motion: {...LOOP, speed: 1.5},
    facing: {mode: "path", turnRate: 220}
  }),
  tpl("spiral-out", "loops", "Spiral out", "Unwinds outward in a widening spiral.", {
    color: "#ffb347",
    steps: [step({type: "spiral", cx: 0, cy: 0, r0: 0, r1: 3, turns: 3, rotation: 0})],
    motion: {speed: 4}
  }),
  tpl("spiral-in", "loops", "Spiral in", "Circles inward, tighter and tighter.", {
    color: "#ff7a3d",
    steps: [step({type: "spiral", cx: 0, cy: 0, r0: 0, r1: 3, turns: 3, rotation: 0}, {reverse: true})],
    motion: {speed: 4, easeOut: 400}
  }),

  /* Bounces & height ------------------------------------------------------------ */
  tpl("drop", "height", "Drop & bounce", "Falls from above, hits the floor and bounces to a stop — dropped loot, a thrown potion.", {
    color: "#ff6b35",
    steps: [step({type: "point", x: 0, y: 0}, {wait: 1800, lift: lift("bounce", 3, 4, 0.45)})],
    facing: {mode: "keep"}
  }),
  tpl("roll", "height", "Throw, bounce & roll", "Thrown forward: lands, bounces lower and lower, and rolls to a stop.", {
    color: "#f2c14e",
    steps: [step({type: "path", nodes: [N(0, 0), N(6, 0)]}, {lift: lift("bounce", 2.5, 5, 0.5)})],
    motion: {speed: 5, easeOut: 600},
    facing: {mode: "spin", spinSpeed: 540}
  }),
  tpl("skip", "height", "Stone skip", "Skips across the ground like a stone on water, each hop shorter and lower.", {
    color: "#3fa7ff",
    steps: [step({type: "path", nodes: [N(0, 0), N(12, 0)]}, {lift: lift("skip", 1.2, 6, 0.6)})],
    motion: {speed: 9, easeOut: 900},
    facing: {mode: "spin", spinSpeed: 720}
  }),
  tpl("lob", "height", "Lob / throw arc", "One high arc from here to six squares away.", {
    color: "#c56cf0",
    steps: [step({type: "path", nodes: [N(0, 0), N(6, 0)]}, {lift: lift("arc", 2.5)})],
    motion: {speed: 6}
  }),
  tpl("hops", "height", "Bunny hops", "Hops along a line in small even jumps.", {
    color: "#5ad17a",
    steps: [step({type: "path", nodes: [N(0, 0), N(6, 0)]}, {lift: lift("hops", 0.6, 6)})],
    motion: {speed: 3}
  }),
  tpl("hover", "height", "Hover", "Floats up and down in place — flying creatures, wisps, magic items.", {
    color: "#9aa0ff",
    steps: [step({type: "point", x: 0, y: 0}, {wait: 4000, lift: lift("bob", 0.35, 1, 0.5, 0.5)})],
    motion: {...LOOP},
    height: {rise: 0.5, scale: 0.12},
    facing: {mode: "keep"}
  }),
  tpl("leap", "height", "Leap & land", "A big jump forward that lands with two small bounces.", {
    color: "#ff4f79",
    steps: [
      step({type: "path", nodes: [N(0, 0), N(4, 0)]}, {lift: lift("arc", 2)}),
      step({type: "path", nodes: [N(4, 0), N(5, 0)]}, {lift: lift("skip", 0.35, 2, 0.4)})
    ],
    motion: {speed: 6, easeOut: 300}
  }),

  /* Kaleidoscope ------------------------------------------------------------------ */
  tpl("twin", "kaleidoscope", "Twin orbit (×2)", "A circle with a mirror twin on the opposite side — copies are real tokens.", {
    color: "#2ed3c6",
    steps: [step({type: "ellipse", cx: -2, cy: 0, rx: 2, ry: 2, rotation: 0, sweep: 360})],
    motion: {...LOOP, speed: 3},
    symmetry: {count: 2, mode: "rotate", center: "path"}
  }),
  tpl("bloom", "kaleidoscope", "Kaleidoscope bloom (×8)", "Eight copies trace petals around the token, mirrored like a kaleidoscope.", {
    color: "#ff4f79",
    steps: [step({type: "path", closed: true, nodes: [N(0, 0, 0), N(1.4, -1.5, 1), N(3, -1.1, 1), N(1.5, -0.2, 1)]})],
    motion: {...LOOP, speed: 2.5},
    symmetry: {count: 8, mode: "mirror", center: "origin"}
  }),
  tpl("cyclone", "kaleidoscope", "Cyclone (×6)", "Six copies spiral outward together, then reset — a vortex of blades or birds.", {
    color: "#ffb347",
    steps: [step({type: "spiral", cx: 0, cy: 0, r0: 0, r1: 3.5, turns: 1.5, rotation: 0})],
    motion: {...LOOP, loopConnector: "teleport", speed: 4},
    symmetry: {count: 6, mode: "rotate", center: "origin"}
  }),
  tpl("starburst", "kaleidoscope", "Starburst (×12)", "Twelve copies burst outward along straight rays and fly back.", {
    color: "#f2c14e",
    steps: [step({type: "path", nodes: [N(0, 0), N(3, 0)]})],
    motion: {loop: "pingpong", loopCount: 0, speed: 4, easeIn: 300, easeOut: 300},
    symmetry: {count: 12, mode: "rotate", center: "origin"}
  }),
  tpl("ring", "kaleidoscope", "Orbiting ring (×5)", "Five copies evenly spaced on one circle — a ring of guardians or floating blades.", {
    color: "#9aa0ff",
    steps: [step({type: "ellipse", cx: -2, cy: 0, rx: 2, ry: 2, rotation: 0, sweep: 360})],
    motion: {...LOOP, speed: 2},
    facing: {mode: "center", reverse: true},
    symmetry: {count: 5, mode: "rotate", center: "path"}
  }),

  /* Behaviours ---------------------------------------------------------------- */
  tpl("sentry", "behaviour", "Sentry (face nearest enemy)", "Stands still and turns smoothly to watch the nearest enemy.", {
    color: "#ff5d6c",
    steps: [step({type: "point", x: 0, y: 0}, {wait: 5000})],
    motion: {...LOOP},
    facing: {mode: "target", turnRate: 180, target: {rule: "nearest", group: "enemies"}}
  }),
  tpl("patrol-watch", "behaviour", "Patrol & watch", "Paces back and forth while keeping its eyes on the nearest enemy.", {
    color: "#f78c40",
    steps: [step({type: "path", nodes: [N(0, 0), N(4, 0)]}, {wait: 400})],
    motion: {loop: "pingpong", loopCount: 0, speed: 2, easeIn: 300, easeOut: 300},
    facing: {mode: "target", turnRate: 240, target: {rule: "nearest", group: "enemies"}}
  }),
  tpl("vulture", "behaviour", "Vulture (circle the wounded)", "Circles while staring at the most wounded enemy in sight.", {
    color: "#c56cf0",
    steps: [step({type: "ellipse", cx: -2.5, cy: 0, rx: 2.5, ry: 2.5, rotation: 0, sweep: 360})],
    motion: {...LOOP, speed: 2},
    facing: {mode: "target", turnRate: 200, target: {rule: "mostDamaged", group: "enemies"}}
  }),
  tpl("waltz", "behaviour", "Waltz (turn with the path)", "Circles while turning with the curve, keeping its starting facing — a dancer, a turret, a spinning top.", {
    color: "#2ed3c6",
    steps: [step({type: "ellipse", cx: -1.5, cy: 0, rx: 1.5, ry: 1.5, rotation: 0, sweep: 360})],
    motion: {...LOOP, speed: 2},
    facing: {mode: "turn"}
  }),

  /* Attacks -------------------------------------------------------------------- */
  // Orbits follow the first token you target; homing legs fly at your (other) targets and re-aim if they move.
  tpl("orbs", "attacks", "Orbiting orbs (×3)", "Three orbs circle the token you target, spinning, forever. Select the orb, target (T) who it circles.", {
    color: "#7cc8ff",
    steps: [ring(1.5)],
    motion: {...LOOP, ...FOLLOW, speed: 3},
    facing: SPIN(0.75),
    symmetry: {count: 3, mode: "rotate", center: "path"}
  }),
  tpl("blade-storm", "attacks", "Blade storm (×6)", "Six whirling blades race around the targeted token — a blade barrier, a storm of daggers.", {
    color: "#e6e6e6",
    steps: [ring(2)],
    motion: {...LOOP, ...FOLLOW, speed: 7},
    facing: SPIN(2.5),
    symmetry: {count: 6, mode: "rotate", center: "path"}
  }),
  tpl("shield-orbit", "attacks", "Spinning shields (×4)", "Four shields orbit close around the targeted token, always facing outward.", {
    color: "#f2c14e",
    steps: [ring(1)],
    motion: {...LOOP, ...FOLLOW, speed: 1.5},
    facing: {mode: "center", reverse: true, smoothing: 0},
    symmetry: {count: 4, mode: "rotate", center: "path"}
  }),
  tpl("orbit-strike", "attacks", "Orbit & strike (×4)", "Four orbs circle the first token you target twice, then dive at your other targets (or at it, if it is the only one).", {
    color: "#c56cf0",
    steps: [step(ring(1.5).shape, {laps: 2}), hit(0.4)],
    motion: {...FOLLOW, speed: 5, finish: "teleport"},
    facing: {mode: "path", smoothing: 0.1},
    symmetry: {count: 4, mode: "rotate", center: "path"}
  }),
  tpl("hammer", "attacks", "Homing hammer", "Spins through the air at your target, following it if it dodges, and flies back to the thrower.", {
    color: "#c0c8d8",
    steps: [hit(0.15, {wait: 150}), home(0.15)],
    motion: {speed: 10, easeIn: 120, easeOut: 120},
    facing: SPIN(2.5)
  }),
  tpl("hammer-barrage", "attacks", "Hammer barrage (×3)", "Three hammers fan out, each to one of your targets (or all at one), then return.", {
    color: "#9fb4d8",
    steps: [hit(0.35, {wait: 150}), home(0.35)],
    motion: {speed: 10, easeIn: 120, easeOut: 120},
    facing: SPIN(2.5),
    symmetry: {count: 3, mode: "rotate", center: "origin"}
  }),
  tpl("boomerang", "attacks", "Boomerang", "A wide curving throw that loops around the target and back to the thrower.", {
    color: "#f78c40",
    steps: [hit(0.8), home(0.8)],
    motion: {speed: 8},
    facing: SPIN(2)
  }),
  tpl("missiles", "attacks", "Magic missiles (×3)", "Three darts streak to your targets on curving paths, then reset to the caster.", {
    color: "#c56cf0",
    steps: [hit(0.55)],
    motion: {speed: 14, finish: "teleport"},
    facing: {mode: "path", smoothing: 0.08},
    symmetry: {count: 3, mode: "rotate", center: "origin"}
  }),
  tpl("volley", "attacks", "Arrow volley (×5)", "Five arrows arc high and rain down on your targets.", {
    color: "#a8d672",
    steps: [hit(0.2, {lift: lift("arc", 1.2)})],
    motion: {speed: 13, finish: "teleport"},
    facing: {mode: "path", smoothing: 0.05},
    symmetry: {count: 5, mode: "rotate", center: "origin"}
  }),
  tpl("ricochet", "attacks", "Ricochet chain", "Bounces from target to target — up to three, in the order you targeted them — then flies home.", {
    color: "#2ed3c6",
    steps: [hit(0.1, {wait: 80}), hit(0.2, {wait: 80}, 1), hit(-0.2, {wait: 80}, 2), home(0.1)],
    motion: {speed: 12},
    facing: {mode: "path", smoothing: 0.1}
  }),
  tpl("fireball", "attacks", "Lobbed fireball", "A high lob that lands right on your target.", {
    color: "#ff6b35",
    steps: [hit(0, {lift: lift("arc", 2.5)})],
    motion: {speed: 7},
    facing: {mode: "path", smoothing: 0.2}
  }),
  tpl("meteor", "attacks", "Meteor strike", "Drops from the sky onto the target and bounces as it crashes down.", {
    color: "#ff4f4f",
    steps: [hit(0, {lift: lift("bounce", 4, 3, 0.35)})],
    motion: {speed: 6},
    facing: SPIN(1)
  }),
  tpl("dash", "attacks", "Dash strike", "Lunges to stop one square short of the target, pauses for the hit, then steps back.", {
    color: "#ff4f79",
    steps: [hit(0, {wait: 450}, 0, 1), home(0, {speedMul: 0.35})],
    motion: {speed: 16, easeIn: 100, easeOut: 150},
    facing: {mode: "path", smoothing: 0.15}
  }),
  tpl("pounce", "attacks", "Pounce", "Leaps through the air and lands next to the target.", {
    color: "#f78c40",
    steps: [hit(0, {lift: lift("arc", 1.5)}, 0, 0.6)],
    motion: {speed: 9, easeOut: 120},
    facing: {mode: "path", smoothing: 0.15}
  }),
  tpl("shockwave", "attacks", "Shockwave ring (×12)", "Twelve shards burst outward in a ring, then reset — a nova, a war cry, an explosion.", {
    color: "#ffd166",
    steps: [step({type: "path", nodes: [N(0, 0), N(3, 0)]})],
    motion: {speed: 9, easeOut: 400, finish: "teleport"},
    facing: {mode: "path", smoothing: 0},
    symmetry: {count: 12, mode: "rotate", center: "origin"}
  })
];
