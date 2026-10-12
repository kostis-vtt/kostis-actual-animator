// Shared constants for Kostis's Actual Animator.

export const MODULE_ID = "kostis-actual-animator";
export const MODULE_TITLE = "Kostis's Actual Animator";

/** Name of the canvas layer (canvas[LAYER_NAME]) and of its scene-control group. */
export const LAYER_NAME = "kaaPaths";

/** Scene flag key holding the animation definitions of a scene. */
export const FLAG_ANIMS = "animations";

/** Token flag key holding the active playback of a token. */
export const FLAG_PLAYBACK = "playback";

/** Render-option key used to tag our own database updates. */
export const OPT_KEY = MODULE_ID;

/** Geometric flattening tolerance in pixels. Paths are traced to within this distance. */
export const FLATTEN_TOLERANCE = 0.05;

/** Shape types a step can hold. */
export const SHAPE_TYPES = {
  path: {label: "Curve / Line", icon: "fa-solid fa-bezier-curve"},
  ellipse: {label: "Circle / Ellipse", icon: "fa-regular fa-circle"},
  rect: {label: "Square / Rectangle", icon: "fa-regular fa-square"},
  polygon: {label: "Polygon / Star", icon: "fa-solid fa-star"},
  spiral: {label: "Spiral", icon: "fa-solid fa-hurricane"},
  wave: {label: "Wave / Zig-zag", icon: "fa-solid fa-wave-square"},
  figure8: {label: "Figure eight", icon: "fa-solid fa-infinity"},
  point: {label: "Waypoint", icon: "fa-solid fa-location-dot"},
  homing: {label: "Homing leg", icon: "fa-solid fa-crosshairs"}
};

/** Where a homing leg flies to. */
export const HOMING_TARGETS = {
  target: "A targeted token",
  home: "Back to its start",
  anchor: "The anchor token",
  token: "A specific token"
};

/** Canvas tools of the animator layer. Order matters for the toolbar. */
export const TOOLS = {
  kaaEdit: {title: "Select & edit (drag nodes, handles, shapes)", icon: "fa-solid fa-arrow-pointer"},
  kaaPen: {title: "Curve / line pen — click to add nodes, drag to pull curve handles, click the first node to close", icon: "fa-solid fa-pen-nib", shape: "path"},
  kaaFreehand: {title: "Freehand — drag to draw a smooth path", icon: "fa-solid fa-signature", shape: "path"},
  kaaEllipse: {title: "Circle / ellipse — drag from the centre (Shift: circle)", icon: "fa-regular fa-circle", shape: "ellipse"},
  kaaRect: {title: "Square / rectangle — drag corner to corner (Shift: square, Alt: from centre)", icon: "fa-regular fa-square", shape: "rect"},
  kaaPolygon: {title: "Polygon / star — drag from the centre", icon: "fa-solid fa-draw-polygon", shape: "polygon"},
  kaaSpiral: {title: "Spiral — drag from the centre", icon: "fa-solid fa-hurricane", shape: "spiral"},
  kaaWave: {title: "Wave / zig-zag — drag from start to end", icon: "fa-solid fa-wave-square", shape: "wave"},
  kaaFigure8: {title: "Figure eight — drag from the centre", icon: "fa-solid fa-infinity", shape: "figure8"},
  kaaPoint: {title: "Waypoint — click to place a stop", icon: "fa-solid fa-location-dot", shape: "point"}
};

export const SPEED_UNITS = {
  grid: "squares / s",
  units: "scene units / s",
  px: "pixels / s"
};

export const FACING_MODES = {
  keep: {label: "Static", icon: "fa-solid fa-lock", hint: "The token keeps the facing it started with."},
  path: {label: "Follow path", icon: "fa-solid fa-route", hint: "Face the direction of travel, turning smoothly with the curve."},
  turn: {label: "Turn with path", icon: "fa-solid fa-rotate-right", hint: "Keep the starting facing, but turn exactly as much as the path turns — circling slowly spins the token the same way."},
  spin: {label: "Spin", icon: "fa-solid fa-rotate", hint: "Rotate continuously at a fixed speed."},
  fixed: {label: "Fixed angle", icon: "fa-solid fa-compass", hint: "Hold one exact angle for the whole run."},
  center: {label: "Face centre", icon: "fa-solid fa-crosshairs", hint: "Face the centre of the current shape (great for orbits)."},
  point: {label: "Face point", icon: "fa-solid fa-location-crosshairs", hint: "Always face a chosen point on the map."},
  token: {label: "Face token", icon: "fa-solid fa-user-large", hint: "Track another token, even while it moves."},
  target: {label: "Smart target", icon: "fa-solid fa-bullseye", hint: "Always look at the nearest, farthest, most or least wounded token of a group — enemies, allies, players, anyone, or your own chosen group."}
};

/** Offset (degrees) to add to a travel direction for token art that faces a given way at rotation 0. */
export const ART_FACING = {
  down: {label: "Down (Foundry default)", offset: -90},
  up: {label: "Up", offset: 90},
  right: {label: "Right", offset: 0},
  left: {label: "Left", offset: 180}
};

export const EASE_PRESETS = {
  none: {label: "None", in: 0, out: 0},
  gentle: {label: "Gentle", in: 250, out: 250},
  smooth: {label: "Smooth", in: 600, out: 600},
  heavy: {label: "Heavy", in: 1200, out: 1200}
};

export const PALETTE = ["#ff6b35", "#3fa7ff", "#5ad17a", "#f2c14e", "#c56cf0", "#ff4f79", "#2ed3c6", "#f78c40",
  "#9aa0ff", "#e6e6e6"];
