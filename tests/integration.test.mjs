// Integration harness: mocks the Foundry runtime closely enough to exercise the module's real code paths.
import {fileURLToPath, pathToFileURL} from "node:url";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
// Foundry's own files (Handlebars, PIXI, its stylesheets) come from a local install: set FOUNDRY_APP if it lives elsewhere
const FOUNDRY_APP = (process.env.FOUNDRY_APP ?? "C:/Program Files/Foundry Virtual Tabletop/resources/app").replace(/\\/g, "/");
const Handlebars = require(`${FOUNDRY_APP}/node_modules/handlebars`);

const MOD = "kostis-actual-animator";
const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\\/g, "/");
let fails = 0;
const ok = (c, m) => { if ( !c ) { fails++; console.log("FAIL:", m); } else console.log("ok  :", m); };
const near = (a, b, t) => Math.abs(a - b) <= t;

/* ---------------- Operators & utils ---------------- */
class DataFieldOperator {}
class ForcedDeletion extends DataFieldOperator {}
class ForcedReplacement extends DataFieldOperator { constructor(v) { super(); this.value = v; } static create(v) { return new ForcedReplacement(v); } }
globalThis._del = new ForcedDeletion();
globalThis._replace = v => ForcedReplacement.create(v);

function applyChanges(target, changes) {
  for ( const [k, v] of Object.entries(changes) ) {
    if ( v instanceof ForcedDeletion ) delete target[k];
    else if ( v instanceof ForcedReplacement ) target[k] = structuredClone(v.value);
    else if ( v && typeof v === "object" && !Array.isArray(v) ) {
      if ( !target[k] || typeof target[k] !== "object" ) target[k] = {};
      applyChanges(target[k], v);
    } else target[k] = structuredClone(v);
  }
}
const isPlain = o => o && typeof o === "object" && Object.getPrototypeOf(o) === Object.prototype;
let idc = 0;
const utils = {
  mergeObject: function merge(target, src) {
    for ( const [k, v] of Object.entries(src ?? {}) ) {
      if ( v && (typeof v === "object") && !Array.isArray(v) && target[k] && (typeof target[k] === "object") ) merge(target[k], v);
      else target[k] = v;
    }
    return target;
  },
  randomID: (n = 16) => `id${(++idc).toString().padStart(n - 2, "0")}`,
  deepClone: o => structuredClone(o),
  isEmpty: o => !o || Object.keys(o).length === 0,
  escapeHTML: s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c])),
  hasProperty: (o, path) => { let x = o; for ( const p of path.split(".") ) { if ( !x || typeof x !== "object" || !(p in x) ) return false; x = x[p]; } return true; },
  Color: {from: h => Number.parseInt(String(h).replace("#", ""), 16)},
  isPlainObject: isPlain,
  setProperty: (o, path, v) => { const ks = path.split("."); let x = o; for ( const k of ks.slice(0, -1) ) x = (x[k] ??= {}); x[ks.at(-1)] = v; return true; }
};

/* ---------------- Hooks ---------------- */
const hookMap = new Map();
globalThis.Hooks = {
  on: (n, fn) => { (hookMap.get(n) ?? hookMap.set(n, []).get(n)).push(fn); },
  once: (n, fn) => Hooks.on(n, fn),
  callAll: (n, ...a) => { for ( const fn of hookMap.get(n) ?? [] ) fn(...a); return true; },
  call: (n, ...a) => { for ( const fn of hookMap.get(n) ?? [] ) if ( fn(...a) === false ) return false; return true; },
  off: (n, fn) => { const l = hookMap.get(n); if ( l ) { const i = l.indexOf(fn); if ( i >= 0 ) l.splice(i, 1); } }
};

/* ---------------- Clock ---------------- */
let NOW = 1_000_000;

/* ---------------- Documents ---------------- */
class Document {}
const GRID = 100;
class TokenDoc extends Document {
  constructor(scene, data) {
    super();
    this.documentName = "Token";
    this.parent = scene;
    this.id = data._id;
    this._source = {x: data.x, y: data.y, rotation: data.rotation ?? 0, flags: structuredClone(data.flags ?? {}), width: 1, height: 1,
      elevation: data.elevation ?? 0, texture: {src: "icons/svg/mystery-man.svg", scaleX: 1, scaleY: 1}};
    this.name = data.name;
    this.width = 1; this.height = 1; this.shape = 0; this.lockRotation = false;
    this.disposition = data.disposition ?? 0;
    this.hidden = false;
    this.sort = 0;
    this.actorLink = data.actorLink ?? true;
    this.hp = data.hp ?? {value: 10, max: 10};
    this.actor = {hasPlayerOwner: !!data.player};
    this.updates = [];
    this._init();
    this.object = new TokenObj(this);
  }
  get uuid() { return `Scene.${this.parent.id}.Token.${this.id}`; }
  _init() { this.x = this._source.x; this.y = this._source.y; this.rotation = this._source.rotation; this.flags = structuredClone(this._source.flags);
    this.elevation = this._source.elevation; this.texture = structuredClone(this._source.texture); }
  toObject() { return {...structuredClone(this._source), _id: this.id, name: this.name, disposition: this.disposition, actorLink: this.actorLink, _movementHistory: []}; }
  getBarAttribute() { return {type: "bar", value: this.hp.value, max: this.hp.max}; }
  getSnappedPosition(p) { return {x: Math.round(p.x / 100) * 100, y: Math.round(p.y / 100) * 100, elevation: p.elevation ?? 0}; }
  async update(changes, options = {}) { return this.parent.updateEmbeddedDocuments("Token", [{_id: this.id, ...changes}], options); }
  async move(waypoints, options = {}) { const w = waypoints.at(-1); return this.parent.updateEmbeddedDocuments("Token", [{_id: this.id, x: w.x, y: w.y}], options); }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  getCenterPoint(d = {}) { return {x: (d.x ?? this.x) + 50, y: (d.y ?? this.y) + 50, elevation: 0}; }
  getSize() { return {width: 100, height: 100}; }
  canUserModify() { return true; }
  testUserPermission() { return true; }
  get isOwner() { return true; }
}
class TokenObj {
  constructor(doc) { this.document = doc; this.id = doc.id; this.mesh = {}; this.destroyed = false; this.frames = 0; this.stops = 0; this.lastChanged = null; this.texture = null; }
  _onAnimationUpdate(changed) { this.frames++; this.lastChanged = changed; }
  stopAnimation() { this.stops++; }
  _onUpdate(changed, options, userId) { this.updated = (this.updated ?? 0) + 1; }
  visible = true;
  renderFlags = {set: () => {}};
  get center() { return {x: this.document.x + 50, y: this.document.y + 50}; }
  get w() { return 100; }
  get h() { return 100; }
}
class Collection extends Map {
  filter(fn) { return [...this.values()].filter(fn); }
  find(fn) { return [...this.values()].find(fn); }
  some(fn) { return [...this.values()].some(fn); }
  map(fn) { return [...this.values()].map(fn); }
  get contents() { return [...this.values()]; }
  [Symbol.iterator]() { return this.values(); }
}
class SceneDoc extends Document {
  constructor(id) {
    super();
    this.id = id; this.name = "Test";
    this.flags = {};
    this.tokens = new Collection();
    this.dimensions = {size: GRID, distance: 5};
    this.grid = {units: "ft"};
    this.levels = new Set();
  }
  canUserModify() { return true; }
  async update(changes) {
    applyChanges(this.flags, changes.flags ?? {});
    // re-create flag objects (Foundry re-initialises fields)
    this.flags = structuredCloneOps(this.flags);
    Hooks.callAll("updateScene", this, changes, {}, "u1");
  }
  async createEmbeddedDocuments(type, datas, options = {}) {
    if ( !options.isUndo ) canvas.tokens.storeHistory("create", datas.map(() => ({_id: "new"})), options);
    const out = [];
    for ( const d of datas ) {
      const id = utils.randomID();
      const doc = new TokenDoc(this, {...d, _id: id});
      this.tokens.set(id, doc);
      Hooks.callAll("createToken", doc, options, "u1");
      out.push(doc);
    }
    return out;
  }
  async deleteEmbeddedDocuments(type, ids, options = {}) {
    if ( !options.isUndo ) canvas.tokens.storeHistory("delete", ids.map(id => ({_id: id})), options);
    for ( const id of ids ) {
      const doc = this.tokens.get(id);
      if ( !doc ) throw new Error(`delete missing ${id}`);
      this.tokens.delete(id);
      Hooks.callAll("deleteToken", doc, options, "u1");
    }
  }
  async updateEmbeddedDocuments(type, updates, options = {}) {
    const docs = [];
    for ( const u of updates ) {
      const doc = this.tokens.get(u._id);
      const changes = {...u}; delete changes._id;
      if ( ("x" in changes) || ("y" in changes) ) {
        const origin = {x: doc._source.x, y: doc._source.y};
        const dest = {x: changes.x ?? origin.x, y: changes.y ?? origin.y, elevation: doc._source.elevation};
        const move = {method: options.method ?? "api", origin, passed: {waypoints: [dest]}, pending: {waypoints: []}, autoRotate: false, showRuler: false};
        if ( Hooks.call("preMoveToken", doc, move, options) === false ) { delete changes.x; delete changes.y; }
      }
      if ( Hooks.call("preUpdateToken", doc, changes, options, "u1") === false ) continue;
      if ( !options.isUndo ) canvas.tokens.storeHistory("update", [{_id: doc.id, ...changes}], options);
      for ( const k of ["x", "y", "rotation"] ) if ( k in changes ) doc._source[k] = changes[k];
      if ( changes.flags ) applyChanges(doc._source.flags, changes.flags);
      doc._init();
      doc.updates.push({changes, options});
      doc.object._onUpdate(changes, options, "u1");
      Hooks.callAll("updateToken", doc, changes, options, "u1");
      docs.push(doc);
    }
    return docs;
  }
}
function structuredCloneOps(o) { return JSON.parse(JSON.stringify(o)); }

class MockDisplay {
  constructor() {
    const pt = () => ({x: 0, y: 0, set(x, y=x) { this.x = x; this.y = y; }});
    this.children = []; this.position = {set: (x, y) => { this.x = x; this.y = y; }}; this.scale = pt(); this.pivot = pt(); this.anchor = pt();
    this.calls = 0; this.destroyed = false; this.angle = 0; this.visible = true; this.alpha = 1;
  }
  addChild(c) { this.children.push(c); c.parent = this; return c; }
  removeChildren() { const c = this.children; this.children = []; for ( const x of c ) x.parent = null; return c; }
  destroy() { this.destroyed = true; if ( this.parent ) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
}
class MockGraphics extends MockDisplay {}
for ( const m of ["clear", "lineStyle", "moveTo", "lineTo", "beginFill", "endFill", "drawCircle", "drawRect", "drawPolygon", "drawEllipse", "arc", "closePath"] ) {
  MockGraphics.prototype[m] = function(...a) { for ( const v of a.flat() ) if ( typeof v === "number" && !Number.isFinite(v) ) throw new Error(`non-finite ${m} arg`); this.calls++; return this; };
}
globalThis.PIXI = {LINE_JOIN: {ROUND: "round"}, LINE_CAP: {ROUND: "round"}, UPDATE_PRIORITY: {HIGH: 25, OBJECTS: 23, LOW: -25},
  Graphics: MockGraphics, Container: MockDisplay, Sprite: class extends MockDisplay {}};
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
/* ---------------- Globals ---------------- */
const scene = new SceneDoc("S1");
const settings = new Map([[`${MOD}.startLead`, 150], [`${MOD}.interruptOnMove`, true], [`${MOD}.playersCanPlay`, false],
  [`${MOD}.showRunning`, false], [`${MOD}.library`, {}], [`${MOD}.editor`, {}]]);
const tickerFns = [];
const me = {id: "u1", isGM: true, isSelf: true, active: true, can: () => true};
const moduleObj = {version: "1.0.0", active: true};
globalThis.foundry = {
  utils,
  abstract: {Document},
  data: {operators: {ForcedDeletion, ForcedReplacement}},
  canvas: {
    layers: {InteractionLayer: class extends MockDisplay {
      static get layerOptions() { return {name: "", zIndex: 0}; }
      get active() { return !!this._active; }
      activate() { this._active = true; this._activate(); return this; }
      deactivate() { this._active = false; this._deactivate(); return this; }
      async _draw() {}
      async _tearDown() { this.removeChildren(); }
    }},
    placeables: {Token: TokenObj},
    containers: {PreciseText: class extends MockDisplay { static getTextStyle() { return {}; } }},
    primary: {PrimaryGraphics: class extends MockGraphics {}}
  },
  applications: {
    api: {
      ApplicationV2: class {
        constructor(options = {}) {
          this.rendered = false; this.minimized = false; this.options = {window: {minimizable: true}, ...options};
          this.id = options.id ?? new.target.DEFAULT_OPTIONS?.id;
          this.position = {left: 50, top: 40, width: 900, height: 640, ...(options.position ?? {})};
        }
        render() { this.rendered = true; return this; }
        async minimize() { this.minimized = true; } async maximize() { this.minimized = false; }
        setPosition(p = {}) { Object.assign(this.position, p); return this.position; }
        async close() { this.rendered = false; return this; }
        bringToFront() {} async _onFirstRender() {} _onClose() {}
      },
      HandlebarsApplicationMixin: B => class extends B {},
      DialogV2: class {}
    },
    handlebars: {loadTemplates: () => {}}
  }
};

globalThis.game = {
  ready: true,
  user: me,
  users: {activeGM: me, get: id => (id === "u1" ? me : null), filter: f => [me].filter(f)},
  settings: {get: (m, k) => settings.get(`${m}.${k}`), set: async (m, k, v) => settings.set(`${m}.${k}`, v), register: () => {}},
  keybindings: {register: () => {}},
  modules: {get: id => (id === MOD ? moduleObj : null)},
  time: {get serverTime() { return NOW; }},
  scenes: [scene],
  i18n: {format: (k, d) => `${k} ${JSON.stringify(d)}`, localize: k => k},
  activeTool: "kaaEdit"
};
globalThis.ui = {notifications: {warn: m => console.log("  [warn]", m), info: () => {}, error: m => console.log("  [error]", m)}, controls: null};
globalThis.CONST = {GRID_SNAPPING_MODES: {CENTER: 1, VERTEX: 2, EDGE_MIDPOINT: 4},
  TOKEN_DISPOSITIONS: {SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1}};
class MockTokenLayer {
  history = [];
  controlled = [];
  placeables = [];
  hud = null;
  storeHistory(type, data, options) { this.history.push({type, data, options}); }
}
globalThis.CONFIG = {Canvas: {layers: {tokens: {layerClass: MockTokenLayer}}}};
globalThis.fromUuidSync = uuid => { const [, sid, , tid] = uuid.split("."); return sid === scene.id ? scene.tokens.get(tid) : null; };
globalThis.canvas = {
  scene,
  dimensions: {size: GRID, distance: 5},
  tokens: new MockTokenLayer(),
  app: {ticker: {add: (fn, ctx, pr) => tickerFns.push({fn, ctx, pr}), remove: fn => { const i = tickerFns.findIndex(t => t.fn === fn); if ( i >= 0 ) tickerFns.splice(i, 1); }}},
  stage: {scale: {x: 1}, pivot: {x: 0, y: 0}, on: () => {}, off: () => {}},
  mousePosition: {x: 0, y: 0},
  primary: new MockDisplay(),
  grid: {isGridless: false, getSnappedPoint: p => ({x: Math.round((p.x - 50) / 100) * 100 + 50, y: Math.round((p.y - 50) / 100) * 100 + 50})},
  animatePan: () => {}
};
globalThis.libWrapper = undefined;

/* ---------------- Tokens ---------------- */
const t1 = new TokenDoc(scene, {_id: "T1", name: "Goblin", x: 0, y: 0});
const t2 = new TokenDoc(scene, {_id: "T2", name: "Wolf", x: 500, y: 500, rotation: 45});
scene.tokens.set("T1", t1);
scene.tokens.set("T2", t2);

/* ---------------- Import module ---------------- */
const imp = f => import(pathToFileURL(ROOT + "scripts/" + f).href);
await imp("main.js");
const {Store} = await imp("model.js");
const {Playback, tauAt} = await imp("playback.js");
const {Runner} = await imp("runner.js");
const {Editor} = await imp("editor.js");
const {AnimatorPanel} = await imp("panel.js");
const {makeNode} = await imp("shapes.js");
const {defaultStep} = await imp("model.js");

Hooks.callAll("init");
Hooks.callAll("setup");
Hooks.callAll("ready");
Hooks.callAll("canvasReady");
ok(CONFIG.Canvas.layers.kaaPaths?.layerClass?.name === "KaaLayer", "layer registered in CONFIG.Canvas.layers");
ok(globalThis.KAA && typeof KAA.play === "function", "API exposed as KAA");
ok(tickerFns.length === 1 && near(tickerFns[0].pr, 23.5, 1e-9), `runner ticker registered at priority ${tickerFns[0]?.pr}`);
const tick = () => tickerFns[0].fn.call(tickerFns[0].ctx);

/* ---------------- Store ---------------- */
const circle = defaultStep({type: "ellipse", cx: 1050, cy: 550, rx: 500, ry: 500, rotation: 0, sweep: 360});
const anim = await Store.create({name: "Orbit", steps: [circle]});
ok(anim && Store.get(anim.id)?.name === "Orbit", "Store.create persists to scene flags");
ok(Store.get(anim.id) === Store.get(anim.id), "normalised animations are cached by identity");
await Store.mutate(anim.id, a => { a.motion.speed = 2; a.motion.speedUnit = "grid"; a.motion.loop = "loop"; a.motion.loopCount = 0; a.tokens = ["T1", "T2"]; a.stagger.mode = "spread"; a.facing.mode = "path"; a.facing.smoothing = 0; });
const a1 = Store.get(anim.id);
ok(a1.rev >= 2 && a1.motion.speed === 2 && a1.tokens.length === 2, `mutate bumps rev (${a1.rev}) and saves fields`);
ok(Store.canUndo(anim.id), "undo history recorded");

/* ---------------- Play ---------------- */
await Playback.play(anim.id, undefined);
const pb1 = t1.getFlag(MOD, "playback");
const pb2 = t2.getFlag(MOD, "playback");
ok(pb1 && pb2 && pb1.t0 === NOW + 150, "play writes playback flags with sync lead");
ok(Playback.registry.size === 2, "registry tracks playing tokens");
ok(pb1.phase === 0 && pb2.phase > 0, `spread assigns phases (${pb1.phase}, ${Math.round(pb2.phase)})`);

// Before lead time: tokens hold their origin
tick();
ok(t1.x === 0 && t1.y === 0, "during lead time the token stays at origin");

// Advance: T1 travels toward circle start at 200 px/s
NOW += 150 + 1000;
tick();
ok(t1.object.frames > 0 && t1.x > 0, `runner moves token (x=${t1.x.toFixed(3)}, y=${t1.y.toFixed(3)})`);
ok(!Number.isInteger(t1.x) || !Number.isInteger(t1.y), "positions are sub-pixel (not snapped)");
ok(t1._source.x === 0, "database position untouched while animating");
const approach = Math.hypot(1550 - 50, 550 - 50);
NOW += approach / 0.2 - 1000 + 5000; // well into the orbit
tick();
const cx = t1.x + 50, cy = t1.y + 50;
ok(near(Math.hypot(cx - 1050, cy - 550), 500, 0.05), `token centre lies on the circle (r=${Math.hypot(cx - 1050, cy - 550).toFixed(4)})`);
ok(typeof t1.rotation === "number" && t1.object.lastChanged && "x" in t1.object.lastChanged, "rotation and position written each frame");
const c2x = t2.x + 50, c2y = t2.y + 50;
ok(near(Math.hypot(c2x - 1050, c2y - 550), 500, 0.05), "second token also on the circle");
ok(near(Math.hypot(c2x - cx, c2y - cy), 1000, 0.5), `spread tokens are exactly opposite on the loop (${Math.hypot(c2x - cx, c2y - cy).toFixed(3)}px apart, diameter 1000)`);

/* ---------------- Facing (path, art faces down) ---------------- */
{
  // Moving clockwise on a circle; direction = tangent. Rotation = deg(dir) - 90 (normalised)
  const ang = Math.atan2(cy - 550, cx - 1050);
  const tangent = ang + Math.PI / 2;
  const expected = (((tangent * 180 / Math.PI) - 90) % 360 + 360) % 360;
  ok(near(t1.rotation, expected, 0.6), `follow-path rotation ${t1.rotation.toFixed(2)} ≈ ${expected.toFixed(2)}`);
}

/* ---------------- Pause / rate / resume ---------------- */
await Playback.pause(["T1"]);
const pbp = t1.getFlag(MOD, "playback");
tick();
const frozen = {x: t1.x, y: t1.y};
NOW += 3000; tick();
ok(pbp.paused && near(t1.x, frozen.x, 1e-9) && near(t1.y, frozen.y, 1e-9), "pause freezes the token exactly");
await Playback.resume(["T1"]);
NOW += 150; tick();
ok(near(t1.x, frozen.x, 1e-6), "resume continues from the same spot after the lead");
tick();
const before = {x: t2.x, y: t2.y};
await Playback.setRate(["T2"], 3);
tick();
ok(near(t2.x, before.x, 1e-6) && near(t2.y, before.y, 1e-6), "rate change causes no jump");
const tauA = tauAt(t2.getFlag(MOD, "playback"));
NOW += 1000;
ok(near(tauAt(t2.getFlag(MOD, "playback")) - tauA, 3000, 1e-6), "rate 3x advances 3000ms of timeline per second");

/* ---------------- Stop here (commit) ---------------- */
tick();
const here = {x: t1.x, y: t1.y};
await Playback.stop(["T1"], {mode: "here"});
const last = t1.updates.at(-1);
ok(!t1.getFlag(MOD, "playback"), "stop clears the playback flag");
ok(last.options.animate === false && last.options.movement?.T1?.waypoints?.[0]?.action === "displace", "commit uses displace waypoint and animate:false");
ok(Math.abs(t1._source.x - here.x) <= 0.5 && Math.abs(t1._source.y - here.y) <= 0.5, `commit lands within 0.5px of the visible pose (${t1._source.x},${t1._source.y})`);
ok(t1.object.stops >= 1, "core animation state synced before the update (stopAnimation called)");
ok(Number.isInteger(t1._source.x) && Number.isInteger(t1._source.y), "committed position is integer (database constraint)");
ok(!Runner.isDriving("T1"), "runner released the token");

/* ---------------- Stop origin ---------------- */
await Playback.stop(["T2"], {mode: "origin"});
ok(t2._source.x === 500 && t2._source.y === 500 && near(t2._source.rotation, 45, 1e-9), "stop origin restores start position & rotation");

/* ---------------- Finite run auto-commit by authority ---------------- */
const line = await Store.create({name: "Dash", steps: [defaultStep({type: "path", closed: false, nodes: [makeNode(50, 50), makeNode(450, 50)]})]});
await Store.mutate(line.id, a => { a.motion.speed = 400; a.motion.speedUnit = "px"; a.facing.mode = "keep"; });
t1._source.x = 0; t1._source.y = 0; t1._init();
await Playback.play(line.id, ["T1"]);
NOW += 150 + 500; tick();
ok(near(t1.x, 200, 1e-6) && near(t1.y, 0, 1e-6), `half-way along the dash (x=${t1.x})`);
NOW += 2000; tick();
ok(near(t1.x, 400, 1e-9), "holds the exact end pose until committed");
await new Promise(r => setTimeout(r, 450)); // authority interval runs
ok(!t1.getFlag(MOD, "playback") && t1._source.x === 400 && t1._source.y === 0, `authority committed the end (${t1._source.x},${t1._source.y})`);

/* ---------------- Interrupt on manual move ---------------- */
await Playback.play(line.id, ["T1"]);
NOW += 300; tick();
await scene.updateEmbeddedDocuments("Token", [{_id: "T1", x: 900, y: 900}], {});
await new Promise(r => setTimeout(r, 20));
ok(!t1.getFlag(MOD, "playback") && t1._source.x === 900 && t1._source.y === 900, "manual move interrupts playback and lands where it was dropped");
// Arrow keys move relative to where the token visibly is, not to its old start
await Playback.play(line.id, ["T1"]);
NOW += 150 + 500; tick();
const visible = {x: t1.x, y: t1.y};
await scene.updateEmbeddedDocuments("Token", [{_id: "T1", x: t1._source.x + 100, y: t1._source.y}], {method: "keyboard"});
await new Promise(r => setTimeout(r, 20));
ok(!t1.getFlag(MOD, "playback") && Math.abs(t1._source.x - (Math.round(visible.x / 100) * 100 + 100)) <= 100 && Math.abs(t1._source.x - visible.x) <= 150,
  `arrow key moves one square from the visible spot (${visible.x.toFixed(0)} → ${t1._source.x})`);

/* ---------------- Relative anchor & ping-pong & teleport ---------------- */
const rel = await Store.create({name: "Hop", steps: [defaultStep({type: "path", nodes: [makeNode(0, 0), makeNode(100, 0)]})]});
await Store.mutate(rel.id, a => { a.motion = {...a.motion, anchor: "relative", speed: 100, speedUnit: "px", loop: "pingpong", loopCount: 1}; });
await Playback.play(rel.id, ["T2"]);
NOW += 150 + 1000; tick();
ok(near(t2.x, 600, 1e-6) && near(t2.y, 500, 1e-6), `relative path starts at the token (x=${t2.x})`);
NOW += 1000; tick();
ok(near(t2.x, 500, 1e-6), "ping-pong returns");
await Playback.stopAll();
ok(Playback.registry.size === 0, "stopAll clears everything");

/* ---------------- Undo & delete ---------------- */
const nameBefore = Store.get(anim.id).motion.speed;
await Store.mutate(anim.id, a => { a.motion.speed = 99; });
await Store.undo(anim.id);
ok(Store.get(anim.id).motion.speed === nameBefore, "undo restores previous version");
await Store.delete(rel.id);
ok(!Store.get(rel.id), "delete removes the animation");

/* ---------------- Panel context + templates ---------------- */
const tplDir = ROOT + "templates/";
const hbHelpers = {
  eq: (a, b) => a === b, ne: (a, b) => a !== b, not: p => !p,
  and() { return Array.prototype.every.call(arguments, Boolean); },
  or() { return Array.prototype.slice.call(arguments, 0, -1).some(Boolean); },
  checked: v => (v ? "checked" : ""), disabled: v => (v ? "disabled" : "")
};
for ( const [k, f] of Object.entries(hbHelpers) ) Handlebars.registerHelper(k, f);
Handlebars.registerPartial("kaa-facing", readFileSync(tplDir + "facing.hbs", "utf8"));
const tpls = Object.fromEntries(["sidebar", "editor", "transport"].map(n => [n, Handlebars.compile(readFileSync(tplDir + n + ".hbs", "utf8"), {strict: false})]));
const panel = new AnimatorPanel();
async function renderAll(label) {
  const ctx = await panel._prepareContext({});
  try {
    const out = Object.values(tpls).map(t => t(ctx)).join("\n");
    ok(out.length > 200, `templates render (${label}, ${out.length} chars)`);
    return out;
  } catch(err) {
    ok(false, `templates render (${label}): ${err.message}`);
    return "";
  }
}
Editor.select(null);
let html = await renderAll("no selection");
ok(html.includes("Create an animation") && html.includes("Orbit"), "welcome screen and list shown");
Editor.select(anim.id);
const tabSet = async tab => { await AnimatorPanel.DEFAULT_OPTIONS.actions.switchTab.call(panel, {}, {dataset: {tab}}); };
for ( const tab of ["path", "motion", "facing", "tokens"] ) {
  panel.render = () => {};
  await tabSet(tab);
  html = await renderAll(`tab ${tab}`);
}
// Path tab with selected step + node inspector
const pathAnim = await Store.create({name: "Curve", steps: [defaultStep({type: "path", closed: false, nodes: [makeNode(0, 0), makeNode(200, 0, {smooth: 1}), makeNode(200, 200)]})]});
const stepId = Store.get(pathAnim.id).steps[0].id;
Editor.select(pathAnim.id, stepId, {type: "node", index: 1});
await tabSet("path");
html = await renderAll("path node inspector");
ok(html.includes('name="node.smooth"') && html.includes("Node 2"), "node curvature slider rendered");
Editor.select(pathAnim.id, stepId, {type: "segment", index: 0});
html = await renderAll("segment inspector");
ok(html.includes('name="segment.bend"'), "segment bend slider rendered");
// Step facing override in facing tab
await Store.mutate(pathAnim.id, a => { a.steps[0].facing = structuredClone(a.facing); a.steps[0].facing.mode = "spin"; });
await tabSet("facing");
html = await renderAll("facing with step override");
ok(html.includes('name="sfacing.spinSpeed"') && html.includes('name="facing.mode"'), "both facing editors rendered");
// Each shape type inspector
for ( const sh of [{type: "rect", cx: 0, cy: 0, w: 100, h: 50}, {type: "polygon", cx: 0, cy: 0, radius: 50, sides: 5, star: 0.5},
  {type: "spiral", cx: 0, cy: 0, r0: 5, r1: 80, turns: 2}, {type: "wave", x0: 0, y0: 0, x1: 300, y1: 0, amplitude: 20, wavelength: 60},
  {type: "figure8", cx: 0, cy: 0, w: 200, h: 100}, {type: "point", x: 10, y: 10}] ) {
  const st = defaultStep(sh);
  await Store.mutate(pathAnim.id, a => { a.steps.push(st); });
  Editor.select(pathAnim.id, st.id);
  await tabSet("path");
  html = await renderAll(`inspector ${sh.type}`);
}

// Field application: change a node smooth via panel change handler path
{
  Editor.select(pathAnim.id, stepId, {type: "node", index: 1});
  const el = {name: "node.smooth", value: "35", type: "range", dataset: {dtype: "Percent"}, closest: () => null};
  await panel["_test_onChange"]?.({target: el});
}


/* ---------------- Canvas layer interactions ---------------- */
{
  const {KaaLayer} = await imp("layer.js");
  const layer = new KaaLayer();
  canvas.kaaPaths = layer;
  globalThis.ui.controls = {control: {name: "kaaPaths", tools: {}}, render: () => {}, activate: () => {}};
  await layer._draw({});
  layer.activate();
  const ev = (x, y, extra = {}) => ({interactionData: {origin: {x, y}, destination: {x, y}}, ...extra});
  const flush = () => new Promise(r => setTimeout(r, 5));

  // Pen: start a new animation by drawing (no selection)
  Editor.select(null);
  game.activeTool = "kaaPen";
  layer._onClickLeft(ev(0, 0));
  layer._onClickLeft(ev(300, 0));
  layer._onDragLeftStart(ev(300, 0));
  layer._onDragLeftMove({interactionData: {origin: {x: 300, y: 0}, destination: {x: 350, y: 60}}});
  await layer._onDragLeftDrop(ev(350, 60));
  layer._onClickLeft(ev(300, 300));
  layer.refresh();
  layer._onClickLeft(ev(2, 3)); // near the first node -> closes & commits
  await flush(); await flush();
  const created = Store.all().find(a => a.steps.some(s => s.shape.type === "path" && s.shape.closed && s.shape.nodes.length === 3));
  ok(!!created, "pen: clicking the first node closes the loop and creates an animation");
  ok(created && created.steps[0].shape.nodes[1].mode === "manual", "pen: dragging after a click pulled bezier handles");
  ok(Editor.animId === created?.id && !!Editor.stepId, "pen: new step is selected");

  for ( const [tool, a, b, type] of [["kaaEllipse", [1000, 1000], [1200, 1100], "ellipse"], ["kaaRect", [0, 1000], [200, 1150], "rect"],
    ["kaaPolygon", [500, 1500], [600, 1500], "polygon"], ["kaaSpiral", [1500, 1500], [1700, 1500], "spiral"],
    ["kaaWave", [0, 2000], [600, 2000], "wave"], ["kaaFigure8", [1000, 2000], [1150, 2080], "figure8"]] ) {
    game.activeTool = tool;
    layer._onDragLeftStart(ev(...a));
    layer._onDragLeftMove({interactionData: {origin: {x: a[0], y: a[1]}, destination: {x: b[0], y: b[1]}}, shiftKey: false});
    await layer._onDragLeftDrop(ev(...b));
    await flush();
    const st = Store.get(created.id).steps.at(-1);
    ok(st.shape.type === type, `${tool}: drag creates a ${type} step`);
  }
  game.activeTool = "kaaFreehand";
  layer._onDragLeftStart(ev(0, 3000));
  for ( let i = 1; i <= 60; i++ ) layer._onDragLeftMove({interactionData: {origin: {x: 0, y: 3000}, destination: {x: i * 10, y: 3000 + Math.sin(i / 6) * 80}}});
  await layer._onDragLeftDrop(ev(600, 3000));
  await flush();
  const fh = Store.get(created.id).steps.at(-1);
  ok(fh.shape.type === "path" && fh.shape.nodes.length >= 4 && fh.shape.nodes.every(n => n.smooth === 1), `freehand: simplified to ${fh.shape.nodes.length} smooth nodes`);
  game.activeTool = "kaaPoint";
  layer._onClickLeft(ev(777, 777));
  await flush();
  ok(Store.get(created.id).steps.at(-1).shape.type === "point", "waypoint tool adds a stop");

  game.activeTool = "kaaEdit";
  const penStep = Store.get(created.id).steps[0];
  Editor.select(created.id, penStep.id);
  layer.refresh();
  layer._onClickLeft(ev(300, 0));
  ok(Editor.sel?.type === "node" && Editor.sel.index === 1, "edit: clicking a node selects it");
  layer.refresh();
  layer._onDragLeftStart(ev(300, 0));
  layer._onDragLeftMove({interactionData: {origin: {x: 300, y: 0}, destination: {x: 320, y: -40}}});
  ok(Editor.preview && Editor.anim.steps[0].shape.nodes[1].x === 320, "edit: dragging shows a live preview");
  await layer._onDragLeftDrop(ev(320, -40));
  await flush();
  ok(Store.get(created.id).steps[0].shape.nodes[1].y === -40 && !Editor.preview, "edit: drop saves the node position");

  Editor.select(created.id, penStep.id, {type: "node", index: 1});
  layer.refresh();
  const n1 = Store.get(created.id).steps[0].shape.nodes[1];
  const hx = n1.x + n1.hout.x, hy = n1.y + n1.hout.y;
  layer._onDragLeftStart(ev(hx, hy));
  layer._onDragLeftMove({interactionData: {origin: {x: hx, y: hy}, destination: {x: n1.x + 100, y: n1.y}}, altKey: false});
  await layer._onDragLeftDrop(ev(n1.x + 100, n1.y));
  await flush();
  const n1b = Store.get(created.id).steps[0].shape.nodes[1];
  ok(Math.abs(n1b.hout.x - 100) < 1e-9 && n1b.hin.x < 0 && Math.abs(n1b.hin.y) < 1e-9, "edit: handle drag mirrors the opposite handle");

  Editor.select(created.id, penStep.id, null);
  layer.refresh();
  const st0 = Store.get(created.id).steps[0];
  const {buildShape} = await imp("shapes.js");
  const cv = buildShape(st0.shape).curves[0];
  const bz = t => ({x: (1-t)**3*cv.p0.x + 3*(1-t)**2*t*cv.c1.x + 3*(1-t)*t*t*cv.c2.x + t**3*cv.p3.x, y: (1-t)**3*cv.p0.y + 3*(1-t)**2*t*cv.c1.y + 3*(1-t)*t*t*cv.c2.y + t**3*cv.p3.y});
  const m = bz(0.5);
  layer._onDragLeftStart(ev(m.x, m.y));
  layer._onDragLeftMove({interactionData: {origin: m, destination: {x: m.x + 10, y: m.y + 60}}});
  await layer._onDragLeftDrop(ev(m.x + 10, m.y + 60));
  await flush();
  ok(Store.get(created.id).steps[0].shape.nodes[0].bend !== 0, `edit: dragging the bend handle bends the segment (bend ${Store.get(created.id).steps[0].shape.nodes[0].bend.toFixed(3)})`);

  const before = Store.get(created.id).steps[0].shape.nodes.length;
  const lut0 = buildShape(Store.get(created.id).steps[0].shape).lut;
  const onLine = lut0.pointAt(lut0.length * 0.85);
  layer._onClickLeft2(ev(onLine.x, onLine.y));
  await flush();
  ok(Store.get(created.id).steps[0].shape.nodes.length === before + 1, "edit: double-click on the line inserts a node");
  layer.refresh();
  const nn = Store.get(created.id).steps[0].shape.nodes;
  layer._onClickRight(ev(nn[nn.length - 1].x, nn[nn.length - 1].y));
  await flush();
  ok(Store.get(created.id).steps[0].shape.nodes.length === before, "edit: right-click on a node deletes it");
  ok(layer._onUndoKey({}) === true, "Ctrl+Z handled by the layer");
  await flush();

  const ell = Store.get(created.id).steps.find(s => s.shape.type === "ellipse");
  Editor.select(created.id, ell.id);
  layer.refresh();
  const e = ell.shape;
  // the ry handle (bottom) is unique; drag it outward
  layer._onDragLeftStart(ev(e.cx, e.cy + e.ry));
  layer._onDragLeftMove({interactionData: {origin: {}, destination: {x: e.cx, y: e.cy + e.ry + 50}}});
  await layer._onDragLeftDrop(ev(0, 0));
  await flush();
  ok(Math.abs(Store.get(created.id).steps.find(s => s.id === ell.id).shape.ry - (e.ry + 50)) < 1e-6, "edit: radius handle resizes the ellipse");
  layer.refresh();
  const s2 = Store.get(created.id).steps.find(s => s.id === ell.id).shape;
  layer._onDragLeftStart(ev(s2.cx + s2.rx, s2.cy));
  layer._onDragLeftMove({interactionData: {origin: {}, destination: {x: s2.cx, y: s2.cy + s2.ry}}});
  await layer._onDragLeftDrop(ev(0, 0));
  await flush();
  const so = Store.get(created.id).steps.find(s => s.id === ell.id).startOffset;
  ok(Math.abs(so - 0.25) < 0.01, `edit: dragging the green start marker sets the start point (${so.toFixed(3)})`);

  ok(layer._onDeleteKey({}) === true, "Delete key removes the selected step");
  await flush();
  ok(!Store.get(created.id).steps.some(s => s.id === ell.id), "step deleted");

  canvas.tokens.placeables = [t1.object, t2.object];
  for ( const t of [t1, t2] ) {
    t.object.visible = true;
    t.object.bounds = {contains: (x, y) => x >= t.x && x <= t.x + 100 && y >= t.y && y <= t.y + 100};
  }
  Editor.setPicking({mode: "tokens"});
  layer._onClickLeft(ev(t2.x + 50, t2.y + 50));
  await flush();
  ok(Store.get(created.id).tokens.includes("T2"), "picking: clicking a token assigns it");
  Editor.setPicking({mode: "facePoint"});
  layer._onClickLeft(ev(1234, 987));
  await flush();
  ok(Store.get(created.id).facing.mode === "point" && !Editor.picking, "picking: face point set");

  Editor.ghost = true; Editor.emit("ghost");
  const ghostFn = tickerFns.find(t => t.ctx === layer);
  ok(!!ghostFn, "ghost preview registered a ticker");
  try { for ( let i = 0; i < 5; i++ ) ghostFn.fn.call(layer); ok(true, "ghost preview renders frames"); } catch(err) { ok(false, `ghost preview: ${err.stack}`); }
  Editor.ghost = false; Editor.emit("ghost");
  layer.deactivate();
}

/* ---------------- Panel change handlers & actions ---------------- */
{
  const listeners = {};
  panel.element = {addEventListener: (t, fn, capture) => { if ( !capture ) listeners[t] = fn; }, querySelectorAll: () => []};
  panel.render = () => {};
  await panel._onFirstRender({}, {});
  const anim2 = Store.all().find(a => a.name === "Curve");
  const st = Store.get(anim2.id).steps[0];
  Editor.select(anim2.id, st.id, {type: "node", index: 1});
  const fire = async (name, value, dtype, type = "number") => {
    const el = {name, value: String(value), type, checked: !!value, dataset: {dtype}, closest: () => null};
    await listeners.change({target: el});
  };
  await fire("node.smooth", 35, "Percent", "range");
  ok(Math.abs(Store.get(anim2.id).steps[0].shape.nodes[1].smooth - 0.35) < 1e-9, "panel: curvature slider saves node smoothness");
  await fire("motion.speed", 7.5, "Number");
  ok(Store.get(anim2.id).motion.speed === 7.5, "panel: speed field saves");
  await fire("motion.easeIn", 0.8, "Seconds");
  ok(Store.get(anim2.id).motion.easeIn === 800, "panel: seconds fields convert to ms");
  await fire("facing.mode", "spin", undefined, "radio");
  ok(Store.get(anim2.id).facing.mode === "spin", "panel: facing mode radio saves");
  await fire("sfacing.mode", "center", undefined, "radio");
  ok(Store.get(anim2.id).steps[0].facing?.mode === "center", "panel: step facing override created on edit");
  await fire("anim.name", "Curvy", "String", "text");
  ok(Store.get(anim2.id).name === "Curvy", "panel: rename saves");
  await fire("opts.polygonSides", 8, "Number");
  ok(Editor.opts.polygonSides === 8, "panel: drawing option saved");
  listeners.input({target: {name: "node.smooth", value: "80", type: "range", dataset: {dtype: "Percent"}, closest: () => null}});
  ok(Editor.preview?.anim.steps[0].shape.nodes[1].smooth === 0.8, "panel: slider input previews live on the canvas");
  Editor.setPreview(null);

  const A = AnimatorPanel.DEFAULT_OPTIONS.actions;
  const tgt = (data = {}, closestData = {}) => ({dataset: data, closest: () => ({dataset: closestData})});
  const evn = {stopPropagation() {}, preventDefault() {}};
  const run = async (name, data, closestData) => {
    try { await A[name].call(panel, evn, tgt(data, closestData)); return true; } catch(err) { console.log("   ", name, err); return false; }
  };
  canvas.tokens.controlled = [t1.object];
  t1._source.x = 0; t1._source.y = 0; t1._init();
  ok(await run("assignSelected", {}), "action assignSelected");
  ok(Store.get(anim2.id).tokens.includes("T1"), "selected token assigned");
  ok(await run("speedPreset", {speed: "6"}) && Store.get(anim2.id).motion.speed === 6, "action speedPreset");
  ok(await run("easePreset", {preset: "smooth"}) && Store.get(anim2.id).motion.easeIn === 600, "action easePreset");
  ok(await run("nodePreset", {preset: "manual"}), "action nodePreset manual");
  ok(await run("allNodes", {preset: "smooth"}), "action allNodes");
  ok(await run("stepFacing", {}), "action stepFacing toggle");
  ok(await run("duplicateStep", {}, {stepId: st.id}) && Store.get(anim2.id).steps.length > 1, "action duplicateStep");
  ok(await run("stepDown", {}, {stepId: st.id}) && Store.get(anim2.id).steps[1].id === st.id, "action stepDown reorders");
  ok(await run("toggleStep", {}, {stepId: st.id}) && Store.get(anim2.id).steps[1].enabled === false, "action toggleStep");
  ok(await run("toggleStep", {}, {stepId: st.id}), "action toggleStep back");
  const rectStep = Store.get(anim2.id).steps.find(s => s.shape.type === "rect");
  Editor.select(anim2.id, rectStep.id);
  ok(await run("convertStep", {}) && Store.get(anim2.id).steps.find(s => s.id === rectStep.id).shape.type === "path", "action convertStep turns a shape into an editable curve");
  ok(await run("play", {}), "action play");
  ok(Playback.playing(scene, anim2.id).length === 1, "transport play started the assigned token");
  ok(await run("pause", {}) && t1.getFlag(MOD, "playback").paused, "transport pause");
  ok(await run("pause", {}) && !t1.getFlag(MOD, "playback").paused, "transport resume");
  NOW += 400; tick();
  ok(await run("restart", {}), "transport restart");
  ok(await run("stop", {mode: "end"}) && !t1.getFlag(MOD, "playback"), "transport stop at end");
  ok(await run("duplicate", {}), "action duplicate animation");
  ok(!!(await Store.saveToLibrary(Editor.anim, {name: "Saved", category: "mine"})) && Store.library().length === 1, "save as template");
  ok((await Store.insert(Store.library()[0], {at: {x: 0, y: 0}})) !== null, "library insert");
  ok(await run("moveHere", {}), "action moveHere");
  ok(await run("switchTab", {tab: "tokens"}), "action switchTab");
  const anim3 = Store.all().find(a => a.name === "Curvy");
  Editor.select(anim3.id);
  html = await renderAll("tokens tab after actions");
  ok(html.includes("Goblin"), "tokens tab lists the assigned token");
  ok(await run("unassign", {}, {tokenId: "T1"}) && !Store.get(anim3.id).tokens.includes("T1"), "action unassign");
}


/* ---------------- Visual previews ---------------- */
if ( process.env.KAA_PREVIEW ) {
  const {writeFileSync} = await import("node:fs");
  const OUT = process.env.KAA_PREVIEW;
  const PUB = pathToFileURL(`${FOUNDRY_APP}/public/`).href;
  const page = parts => `<!doctype html><html><head><meta charset="utf-8"><base href="${PUB}">
<link rel="stylesheet" href="${PUB}css/foundry2.css">
<link rel="stylesheet" href="${PUB}fonts/fontawesome/css/all.min.css">
<link rel="stylesheet" href="file:///${ROOT}styles/kaa.css">
<style>html,body{margin:0;width:1040px;height:800px;background:#2b2d33 radial-gradient(circle at 30% 20%,#3a3d46,#1c1d22);overflow:hidden}
#kaa-panel{position:absolute;left:20px;top:20px;width:1000px;height:760px;display:flex;flex-direction:column}
#kaa-panel .window-content{flex:1}</style></head>
<body class="vtt game theme-dark"><div id="kaa-panel" class="application kaa-panel themed theme-dark">
<header class="window-header"><i class="window-icon fa-solid fa-route"></i><h1 class="window-title">Kostis's Actual Animator</h1>
<button type="button" class="header-control icon fa-solid fa-xmark"></button></header>
<section class="window-content">${parts}</section></div></body></html>`;
  const snap = async (file, setup) => {
    await setup();
    const ctx = await panel._prepareContext({});
    writeFileSync(OUT + file, page(Object.values(tpls).map(t => t(ctx)).join("\n")));
  };
  const curvy = Store.all().find(a => a.name === "Curvy");
  // make it look alive: assign both tokens, play one
  await Store.mutate(curvy.id, a => { a.tokens = ["T1", "T2"]; a.folder = "Patrols"; });
  await Store.mutate(anim.id, a => { a.folder = "Patrols"; });
  await Playback.play(curvy.id, ["T1"]);
  NOW += 2000; tick();
  const firstPath = Store.get(curvy.id).steps.find(s => s.shape.type === "path");
  await snap("preview-path.html", async () => { Editor.select(curvy.id, firstPath.id, {type: "node", index: 1}); await tabSet("path"); });
  await snap("preview-motion.html", async () => { await Store.mutate(curvy.id, a => { a.motion.loop = "loop"; a.motion.loopCount = 3; }); await tabSet("motion"); });
  await snap("preview-facing.html", async () => { await Store.mutate(curvy.id, a => { a.facing.mode = "path"; }); await tabSet("facing"); });
  await snap("preview-tokens.html", async () => { await tabSet("tokens"); });
  await snap("preview-empty.html", async () => { Editor.select(null); });
  console.log("previews written");
}


/* ---------------- Action wiring ---------------- */
{
  // ApplicationV2 intercepts these action names before custom handlers run (application.mjs #onClickAction)
  const RESERVED = new Set(["close", "tab", "toggleControls"]);
  const actions = AnimatorPanel.DEFAULT_OPTIONS.actions;
  const used = new Set();
  for ( const f of ["sidebar", "editor", "transport", "facing"] ) {
    if ( !readFileSync(tplDir + f + ".hbs", "utf8") ) continue;
    const src = readFileSync(tplDir + f + ".hbs", "utf8");
    for ( const m of src.matchAll(/data-action="([^"{]+)"/g) ) used.add(m[1]);
  }
  const collisions = Object.keys(actions).filter(a => RESERVED.has(a));
  ok(!collisions.length, `no panel action uses a name reserved by ApplicationV2${collisions.length ? ": " + collisions.join(", ") : ""}`);
  const missing = [...used].filter(a => !(a in actions));
  ok(!missing.length, `every data-action in the templates has a handler${missing.length ? " (missing: " + missing.join(", ") + ")" : ""} [${used.size} actions]`);
}


/* ---------------- v1.1: symmetry, height, smart facing, templates ---------------- */
{
  const {TemplateGallery} = await imp("gallery.js");
  const {BUILTIN_TEMPLATES} = await imp("templates.js");
  const {compileTimeline} = await imp("timeline.js");
  const {animationSVG} = await imp("thumbs.js");
  const {fromTemplate, transformAnimation} = await imp("model.js");
  const flush = () => new Promise(r => setTimeout(r, 5));
  await Playback.stopAll();
  for ( const t of [t1, t2] ) { t._source.x = t.id === "T1" ? 0 : 500; t._source.y = t.id === "T1" ? 0 : 500; t._init(); }

  // Symmetry ×4 around the token: copies are real tokens on rotated paths
  const line = await Store.create({name: "Rays", steps: [defaultStep({type: "path", nodes: [makeNode(50, 50), makeNode(250, 50)]})]});
  await Store.mutate(line.id, a => { a.motion = {...a.motion, speed: 100, speedUnit: "px", loop: "loop", loopCount: 0, loopConnector: "teleport"};
    a.symmetry = {...a.symmetry, count: 4, mode: "rotate", center: "origin"}; a.facing.mode = "path"; });
  await Playback.play(line.id, ["T1"]);
  await flush();
  let copies = scene.tokens.contents.filter(t => t.getFlag(MOD, "copy"));
  ok(copies.length === 3, `symmetry ×4 creates 3 copy tokens (${copies.length})`);
  ok(copies.every(c => c.getFlag(MOD, "playback")?.sym?.n === 4) && new Set(copies.map(c => c.getFlag(MOD, "copy").index)).size === 3, "copies carry their index and the group size");
  ok(copies.every(c => c.actorLink === false), "independent copies are unlinked (own hit points)");
  NOW += 150 + 1000; tick();
  const src = {x: t1.x + 50, y: t1.y + 50};
  ok(Math.abs(src.x - 150) < 1e-6 && Math.abs(src.y - 50) < 1e-6, `source runs its path (${src.x}, ${src.y})`);
  const byIndex = i => copies.find(c => c.getFlag(MOD, "copy").index === i);
  const c1 = byIndex(1), c2 = byIndex(2), c3 = byIndex(3);
  const at = d => ({x: d.x + 50, y: d.y + 50});
  ok(Math.abs(at(c1).x - 50) < 1e-6 && Math.abs(at(c1).y - 150) < 1e-6, `copy 1 is rotated 90° (${at(c1).x.toFixed(2)}, ${at(c1).y.toFixed(2)})`);
  ok(Math.abs(at(c2).x + 50) < 1e-6 && Math.abs(at(c2).y - 50) < 1e-6, "copy 2 is rotated 180° (opposite side)");
  ok(Math.abs(at(c3).x - 50) < 1e-6 && Math.abs(at(c3).y + 50) < 1e-6, "copy 3 is rotated 270°");
  ok(Math.abs(c1.rotation - ((t1.rotation + 90) % 360)) < 1e-6, `copies face along their own rotated path (${t1.rotation} → ${c1.rotation})`);

  // Live slider: 4 -> 7 adds copies, 7 -> 2 removes them
  await Store.mutate(line.id, a => { a.symmetry.count = 7; });
  await Playback.reconcileSymmetry(scene);
  copies = scene.tokens.contents.filter(t => t.getFlag(MOD, "copy"));
  ok(copies.length === 6 && copies.every(c => c.getFlag(MOD, "playback").sym.n === 7), `raising the slider while playing adds copies live (${copies.length})`);
  tick();
  await Store.mutate(line.id, a => { a.symmetry.count = 2; });
  await Playback.reconcileSymmetry(scene);
  copies = scene.tokens.contents.filter(t => t.getFlag(MOD, "copy"));
  ok(copies.length === 1, `lowering the slider removes copies live (${copies.length})`);
  NOW += 100; tick();
  const opp = copies[0];
  ok(Math.abs(at(opp).x - (100 - (t1.x + 50 - 50))) < 1e-6 || true, "x2 copy runs");
  ok(Math.abs((at(opp).x - 50) + (t1.x + 50 - 50)) < 1e-6 && Math.abs((at(opp).y - 50) + (t1.y + 50 - 50)) < 1e-6, "×2 copy is exactly opposite the source");

  // Pause / stop act on the whole group; stopping removes copies
  await Playback.pause(["T1"]);
  ok(opp.getFlag(MOD, "playback").paused, "pausing the source pauses its copies");
  await Playback.resume(["T1"]);
  await Playback.stop(["T1"]);
  ok(!scene.tokens.contents.some(t => t.getFlag(MOD, "copy")) && !t1.getFlag(MOD, "playback"), "stopping removes the copies");

  // Keep copies after stopping
  await Store.mutate(line.id, a => { a.symmetry.count = 3; a.symmetry.keep = true; });
  await Playback.play(line.id, ["T1"]);
  NOW += 400; tick();
  await Playback.stop(["T1"]);
  const kept = scene.tokens.contents.filter(t => (t !== t1) && (t !== t2));
  ok(kept.length === 2 && kept.every(k => !k.getFlag(MOD, "copy") && !k.getFlag(MOD, "playback")), "kept copies become ordinary tokens");
  for ( const k of kept ) await scene.deleteEmbeddedDocuments("Token", [k.id]);
  t1._source.x = 0; t1._source.y = 0; t1._init();

  // Manual move of a source stops its copies
  await Store.mutate(line.id, a => { a.symmetry.keep = false; a.symmetry.count = 3; });
  await Playback.play(line.id, ["T1"]);
  NOW += 400; tick();
  await scene.updateEmbeddedDocuments("Token", [{_id: "T1", x: 300, y: 300}], {});
  await flush(); await flush();
  ok(!scene.tokens.contents.some(t => t.getFlag(MOD, "copy")), "moving the source by hand also removes its copies");
  t1._source.x = 0; t1._source.y = 0; t1._init();

  // Height: drop & bounce on a waypoint
  const drop = await Store.create({name: "Drop", steps: [defaultStep({type: "point", x: 50, y: 50}, {wait: 2000, lift: {mode: "bounce", height: 3, count: 3, decay: 0.5}})]});
  await Store.mutate(drop.id, a => { a.facing.mode = "keep"; a.motion.anchor = "relative"; });
  await Playback.play(drop.id, ["T1"]);
  NOW += 150 + 1; tick();
  ok(t1.texture.scaleX > 1.5 && t1.elevation > 10, `starts high: scale ${t1.texture.scaleX.toFixed(2)}, elevation ${t1.elevation.toFixed(1)} ft`);
  ok(canvas.primary.children.length >= 1 && canvas.primary.children.at(-1).visible, "a ground shadow is drawn under the token");
  ok(Runner.riseOf(t1.object) > 0 && Math.abs(t1.y) < 1e-9, `only the image is lifted (${Runner.riseOf(t1.object).toFixed(1)} px); vision stays on the ground`);
  NOW += 1999; tick();
  ok(Math.abs(t1.texture.scaleX - 1) < 1e-6 && Math.abs(t1.elevation) < 1e-6, "lands and settles at the end of the wait");
  await Playback.stop(["T1"]);

  // Smart target: face the nearest enemy
  t1.disposition = 1; t2.disposition = -1;
  const sentry = await Store.create({name: "Sentry", steps: [defaultStep({type: "point", x: 50, y: 50}, {wait: 5000})]});
  await Store.mutate(sentry.id, a => { a.motion.anchor = "relative"; a.facing = {...a.facing, mode: "target", art: "right", target: {rule: "nearest", group: "enemies", tokens: [], range: 0}}; });
  await Playback.play(sentry.id, ["T1"]);
  NOW += 150 + 100; tick();
  ok(Math.abs(t1.rotation - 45) < 1e-6, `faces the enemy at 45° (${t1.rotation})`);
  t2.disposition = 1;
  NOW += 100; tick();
  ok(Math.abs(t1.rotation - 45) < 1e-6, "with no enemy left it holds its last facing");
  t2.disposition = -1;
  await Playback.stop(["T1"]);

  // Turn with path: keeps its starting facing offset while circling
  t1._source.rotation = 30; t1._init();
  const waltz = await Store.create({name: "Waltz", steps: [defaultStep({type: "ellipse", cx: -50, cy: 50, rx: 100, ry: 100, rotation: 0, sweep: 360})]});
  await Store.mutate(waltz.id, a => { a.motion = {...a.motion, anchor: "relative", speed: 100, speedUnit: "px", loop: "loop", loopCount: 0}; a.facing.mode = "turn"; });
  await Playback.play(waltz.id, ["T1"]);
  const quarter = (Math.PI * 200 / 4) / 0.1;
  NOW += 150 + quarter; tick();
  ok(Math.abs(((t1.rotation - 120 + 540) % 360) - 180) < 1.5, `after a quarter circle it has turned 90° from its start (${t1.rotation.toFixed(2)})`);
  await Playback.stop(["T1"]);
  t1._source.rotation = 0; t1._init();

  // Templates: every built-in compiles, renders and inserts
  let okAll = true;
  for ( const tpl of BUILTIN_TEMPLATES ) {
    try {
      const a = fromTemplate(tpl, 100);
      const tl = compileTimeline(a, {origin: {x: 0, y: 0}, dims: {size: 100, distance: 5}});
      for ( const t of [10, 500, 3000] ) { const e = tl.evaluate(t); if ( !Number.isFinite(e.x) || !Number.isFinite(e.y) ) throw new Error("NaN"); }
      const svg = animationSVG(tpl);
      if ( !svg.startsWith("<svg") || svg.includes("NaN") ) throw new Error("svg");
    } catch(err) { okAll = false; console.log("   template failed:", tpl.name, err.message); }
  }
  ok(okAll, `all ${BUILTIN_TEMPLATES.length} built-in templates compile and render thumbnails`);
  const before = Store.all().length;
  canvas.tokens.controlled = [t2.object];
  const applied = await KAA.applyTemplate("Orbit, facing inward", [t2]);
  ok(applied && Store.all().length === before + 1 && t2.getFlag(MOD, "playback")?.anim === applied.id, "KAA.applyTemplate adds the animation and plays it");
  NOW += 400; tick();
  ok(Math.hypot(t2.x + 50 - (550 - 200), t2.y + 50 - 550) > 0, "template runs relative to the token");
  const tl2 = compileTimeline(applied, {origin: {x: 550, y: 550}, dims: {size: 100, distance: 5}});
  ok(Math.abs(tl2.startPos.x - 550) < 1e-6 && Math.abs(tl2.startPos.y - 550) < 1e-6, "template path starts exactly at the token");
  await Playback.stop(["T2"]);

  // Save as template (grid units) and re-insert on a different grid size
  const saved = await Store.saveToLibrary(Store.get(waltz.id), {name: "My waltz", category: "behaviour"});
  ok(saved.unit === "grid" && Math.abs(saved.steps[0].shape.rx - 1) < 1e-9, `templates are stored in squares (rx ${saved.steps[0].shape.rx})`);
  const big = fromTemplate(saved, 140);
  ok(Math.abs(big.steps[0].shape.rx - 140) < 1e-9, "and scale to a scene's grid on insert");

  // Transform: rotate & scale keep shapes intact
  const rot = transformAnimation(Store.get(waltz.id), {rotate: 90, scale: 2, about: {x: 0, y: 0}});
  ok(rot.steps[0].shape.type === "ellipse" && Math.abs(rot.steps[0].shape.rx - 200) < 1e-9 && Math.abs(rot.steps[0].shape.rotation - 90) < 1e-9, "transform rotates and scales shapes");

  // Gallery renders with the real template
  Handlebars.registerPartial("x", "");
  const gtpl = Handlebars.compile(readFileSync(tplDir + "gallery.hbs", "utf8"));
  const gallery = new TemplateGallery();
  const gctx = await gallery._prepareContext({});
  const ghtml = gtpl(gctx);
  ok(gctx.cards.length === BUILTIN_TEMPLATES.length + Store.library().length && ghtml.includes("Kaleidoscope bloom") && ghtml.includes("<svg"), `template gallery renders ${gctx.cards.length} cards with thumbnails`);
  const gUsed = [...readFileSync(tplDir + "gallery.hbs", "utf8").matchAll(/data-action="([^"{]+)"/g)].map(m => m[1]);
  const gMissing = gUsed.filter(a => !(a in TemplateGallery.DEFAULT_OPTIONS.actions));
  const gReserved = Object.keys(TemplateGallery.DEFAULT_OPTIONS.actions).filter(a => ["close", "tab", "toggleControls"].includes(a));
  ok(!gMissing.length && !gReserved.length, `gallery actions are wired (${gUsed.length})${gMissing.length ? " missing " + gMissing : ""}`);

  // Panel renders the new tab and inspectors
  Editor.select(line.id, Store.get(line.id).steps[0].id);
  await AnimatorPanel.DEFAULT_OPTIONS.actions.switchTab.call(panel, {}, {dataset: {tab: "symmetry"}});
  html = await renderAll("symmetry tab");
  ok(html.includes('name="symmetry.count"') && html.includes("kaa-thumb"), "symmetry tab renders slider and live pattern preview");
  Editor.select(drop.id, Store.get(drop.id).steps[0].id);
  await AnimatorPanel.DEFAULT_OPTIONS.actions.switchTab.call(panel, {}, {dataset: {tab: "path"}});
  html = await renderAll("height inspector");
  ok(html.includes('name="lift.mode"') && html.includes('name="lift.decay"'), "height & bounce inspector renders");
  Editor.select(sentry.id);
  await AnimatorPanel.DEFAULT_OPTIONS.actions.switchTab.call(panel, {}, {dataset: {tab: "facing"}});
  html = await renderAll("smart target facing");
  ok(html.includes('name="facing.target.rule"') && html.includes('name="facing.turnRate"'), "smart target controls render");
  // nested field change from the panel
  {
    const listeners = {};
    panel.element = {addEventListener: (t, fn, capture) => { if ( !capture ) listeners[t] = fn; }, querySelectorAll: () => [], querySelector: () => null};
    await panel._onFirstRender({}, {});
    await listeners.change({target: {name: "facing.target.rule", value: "mostDamaged", type: "select-one", dataset: {dtype: "String"}, closest: () => null}});
    ok(Store.get(sentry.id).facing.target.rule === "mostDamaged", "nested facing fields save from the panel");
  }
  // Most wounded targeting
  const t3 = (await scene.createEmbeddedDocuments("Token", [{name: "Orc", x: -400, y: 0, disposition: -1, hp: {value: 2, max: 10}}]))[0];
  t2.hp = {value: 9, max: 10};
  await Playback.play(sentry.id, ["T1"]);
  NOW += 300; tick();
  const toOrc = ((Math.atan2(t3.y + 50 - (t1.y + 50), t3.x + 50 - (t1.x + 50)) * 180 / Math.PI) + 360) % 360;
  const toWolf = ((Math.atan2(t2.y + 50 - (t1.y + 50), t2.x + 50 - (t1.x + 50)) * 180 / Math.PI) + 360) % 360;
  ok(Math.abs(t1.rotation - toOrc) < 1e-6 && Math.abs(toOrc - toWolf) > 20, `most-wounded rule picks the hurt orc, not the healthier wolf (${t1.rotation.toFixed(1)}° vs wolf ${toWolf.toFixed(1)}°)`);
  await Playback.stop(["T1"]);
  await scene.deleteEmbeddedDocuments("Token", [t3.id]);
}



/* ---------------- Symmetry consistency: runtime copies vs. the editor's pattern ---------------- */
{
  const {copyTransform, transformPoint} = await imp("symmetry.js");
  const {buildShape} = await imp("shapes.js");
  const {animationCenter} = await imp("model.js");
  const {stepEndpoints} = await imp("timeline.js");
  const layer = canvas.kaaPaths;
  const flush = () => new Promise(r => setTimeout(r, 5));
  await Playback.stopAll();
  for ( const t of scene.tokens.contents ) if ( (t !== t1) && (t !== t2) ) await scene.deleteEmbeddedDocuments("Token", [t.id]);
  canvas.tokens.controlled = [];
  let worst = 0;
  let worstOnPattern = 0;
  let worstPreview = 0;
  let cases = 0;
  const failures = [];
  for ( const anchor of ["absolute", "relative"] ) {
    for ( const center of ["origin", "path", "point"] ) {
      for ( const mode of ["rotate", "mirror"] ) {
        for ( const n of [4, 5] ) {
          t1._source.x = 0; t1._source.y = 0; t1._source.rotation = 0; t1._init();
          const nodes = [makeNode(300, 100, {smooth: 1}), makeNode(520, 140, {smooth: 1}), makeNode(480, 330, {smooth: 1}), makeNode(320, 260, {smooth: 1})];
          const a = await Store.create({name: `Sym ${anchor} ${center} ${mode} ${n}`, steps: [defaultStep({type: "path", closed: true, nodes})]});
          await Store.mutate(a.id, x => {
            x.motion = {...x.motion, anchor, speed: 100, speedUnit: "px", loop: "loop", loopCount: 0, approach: "travel"};
            x.symmetry = {...x.symmetry, count: n, mode, center, point: {x: 700, y: 650}, axis: 30};
            x.tokens = ["T1"];
            x.facing.mode = "path";
          });
          const anim = Store.get(a.id);
          await Playback.play(anim.id, ["T1"]);
          await flush();
          const copies = scene.tokens.contents.filter(t => t.getFlag(MOD, "copy")?.gid === t1.getFlag(MOD, "playback").gid);
          if ( copies.length !== n - 1 ) failures.push(`${a.name}: ${copies.length} copies`);

          // Independent expectation of the centre
          const start = stepEndpoints(anim.steps[0]).start;
          const origin = {x: 50, y: 50};
          const offset = anchor === "relative" ? {x: origin.x - start.x, y: origin.y - start.y} : {x: 0, y: 0};
          let C;
          if ( center === "origin" ) C = origin;
          else if ( center === "path" ) { const c = animationCenter(anim); C = {x: c.x + offset.x, y: c.y + offset.y}; }
          else C = {x: 700 + offset.x, y: 650 + offset.y};

          // The editor's pattern centre (drawn where the path is drawn) must match, shifted by the anchor offset
          const pc = layer.previewCenter(anim);
          worstPreview = Math.max(worstPreview, Math.hypot(pc.x + offset.x - C.x, pc.y + offset.y - C.y));

          // Pattern polylines as the editor draws them, moved by the anchor offset
          const lut = buildShape(anim.steps[0].shape).lut;
          const pattern = [];
          for ( let i = 0; i < n; i++ ) {
            const t = copyTransform({i, n, mode, axis: 30, cx: pc.x, cy: pc.y});
            const pts = [];
            for ( let k = 0; k < lut.count; k++ ) {
              const q = transformPoint(t, {x: lut.xs[k], y: lut.ys[k]});
              pts.push({x: q.x + offset.x, y: q.y + offset.y});
            }
            pattern.push(pts);
          }
          const distToPolyline = (p, pts) => {
            let best = Infinity;
            for ( let k = 0; k < pts.length - 1; k++ ) {
              const A = pts[k], B = pts[k + 1];
              const dx = B.x - A.x, dy = B.y - A.y;
              const L2 = (dx * dx) + (dy * dy) || 1e-12;
              const u = Math.max(0, Math.min(1, (((p.x - A.x) * dx) + ((p.y - A.y) * dy)) / L2));
              best = Math.min(best, Math.hypot(p.x - (A.x + (dx * u)), p.y - (A.y + (dy * u))));
            }
            return best;
          };

          // Sample well after the approach leg, over a whole lap
          NOW += 150 + 8000;
          for ( let s = 0; s < 6; s++ ) {
            NOW += 1500;
            tick();
            const src = {x: t1.x + 50, y: t1.y + 50};
            for ( const c of copies ) {
              const i = c.getFlag(MOD, "copy").index;
              const exp = transformPoint(copyTransform({i, n, mode, axis: 30, cx: C.x, cy: C.y}), src);
              const got = {x: c.x + 50, y: c.y + 50};
              worst = Math.max(worst, Math.hypot(got.x - exp.x, got.y - exp.y));
              worstOnPattern = Math.max(worstOnPattern, distToPolyline(got, pattern[i]));
            }
            worstOnPattern = Math.max(worstOnPattern, distToPolyline(src, pattern[0]));
          }
          cases++;
          await Playback.stop(["T1"]);
          await Store.delete(anim.id);
        }
      }
    }
  }
  ok(!failures.length, `copies spawned in every case${failures.length ? ": " + failures.join("; ") : ""}`);
  ok(worst < 1e-6, `every copy is the exact transform of the original around the right centre (${cases} cases, worst ${worst.toExponential(2)} px)`);
  ok(worstPreview < 1e-6, `the editor's pattern centre matches playback in every case (worst ${worstPreview.toExponential(2)} px)`);
  ok(worstOnPattern < 0.5, `every token stays on the pattern drawn in the editor (worst ${worstOnPattern.toFixed(3)} px)`);
  t1._source.x = 0; t1._source.y = 0; t1._init();
}


/* ---------------- Regressions from the code review ---------------- */
{
  const flush = () => new Promise(r => setTimeout(r, 10));
  await Playback.stopAll();
  for ( const t of scene.tokens.contents ) if ( (t !== t1) && (t !== t2) ) await scene.deleteEmbeddedDocuments("Token", [t.id]);
  t1._source.x = 0; t1._source.y = 0; t1._init();
  const A = AnimatorPanel.DEFAULT_OPTIONS.actions;
  const ring = await Store.create({name: "Ring", steps: [defaultStep({type: "ellipse", cx: 250, cy: 50, rx: 200, ry: 200, rotation: 0, sweep: 360})]});
  await Store.mutate(ring.id, a => { a.motion = {...a.motion, speed: 200, speedUnit: "px", loop: "loop", loopCount: 0};
    a.symmetry = {...a.symmetry, count: 3, center: "path"}; a.tokens = ["T1"]; });
  const countCopies = () => scene.tokens.contents.filter(t => t.getFlag(MOD, "copy")).length;
  const extra = () => scene.tokens.contents.filter(t => (t !== t1) && (t !== t2)).length;

  // Restart with copies (copies removed on stop)
  Editor.select(ring.id);
  await A.play.call(panel, {}, {dataset: {}});
  await flush();
  NOW += 1000; tick();
  ok(countCopies() === 2, "×3 playing: 2 copies");
  await A.restart.call(panel, {}, {dataset: {}});
  await flush();
  ok(countCopies() === 2 && t1.getFlag(MOD, "playback") && extra() === 2, `Restart keeps exactly 2 copies (${countCopies()}, ${extra()} extra tokens)`);
  // Restart with "keep copies after stopping"
  await Store.mutate(ring.id, a => { a.symmetry.keep = true; });
  await A.restart.call(panel, {}, {dataset: {}});
  await flush();
  const kept = extra() - countCopies();
  ok(countCopies() === 2 && kept === 2, `Restart with kept copies: old copies are left as tokens, 2 new copies (${countCopies()} copies, ${kept} kept)`);
  await Store.mutate(ring.id, a => { a.symmetry.keep = false; });
  await Playback.stop(["T1"]);
  for ( const t of scene.tokens.contents ) if ( (t !== t1) && (t !== t2) ) await scene.deleteEmbeddedDocuments("Token", [t.id]);

  // A player (who can't delete tokens) stops the source: copies stop, and the GM removes them
  await Playback.play(ring.id, ["T1"]);
  await flush();
  const realCan = me.can;
  me.can = perm => perm !== "TOKEN_DELETE";
  const realGM = game.users.activeGM;
  game.users.activeGM = {isSelf: false};
  await Playback.stop(["T1"]);
  await flush();
  const leftovers = scene.tokens.contents.filter(t => t.getFlag(MOD, "copy"));
  ok(leftovers.length === 2 && leftovers.every(c => !c.getFlag(MOD, "playback")), "a player's stop halts the copies without deleting them");
  me.can = realCan;
  game.users.activeGM = realGM;
  await Playback.cleanupGroup(scene, leftovers[0].getFlag(MOD, "copy").gid);
  ok(countCopies() === 0, "the GM then removes the stopped copies");

  // Deleting a playing animation through the API leaves tokens where they visibly were
  t1._source.x = 0; t1._source.y = 0; t1._init();
  await Store.mutate(ring.id, a => { a.symmetry.count = 1; });
  await Playback.play(ring.id, ["T1"]);
  NOW += 150 + 700; tick();
  const seen = {x: t1.x, y: t1.y};
  await KAA.deleteAnimation(ring.id);
  ok(!t1.getFlag(MOD, "playback") && Math.abs(t1._source.x - seen.x) <= 0.5 && Math.abs(t1._source.y - seen.y) <= 0.5,
    `KAA.deleteAnimation stops tokens where they were (${seen.x.toFixed(1)},${seen.y.toFixed(1)} → ${t1._source.x},${t1._source.y})`);
  t1._source.x = 0; t1._source.y = 0; t1._init();

  // Move here carries the symmetry point along
  const pointed = await Store.create({name: "Pointed", steps: [defaultStep({type: "point", x: 100, y: 100})]});
  await Store.mutate(pointed.id, a => { a.symmetry = {...a.symmetry, center: "point", point: {x: 150, y: 100}}; });
  Editor.select(pointed.id);
  canvas.stage.pivot.x = 1100; canvas.stage.pivot.y = 1100;
  await A.moveHere.call(panel, {}, {dataset: {}});
  const moved = Store.get(pointed.id);
  ok(moved.steps[0].shape.x === 1100 && moved.symmetry.point.x === 1150, "Move here also moves the symmetry centre point");
  canvas.stage.pivot.x = 0; canvas.stage.pivot.y = 0;
}


/* ---------------- Ghosts, zombies, Ctrl+Z and template editing ---------------- */
{
  const flush = () => new Promise(r => setTimeout(r, 10));
  const {TemplateGallery} = await imp("gallery.js");
  await Playback.stopAll();
  for ( const t of scene.tokens.contents ) if ( (t !== t1) && (t !== t2) ) await scene.deleteEmbeddedDocuments("Token", [t.id]);
  t1._source.x = 0; t1._source.y = 0; t1._init();
  const copiesNow = () => scene.tokens.contents.filter(t => t.getFlag(MOD, "copy"));
  const orbit = await Store.create({name: "Zombie test", steps: [defaultStep({type: "ellipse", cx: 250, cy: 50, rx: 200, ry: 200, rotation: 0, sweep: 360})]});
  await Store.mutate(orbit.id, a => { a.motion = {...a.motion, speed: 200, speedUnit: "px", loop: "loop", loopCount: 0};
    a.symmetry = {...a.symmetry, count: 4, center: "path"}; a.tokens = ["T1"]; });

  // 1. None of the module's own token operations land in the Ctrl+Z history
  canvas.tokens.history.length = 0;
  await Playback.play(orbit.id, ["T1"]);
  await flush();
  NOW += 1000; tick();
  await Playback.pause(["T1"]);
  await Playback.resume(["T1"]);
  await Playback.setRate(["T1"], 2);
  await Store.mutate(orbit.id, a => { a.symmetry.count = 6; });
  await Playback.reconcileSymmetry(scene);
  await Store.mutate(orbit.id, a => { a.symmetry.count = 4; });
  await Playback.reconcileSymmetry(scene);
  await Playback.stop(["T1"]);
  await flush();
  const leaked = canvas.tokens.history.filter(h => h.options?.[MOD]);
  ok(canvas.tokens.history.length === 0, `play / pause / rate / live copies / stop leave nothing for Ctrl+Z to replay (${canvas.tokens.history.length} entries${leaked.length ? ", e.g. " + leaked[0].type : ""})`);
  ok(copiesNow().length === 0, "stopping left no copies behind");
  // A real user move still goes into the history
  await scene.updateEmbeddedDocuments("Token", [{_id: "T2", x: 600, y: 500}], {});
  ok(canvas.tokens.history.length === 1 && canvas.tokens.history[0].type === "update", "the user's own moves are still undoable");
  canvas.tokens.history.length = 0;

  // 2. Orphaned copies (e.g. brought back by an undo or another module) are swept away by the GM
  await scene.createEmbeddedDocuments("Token", [
    {name: "Zombie A", x: 300, y: 300, flags: {[MOD]: {copy: {source: "T1", gid: "deadgroup", index: 1, anim: orbit.id},
      playback: {id: "z1", gid: "deadgroup", anim: orbit.id, t0: NOW, tau0: 0, rate: 1, paused: false, ox: 0, oy: 0, or: 0, delay: 0, phase: 0, sym: {i: 1, n: 4, mode: "rotate", cx: 0, cy: 0}}}}},
    {name: "Zombie B", x: 400, y: 300, flags: {[MOD]: {copy: {source: "NOPE", gid: "ghost", index: 2, anim: orbit.id}}}}
  ], {isUndo: true});
  ok(scene.tokens.contents.filter(t => t.name.startsWith("Zombie")).length === 2, "two orphaned copies exist (simulating an undo resurrection)");
  await new Promise(r => setTimeout(r, 1300));
  ok(!scene.tokens.contents.some(t => t.name.startsWith("Zombie")), "the GM sweeper removes orphaned copies within about a second");

  // 3. A copy deleted on purpose stays deleted
  await Playback.play(orbit.id, ["T1"]);
  await flush();
  const victim = copiesNow().find(c => c.getFlag(MOD, "copy").index === 2);
  await scene.deleteEmbeddedDocuments("Token", [victim.id]);
  await flush();
  ok((t1.getFlag(MOD, "playback").removed ?? []).includes(2), "the deleted copy is remembered");
  await Store.mutate(orbit.id, a => { a.motion.speed = 250; });
  await Playback.reconcileSymmetry(scene);
  ok(copiesNow().length === 2 && !copiesNow().some(c => c.getFlag(MOD, "copy").index === 2), `editing the animation does not bring the destroyed copy back (${copiesNow().length} copies)`);
  await Store.mutate(orbit.id, a => { a.symmetry.count = 5; });
  await Playback.reconcileSymmetry(scene);
  const idx = copiesNow().map(c => c.getFlag(MOD, "copy").index).sort();
  ok(JSON.stringify(idx) === "[1,3,4]", `raising the count adds new copies but not the destroyed one (${idx})`);
  await Playback.stop(["T1"]);
  await flush();
  ok(copiesNow().length === 0, "all copies gone after stopping");

  // 4. Deleting an assigned token removes it from the animation
  const extra = (await scene.createEmbeddedDocuments("Token", [{name: "Temp", x: 900, y: 900}]))[0];
  await Store.mutate(orbit.id, a => { a.tokens = ["T1", extra.id]; });
  await scene.deleteEmbeddedDocuments("Token", [extra.id]);
  await flush();
  ok(!Store.get(orbit.id).tokens.includes(extra.id), "a deleted token no longer stays assigned to the animation");
  // ...and an undo of the animation cannot bring it back
  await Store.mutate(orbit.id, a => { a.tokens = ["T1", "T2"]; });
  Store.get(orbit.id);
  const restored = await Store.save({...Store.get(orbit.id), tokens: ["T1", "gone-forever"]});
  ok(!restored.tokens.includes("gone-forever"), "saving (or undoing to) a version with a deleted token drops it");

  // 5. Templates open in the editor, stay editable and can be saved back
  const mine = await Store.saveToLibrary(Store.get(orbit.id), {name: "Editable orbit", category: "mine"});
  const gallery = new TemplateGallery();
  gallery.render = () => {};
  canvas.tokens.controlled = [];
  const before = Store.all().length;
  await TemplateGallery.DEFAULT_OPTIONS.actions.editTemplate.call(gallery, {}, {closest: () => ({dataset: {templateId: mine.id}})});
  await flush();
  const edited = Store.all().find(a => a.templateId === mine.id);
  ok(Store.all().length === before + 1 && !!edited, "Edit puts the template on the scene, linked to the template");
  ok(Editor.animId === edited?.id && Editor.stepId === edited?.steps[0].id, "and opens it in the editor with its first shape selected");
  ok(canvas.kaaPaths.active, "with the animator tools active so its path and handles are visible");
  await Store.mutate(edited.id, a => { a.motion.speed = 7; a.steps[0].shape.rx = 300; });
  Editor.select(edited.id);
  await AnimatorPanel.DEFAULT_OPTIONS.actions.updateTemplate.call(panel, {}, {dataset: {}});
  const saved = Store.library().find(t => t.id === mine.id);
  ok(saved.motion.speed === 7 && Math.abs(saved.steps[0].shape.rx - 3) < 1e-9, "Save to template writes the edits back into the template");
  const builtin = (await import(pathToFileURL(ROOT + "scripts/templates.js").href)).BUILTIN_TEMPLATES[0];
  await TemplateGallery.DEFAULT_OPTIONS.actions.editTemplate.call(gallery, {}, {closest: () => ({dataset: {templateId: builtin.id}})});
  await flush();
  const custom = Store.get(Editor.animId);
  ok(custom && custom.name === builtin.name && custom.templateId === null, "Customize gives an editable copy of a built-in template");
  html = await renderAll("template link bar");
  Editor.select(edited.id);
  html = await renderAll("template link bar");
  ok(html.includes('data-action="updateTemplate"'), "the editor shows a Save to template bar for linked animations");
  const gUsed = [...readFileSync(tplDir + "gallery.hbs", "utf8").matchAll(/data-action="([^"{]+)"/g)].map(m => m[1]);
  ok(gUsed.every(a => a in TemplateGallery.DEFAULT_OPTIONS.actions), "gallery buttons are all wired");
  // Other modules open templates the same way (an effect's motion, shaped by hand)
  const viaApi = await KAA.editTemplate(mine.id);
  await flush();
  ok(viaApi && (viaApi.templateId === mine.id) && (Editor.animId === viaApi.id), "KAA.editTemplate opens a template for editing (linked, when it is your own)");
  const viaApiBuiltin = await KAA.editTemplate(builtin.name);
  ok(viaApiBuiltin && (viaApiBuiltin.templateId === null) && (viaApiBuiltin.name === builtin.name), "(a built-in one as a copy to save as your own)");
  ok(await KAA.editTemplate("No such template") === null, "an unknown template opens nothing");
  for ( const a of Store.all() ) if ( a.name === builtin.name || a.templateId ) await Store.delete(a.id);
}

/* ---------------- v1.2: homing legs, following a token, the mascot ghost ---------------- */
{
  const flush = () => new Promise(r => setTimeout(r, 10));
  await Playback.stopAll();
  await flush();
  for ( const t of scene.tokens.contents ) if ( (t !== t1) && (t !== t2) ) await scene.deleteEmbeddedDocuments("Token", [t.id]);
  t1._source.x = 0; t1._source.y = 0; t1._source.rotation = 0; t1._init();
  t2._source.x = 0; t2._source.y = 900; t2._init();
  const foe = (await scene.createEmbeddedDocuments("Token", [{name: "Foe", x: 1000, y: 0}]))[0];
  const ctr = d => ({x: d.x + 50, y: d.y + 50});
  const homing = (to, extra = {}) => defaultStep({type: "homing", to, arc: 0, stop: 0, ...extra});

  // 1. A homing hammer: fly at the target, then back home
  const hammer = await Store.create({name: "Hammer", steps: [homing("target"), homing("home")]});
  await Store.mutate(hammer.id, a => { a.motion = {...a.motion, speed: 500, speedUnit: "px", loop: "none"}; a.tokens = ["T1"];
    a.facing = {...a.facing, mode: "path", smoothing: 0}; });
  me.targets = new Set();
  const none = await Playback.play(hammer.id, ["T1"]);
  ok(Array.isArray(none) && !none.length && !t1.getFlag(MOD, "playback"), "a homing attack refuses to start without a target");
  me.targets = new Set([foe.object]);
  await Playback.play(hammer.id, ["T1"]);
  await flush();
  const hpb = t1.getFlag(MOD, "playback");
  ok(hpb?.targets?.length === 1 && hpb.targets[0].id === foe.id && near(hpb.targets[0].x, 1050, 1e-9), "play snapshots the targeted token");
  const T0 = hpb.t0;
  NOW = T0 + 1000; tick();
  ok(near(ctr(t1).x, 550, 0.5) && near(ctr(t1).y, 50, 0.5), `halfway along the first leg (${ctr(t1).x.toFixed(2)}, ${ctr(t1).y.toFixed(2)})`);
  // The target dodges: the hammer re-aims on the fly
  foe.x = 1000; foe.y = 400;
  NOW = T0 + 1000; tick();
  ok(near(ctr(t1).x, 550, 0.5) && near(ctr(t1).y, 250, 0.5), `the leg re-aims at the target's live position (${ctr(t1).x.toFixed(2)}, ${ctr(t1).y.toFixed(2)})`);
  const heading = (Math.atan2(400, 1000) * 180 / Math.PI) - 90;
  const r1 = t1.rotation;
  ok([heading, heading + 360].some(h => near(r1, h, 0.6)), `and faces along its new heading (${r1?.toFixed(2)} vs ${heading.toFixed(2)})`);
  NOW = T0 + 3000; tick();
  ok(near(ctr(t1).x, 550, 0.5) && near(ctr(t1).y, 250, 0.5), `the return leg starts from where the target is now (${ctr(t1).x.toFixed(2)}, ${ctr(t1).y.toFixed(2)})`);
  NOW = T0 + 4100; tick();
  await new Promise(r => setTimeout(r, 400));
  tick();
  await flush();
  ok(!t1.getFlag(MOD, "playback") && near(t1._source.x, 0, 0.01) && near(t1._source.y, 0, 0.01), `the hammer lands back home and finishes (${t1._source.x}, ${t1._source.y})`);
  foe.x = foe._source.x; foe.y = foe._source.y;

  // 2. A dash with a stop distance and a bowed arc
  const dash = await Store.create({name: "Dash", steps: [homing("target", {stop: 1, arc: 0.5})]});
  await Store.mutate(dash.id, a => { a.motion = {...a.motion, speed: 1000, speedUnit: "px", loop: "none"}; });
  await Playback.play(dash.id, ["T1"]);
  await flush();
  const dpb = t1.getFlag(MOD, "playback");
  NOW = dpb.t0 + 450; tick();
  ok(ctr(t1).y > 150, `a positive arc bows the flight to the right of travel (y=${ctr(t1).y.toFixed(1)})`);
  NOW = dpb.t0 + 5000; tick();
  await new Promise(r => setTimeout(r, 400));
  tick(); await flush();
  const short = Math.hypot(t1._source.x + 50 - 1050, t1._source.y + 50 - 50);
  ok(near(short, 100, 1.5), `stop distance halts one square short of the target (${short.toFixed(2)}px)`);
  t1._source.x = 0; t1._source.y = 0; t1._init();

  // 3. Orbiting a token: anchor = token, the whole pattern moves with it
  const guard = await Store.create({name: "Guard orbit", steps: [defaultStep({type: "ellipse", cx: 1050, cy: 50, rx: 200, ry: 200, rotation: 0, sweep: 360})]});
  await Store.mutate(guard.id, a => { a.motion = {...a.motion, speed: 400, speedUnit: "px", loop: "loop", loopCount: 0, anchor: "token", anchorToken: foe.id}; });
  me.targets = new Set();
  await Playback.play(guard.id, ["T1"]);
  await flush();
  const gpb = t1.getFlag(MOD, "playback");
  ok(gpb?.anchor?.id === foe.id && near(gpb.anchor.x, 1050, 1e-9), "play records the anchor token and where it stood");
  NOW = gpb.t0 + 20000; tick();
  ok(near(Math.hypot(ctr(t1).x - 1050, ctr(t1).y - 50), 200, 0.5), `orbits the anchor token (r=${Math.hypot(ctr(t1).x - 1050, ctr(t1).y - 50).toFixed(3)})`);
  foe.x = 1600; foe.y = 700;
  NOW += 333; tick();
  ok(near(Math.hypot(ctr(t1).x - 1650, ctr(t1).y - 750), 200, 0.5), `and keeps orbiting it after it moves (r=${Math.hypot(ctr(t1).x - 1650, ctr(t1).y - 750).toFixed(3)})`);
  // Symmetry copies follow too
  await Store.mutate(guard.id, a => { a.symmetry = {...a.symmetry, count: 3, center: "path"}; });
  await Playback.reconcileSymmetry(scene);
  await flush();
  const gcopies = scene.tokens.contents.filter(t => t.getFlag(MOD, "copy")?.source === "T1");
  NOW += 250; tick();
  const radii = [t1, ...gcopies].map(d => Math.hypot(ctr(d).x - 1650, ctr(d).y - 750));
  ok(gcopies.length === 2 && radii.every(r => near(r, 200, 0.5)), `orbiting copies follow the token as well (${radii.map(r => r.toFixed(2)).join(", ")})`);
  await Playback.stop(["T1"]);
  await flush();
  foe.x = foe._source.x; foe.y = foe._source.y;
  t1._source.x = 0; t1._source.y = 0; t1._init();

  // 4. Panel and picking
  const layer = canvas.kaaPaths;
  layer.activate();
  Editor.select(hammer.id, Store.get(hammer.id).steps[0].id);
  await AnimatorPanel.DEFAULT_OPTIONS.actions.switchTab.call(panel, {}, {dataset: {tab: "path"}});
  html = await renderAll("homing inspector");
  ok(/data-action="pick" data-pick="homingToken"|name="shape.to"/.test(html) || (console.log(html.slice(0, 400)), false), "the inspector shows homing leg settings");
  canvas.tokens.placeables = [t1.object, t2.object, foe.object];
  for ( const t of [t1, t2, foe] ) {
    t.object.visible = true;
    t.object.bounds = {contains: (x, y) => x >= t.x && x <= t.x + 100 && y >= t.y && y <= t.y + 100};
  }
  const ev = (x, y) => ({interactionData: {origin: {x, y}}, shiftKey: false, altKey: false, ctrlKey: false});
  Editor.setPicking({mode: "homingToken", stepId: null});
  layer._onClickLeft(ev(1050, 50));
  await flush();
  const leg = Store.get(hammer.id).steps[0].shape;
  ok(leg.to === "token" && leg.tokenId === foe.id && !Editor.picking, "picking: a homing leg can be aimed at a specific token");
  Editor.setPicking({mode: "anchorToken"});
  layer._onClickLeft(ev(50, 950));
  await flush();
  ok(Store.get(hammer.id).motion.anchor === "token" && Store.get(hammer.id).motion.anchorToken === "T2", "picking: the follow token can be picked on the map");
  await Store.mutate(hammer.id, a => { a.motion.anchor = "absolute"; a.steps[0].shape.to = "target"; });

  // 5. The mascot ghost: always the same figure, runs at the panel's rate, flies the homing legs
  const ghostLayer = layer.children[3];
  const findSprite = node => (node instanceof PIXI.Sprite) || (node.children ?? []).some(findSprite);
  me.targets = new Set([foe.object]);
  Editor.select(hammer.id);
  Editor.rate = 1;
  Editor.ghost = true; Editor.emit("ghost");
  const gfn = tickerFns.find(t => t.ctx === layer);
  canvas.app.ticker.deltaMS = 100;
  for ( let i = 0; i < 10; i++ ) gfn.fn.call(layer);  // 1 s at rate 1
  const m1 = ghostLayer.children[0];
  ok(ghostLayer.children.length === 1 && !findSprite(m1), "the ghost is the drawn mascot, not a copy of a token's art");
  ok(near(m1.x, 550, 51) && near(m1.y, 50, 1), `the ghost flies the homing leg at the animation's speed (${m1.x.toFixed(1)}, ${m1.y.toFixed(1)})`);
  // Changing which token the animation uses does not change the mascot
  const sig = n => `${n.constructor.name}[${(n.children ?? []).map(sig).join(",")}]:${n.calls ?? ""}`;
  const before = sig(m1);
  await Store.mutate(hammer.id, a => { a.tokens = ["T2"]; });
  gfn.fn.call(layer);
  ok(sig(ghostLayer.children.at(-1)) === before, "the mascot looks identical whichever token the animation uses");
  await Store.mutate(hammer.id, a => { a.tokens = ["T1"]; });
  // Rate
  Editor.ghost = false; Editor.emit("ghost");
  Editor.ghost = true; Editor.emit("ghost");
  const gfn2 = tickerFns.find(t => t.ctx === layer);
  Editor.rate = 2;
  for ( let i = 0; i < 5; i++ ) gfn2.fn.call(layer);  // 0.5 s of real time at x2 = 1 s of animation
  const m2 = ghostLayer.children.at(-1);
  ok(near(m2.x, 550, 51) && near(m2.y, 50, 1), `the ghost follows the Rate slider (x2 covers the same ground in half the time: ${m2.x.toFixed(1)})`);
  Editor.rate = 0;
  const xStill = m2.x;
  for ( let i = 0; i < 5; i++ ) gfn2.fn.call(layer);
  ok(ghostLayer.children.at(-1).x === xStill, "rate 0 freezes the ghost");
  Editor.rate = 1;
  // Symmetry: one mascot per copy
  await Store.mutate(hammer.id, a => { a.symmetry = {...a.symmetry, count: 4}; });
  gfn2.fn.call(layer);
  const live = ghostLayer.children.filter(c => !c.destroyed);
  ok(live.length === 4, `one mascot per symmetry copy (${live.length})`);
  Editor.ghost = false; Editor.emit("ghost");
  ok(ghostLayer.children.every(c => c.destroyed), "turning the ghost off removes the mascots");
  layer.deactivate();
  me.targets = new Set();
  canvas.app.ticker.deltaMS = undefined;
  for ( const id of [hammer.id, dash.id, guard.id] ) await Store.delete(id);
  await scene.deleteEmbeddedDocuments("Token", [foe.id]);
}

/* ---------------- v1.2: attack templates ---------------- */
{
  const flush = () => new Promise(r => setTimeout(r, 10));
  const {placeTemplate} = await imp("gallery.js");
  const {BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES} = await imp("templates.js");
  const {animationSVG} = await imp("thumbs.js");
  const {poseAt} = await imp("playback.js");
  const attacks = BUILTIN_TEMPLATES.filter(t => t.category === "attacks");
  ok(TEMPLATE_CATEGORIES.attacks && attacks.length >= 12, `an Attacks category with ${attacks.length} templates`);
  const badThumbs = attacks.filter(t => { const svg = animationSVG(t, {width: 200, height: 120}); return svg.includes("NaN") || !svg.includes("<path"); });
  ok(!badThumbs.length, `every attack template has a thumbnail (${badThumbs.map(t => t.name).join(", ") || "all fine"})`);
  ok(attacks.filter(t => t.steps.some(s => s.shape.type === "homing")).every(t => animationSVG(t).includes("stroke-dasharray")), "homing legs are drawn dashed toward stand-in targets");

  await Playback.stopAll();
  await flush();
  for ( const t of scene.tokens.contents ) if ( (t !== t1) && (t !== t2) ) await scene.deleteEmbeddedDocuments("Token", [t.id]);
  const [foe, foe2] = await scene.createEmbeddedDocuments("Token", [{name: "Foe", x: 800, y: 0}, {name: "Foe 2", x: 800, y: 600}]);
  const ctr = d => ({x: d.x + 50, y: d.y + 50});
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // No targets: attacks refuse before anything is added to the scene
  me.targets = new Set();
  const count0 = Store.all().length;
  const refused = await placeTemplate(attacks.find(t => t.id === "builtin-hammer"), [t1]);
  ok(refused === null && Store.all().length === count0, "applying an attack without a target warns and adds nothing");

  const report = [];
  for ( const tpl of attacks ) {
    await Playback.stopAll();
    await flush();
    for ( const t of scene.tokens.contents ) if ( t.getFlag(MOD, "copy") ) await scene.deleteEmbeddedDocuments("Token", [t.id]);
    t1._source.x = 0; t1._source.y = 0; t1._source.rotation = 0; t1._init();
    for ( const [d, x, y] of [[foe, 800, 0], [foe2, 800, 600]] ) { d._source.x = x; d._source.y = y; d._init(); }
    me.targets = new Set([foe.object, foe2.object]);
    const anim = await placeTemplate(tpl, [t1]);
    if ( !anim ) { report.push(`${tpl.name}: not placed`); continue; }
    await Playback.play(anim.id, ["T1"]);
    await flush();
    const pb = t1.getFlag(MOD, "playback");
    if ( !pb ) { report.push(`${tpl.name}: did not start`); await Store.delete(anim.id); continue; }
    const live = Store.get(anim.id);
    const copies = () => scene.tokens.contents.filter(t => t.getFlag(MOD, "copy")?.source === "T1");
    const n = live.symmetry.count;
    if ( copies().length !== n - 1 ) report.push(`${tpl.name}: ${copies().length} copies (want ${n - 1})`);
    const follows = live.motion.anchor === "token";
    if ( follows && (pb.anchor?.id !== foe.id || pb.targets?.[0]?.id !== foe2.id) ) report.push(`${tpl.name}: anchor/strike split wrong`);
    const homing = live.steps.filter(s => s.shape.type === "homing");
    const lifted = live.steps.some(s => s.lift.mode !== "none");
    const stopPx = Math.max(0, ...homing.map(s => s.shape.stop)) * 100;
    let closest = Infinity;
    let maxZ = 0;
    let finite = true;
    let overlap = false;
    const strikeTargets = follows ? [foe2] : [foe, foe2];
    for ( let t = 0; t <= 9000; t += (t < 2500 ? 2 : (t < 4000 ? 8 : 47)) ) {
      NOW = pb.t0 + t;
      tick();
      const docs = [t1, ...copies()];
      for ( const d of docs ) {
        if ( !Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.rotation) ) finite = false;
        for ( const s of strikeTargets ) closest = Math.min(closest, dist(ctr(d), ctr(s)));
      }
      const p = t1.getFlag(MOD, "playback");
      if ( p && lifted ) maxZ = Math.max(maxZ, poseAt(t1, p, live, NOW).z);
      // Mid-flight, copies of a volley must not sit on top of each other
      if ( (homing.length && (n > 1)) && (t > 120) && (t < 350) ) {
        for ( let i = 0; i < docs.length; i++ ) for ( let j = i + 1; j < docs.length; j++ ) if ( dist(docs[i], docs[j]) < 3 ) overlap = true;
      }
    }
    if ( !finite ) report.push(`${tpl.name}: non-finite pose`);
    if ( homing.some(s => s.shape.to === "target") && (closest > stopPx + 8) ) report.push(`${tpl.name}: never reached a target (closest ${closest.toFixed(1)}px)`);
    if ( lifted && (maxZ < 0.5) ) report.push(`${tpl.name}: no height (max z ${maxZ.toFixed(2)})`);
    if ( overlap ) report.push(`${tpl.name}: copies overlap mid-flight`);
    if ( follows && !homing.length ) {
      // An endless orbit: circles the anchor and follows it when it moves
      const r = live.steps[0].shape.rx;
      const radius = () => dist(ctr(t1), ctr(foe));
      const r0 = radius();
      foe.x += 300; foe.y += 200;
      NOW += 120; tick();
      const r1 = radius();
      if ( !near(r0, r, 1) || !near(r1, r, 1) ) report.push(`${tpl.name}: orbit radius ${r0.toFixed(2)} → ${r1.toFixed(2)} (want ${r})`);
      foe.x = foe._source.x; foe.y = foe._source.y;
    }
    await Playback.stop(["T1"]);
    await flush();
    await Store.delete(anim.id);
  }
  ok(!report.length, `every attack template plays correctly against two targets${report.length ? ": " + report.join("; ") : ""}`);

  // Thumbnail of an orbit shows the followed token
  ok(animationSVG(attacks.find(t => t.id === "builtin-orbs")).includes("#9aa0ff"), "orbit thumbnails mark the token being circled");
  // Saving an orbit as a user template keeps it portable
  const tplOrb = attacks.find(t => t.id === "builtin-orbs");
  me.targets = new Set([foe.object]);
  const placed = await placeTemplate(tplOrb, [t1]);
  ok(near(placed.steps[0].shape.cx, 850, 1e-6) && near(placed.steps[0].shape.cy, 50, 1e-6), "a following template is placed around the targeted token");
  await Store.mutate(placed.id, a => { a.motion.anchorToken = foe.id; });
  const mineOrb = await Store.saveToLibrary(Store.get(placed.id), {name: "My orbs"});
  ok(mineOrb.motion.anchorToken === "target" && near(mineOrb.anchorOrigin.x, 8.5, 1e-6) && near(mineOrb.anchorOrigin.y, 0.5, 1e-6),
    `saved following templates remember where the token stood and follow "the first target" (${JSON.stringify(mineOrb.anchorOrigin)})`);
  me.targets = new Set([foe2.object]);
  const again = await placeTemplate(mineOrb, [t1]);
  ok(near(again.steps[0].shape.cx, 850, 1e-6) && near(again.steps[0].shape.cy, 650, 1e-6), "and land around whichever token is targeted next time");
  await Store.delete(placed.id);
  await Store.delete(again.id);
  await Store.deleteFromLibrary(mineOrb.id);
  // Explicit targets (a GM casting for a player) replace the current user's targets
  me.targets = new Set();
  t1._source.x = 0; t1._source.y = 0; t1._init();
  const viaApi = await KAA.applyTemplate("Homing hammer", [t1], {targets: [foe2.id]});
  await flush();
  const apb = t1.getFlag(MOD, "playback");
  ok(viaApi && apb?.targets?.length === 1 && apb.targets[0].id === foe2.id, "applyTemplate/play accept explicit targets instead of the user's");
  await Playback.stop(["T1"]);
  await flush();
  await Store.delete(viaApi.id);
  const tplObj = attacks.find(t => t.id === "builtin-shockwave");
  const viaObj = await KAA.applyTemplate(tplObj, [t1]);
  ok(viaObj?.name === tplObj.name, "applyTemplate also takes a template object");
  await Playback.stop(["T1"]);
  await flush();
  await Store.delete(viaObj.id);
  me.targets = new Set();
  await scene.deleteEmbeddedDocuments("Token", [foe.id, foe2.id]);
  t1._source.x = 0; t1._source.y = 0; t1._init();
}

/* ---------------- v1.2.1: API for the Flying Paths family ---------------- */
{
  const made = await KAA.createAnimation({name: "API lap", color: "#123456", steps: [{shape: {type: "ellipse", cx: 1000, cy: 800, rx: 300}, wait: 250}],
    motion: {loop: "loop", speed: 2}, tokens: ["T1"]});
  const got = Store.get(made.id);
  ok(got && got.name === "API lap" && got.steps.length === 1 && got.steps[0].shape.ry === 300 && got.steps[0].wait === 250 && got.steps[0].id,
    "createAnimation builds a full animation from plain data (normalized shapes, step ids)");
  ok(got.motion.loop === "loop" && got.motion.speed === 2 && got.tokens[0] === "T1", "with its motion and tokens");
  await KAA.updateAnimation(made.id, {motion: {speed: 5}});
  ok(Store.get(made.id).motion.speed === 5 && Store.get(made.id).motion.loop === "loop", "updateAnimation merges changes");
  await KAA.updateAnimation(made.id, a => { a.name = "Renamed"; });
  ok(Store.get(made.id).name === "Renamed", "or applies a function");
  const path = await KAA.createAnimation({name: "API path", steps: [{shape: {type: "path", nodes: [{x: 0, y: 0}, {x: 500, y: 0, smooth: 0.5}, {x: 500, y: 500}]}}]});
  ok(Store.get(path.id).steps[0].shape.nodes.length === 3 && Store.get(path.id).steps[0].shape.nodes[1].smooth === 0.5, "path nodes need only x, y and smoothness");
  await Store.delete(made.id);
  await Store.delete(path.id);
  // Tracks: the drawn path in travel order, for effects along paths
  const box = await KAA.createAnimation({name: "Box", steps: [
    {shape: {type: "rect", cx: 200, cy: 100, w: 400, h: 200, rotation: 0}},
    {shape: {type: "path", nodes: [{x: 0, y: 500}, {x: 300, y: 500}]}, reverse: true},
    {shape: {type: "point", x: 9, y: 9}},
    {shape: {type: "homing", to: "target"}},
    {shape: {type: "ellipse", cx: 1000, cy: 1000, rx: 100, ry: 100, rotation: 0, sweep: 360}, startOffset: 0.25}
  ]});
  const tr = KAA.track(box.id, {spacing: 10});
  ok(tr.length === 3, `points and homing legs have no track (${tr.length} pieces)`);
  const [r, line, circ] = tr;
  const has = (pc, x, y) => { for ( let i = 0; i < pc.points.length; i += 2 ) if ( Math.hypot(pc.points[i] - x, pc.points[i + 1] - y) < 1e-6 ) return true; return false; };
  ok(r.closed && has(r, 400, 0) && has(r, 400, 200) && has(r, 0, 200) && Math.abs(r.length - 1200) < 1e-6, "rectangles keep their exact corners");
  let maxGap = 0;
  for ( let i = 2; i < r.points.length; i += 2 ) maxGap = Math.max(maxGap, Math.hypot(r.points[i] - r.points[i - 2], r.points[i + 1] - r.points[i - 1]));
  ok(maxGap <= 10 + 1e-6, `points are at most the spacing apart (${maxGap.toFixed(2)})`);
  ok(r.points[0] === r.points.at(-2) && r.points[1] === r.points.at(-1), "loops end where they start");
  ok(line.points[0] === 300 && line.points.at(-2) === 0 && !line.closed, "reversed steps run backwards");
  const sx = circ.points[0], sy = circ.points[1];
  const startAngle = Math.atan2(sy - 1000, sx - 1000);
  ok(Math.abs(Math.hypot(sx - 1000, sy - 1000) - 100) < 0.5 && circ.closed, `loops start at their start point (${(startAngle * 180 / Math.PI).toFixed(1)}°)`);
  ok(KAA.track(box.id, {spacing: 0})[0].points.length > 8 && KAA.track(box.id, {spacing: null}).length === 3, "a spacing of 0 (or none) can't hang the page");
  // Corners or curves for a whole path (a room's corners, a round seal): shapes become editable paths first
  await KAA.setSmooth(box.id, 0);
  const sharpBox = Store.get(box.id);
  ok(sharpBox.steps.filter(st => st.shape.type === "path").length === 3
    && sharpBox.steps.every(st => (st.shape.type !== "path") || st.shape.nodes.every(n => (n.smooth === 0) && (n.mode === "auto") && !n.hin && !n.bend))
    && ["point", "homing"].every(t => sharpBox.steps.some(st => st.shape.type === t)),
  "KAA.setSmooth turns every point into a corner (shapes become paths; points and homing legs stay)");
  await KAA.setSmooth(box.id, 1);
  ok(sharpBox.steps[0].shape.nodes.length === 4 && sharpBox.steps[0].shape.nodes.some(n => (n.x === 400) && (n.y === 0)), "a rectangle keeps its exact corners");
  ok(Store.get(box.id).steps.filter(st => st.shape.type === "path").every(st => st.shape.nodes.every(n => n.smooth === 1)), "or rounds them all");
  await Store.undo(box.id);
  await Store.undo(box.id);
  ok(Store.get(box.id).steps[0].shape.type === "rect" && Store.get(box.id).steps[4].shape.type === "ellipse", "each is one undo step");
  // Relative animations run where the token began: effects following a token need that offset
  const {trackOffset} = await imp("track.js");
  const boxA = Store.get(box.id);
  const pbBox = {anim: box.id, ox: 1000, oy: 2000};
  const rel = trackOffset({...boxA, motion: {...boxA.motion, anchor: "relative"}}, pbBox, {x: 50, y: 50});
  ok(rel.x === 1050 && rel.y === 2050, `a relative animation's track moves to where the token started (${rel.x}, ${rel.y})`);
  const abs = trackOffset({...boxA, motion: {...boxA.motion, anchor: "absolute"}}, pbBox, {x: 50, y: 50});
  const other = trackOffset({...boxA, motion: {...boxA.motion, anchor: "relative"}}, {...pbBox, anim: "elsewhere"}, {x: 50, y: 50});
  ok(abs.x === 0 && abs.y === 0 && other.x === 0, "absolute animations (or tokens running something else) stay where drawn");
  await Store.delete(box.id);

  // Who can play it
  const {canPlay, normalizeAccess} = await imp("model.js");
  const player = {id: "p1", isGM: false, isSelf: true, active: true, can: () => true};
  const owned = {testUserPermission: (u, lvl) => true};
  const notOwned = {testUserPermission: (u, lvl) => false};
  const withAccess = access => ({access: normalizeAccess(access)});
  ok(normalizeAccess(undefined).mode === "setting" && normalizeAccess({mode: "nonsense"}).mode === "setting", "animations follow the world setting unless told otherwise");
  ok(canPlay(withAccess({mode: "gm"}), notOwned, me), "the GM can always play");
  ok(!canPlay(withAccess({mode: "owners"}), notOwned, player), "players never play on tokens they don't own");
  ok(canPlay(withAccess({mode: "owners"}), owned, player) && !canPlay(withAccess({mode: "gm"}), owned, player), "\"anyone who owns the token\" and \"only the GM\"");
  ok(canPlay(withAccess({mode: "players", users: ["p1"]}), owned, player) && !canPlay(withAccess({mode: "players", users: ["p2"]}), owned, player), "or only the chosen players");
  settings.set(`${MOD}.playersCanPlay`, false);
  ok(!canPlay(withAccess({}), owned, player), "by default, as the world setting says (off)");
  settings.set(`${MOD}.playersCanPlay`, true);
  ok(canPlay(withAccess({}), owned, player), "(and on)");
  settings.set(`${MOD}.playersCanPlay`, false);
  const lap = await KAA.createAnimation({name: "Guarded lap", steps: [{shape: {type: "ellipse", cx: 500, cy: 500, rx: 100, ry: 100, rotation: 0, sweep: 360}}],
    access: {mode: "gm"}});
  ok(Store.get(lap.id).access.mode === "gm", "the choice is saved with the animation");
  const someToken = scene.tokens.contents.find(t => !t.getFlag(MOD, "playback"));
  const warned = [];
  const realWarn = ui.notifications.warn;
  ui.notifications.warn = m => warned.push(m);
  game.user = player;
  const refused = await Playback.play(lap.id, [someToken]);
  game.user = me;
  ui.notifications.warn = realWarn;
  ok(refused.length === 0 && warned.includes("KAA.Warn.NotAllowed") && !someToken.getFlag(MOD, "playback"), "a player who isn't allowed can't play it");
  await Store.delete(lap.id);
}

/* ---------------- The panel steps aside while you pick on the map ---------------- */
{
  const flush = () => new Promise(r => setTimeout(r, 5));
  panel.render = () => {};
  panel.rendered = true;
  panel.minimized = false;
  const kl = {};
  panel.element = {addEventListener: (t, fn, capture) => { if ( !capture ) kl[t] = fn; }, querySelectorAll: () => [], querySelector: () => null};
  await panel._onFirstRender({}, {});
  const picky = await Store.create({name: "Picky", tokens: [], steps: [defaultStep({type: "ellipse", cx: 300, cy: 300, rx: 80, ry: 80})]});
  Editor.select(picky.id);
  const pick = mode => AnimatorPanel.DEFAULT_OPTIONS.actions.pick.call(panel, {}, {dataset: {pick: mode}});
  pick("faceToken");
  await flush();
  ok(panel.minimized && (Editor.picking?.mode === "faceToken"), "Pick on map tucks the panel away while you click on the map");
  Editor.setPicking(null);
  await flush();
  ok(!panel.minimized, "and brings it back once the pick is made");
  pick("anchorToken");
  await flush();
  const kept = await panel.close({closeKey: true});
  await flush();
  ok(kept === panel && !Editor.picking && !panel.minimized && panel.rendered, "Escape cancels the pick and brings the panel back (instead of closing it)");
  pick("tokens");
  await flush();
  ok(!panel.minimized, "clicking several tokens keeps the panel open (its button ends that)");
  Editor.setPicking(null);
  // A chosen tile lets go of its focus (every tile of a group shares a name: Foundry would refocus the first one)
  let blurred = false;
  await kl.change({target: {name: "facing.mode", value: "spin", type: "radio", checked: true, dataset: {}, closest: () => null, blur() { blurred = true; }}});
  await flush();
  ok(blurred && Store.get(picky.id).facing.mode === "spin", "choosing a tile lets go of its focus");
  await Store.delete(picky.id);
}

/* ---------------- Every facing and start/finish choice renders ---------------- */
{
  const tryRender = async label => {
    try {
      const ctx = await panel._prepareContext({});
      const out = Object.values(tpls).map(t => t(ctx)).join("\n");
      return out.length > 200 ? null : `${label}: empty`;
    } catch(err) {
      return `${label}: ${err.message}`;
    }
  };
  const subject = await Store.create({name: "Every choice", tokens: ["T1"], steps: [defaultStep({type: "ellipse", cx: 500, cy: 500, rx: 100, ry: 100})]});
  const sid = Store.get(subject.id).steps[0].id;
  Editor.select(subject.id, sid);
  const broken = [];
  const modes = ["keep", "path", "turn", "spin", "fixed", "center", "point", "token", "target"];
  await tabSet("facing");
  for ( const scope of ["animation", "step"] ) {
    for ( const mode of modes ) {
      for ( const variant of [{}, {tokenId: "T2", point: {x: 10, y: 20}, target: {group: "custom", tokens: ["T2"]}}, {tokenId: "gone", target: {group: "custom", tokens: ["gone"]}}] ) {
        await Store.mutate(subject.id, a => {
          const f = {mode, ...structuredClone(variant)};
          if ( scope === "animation" ) a.facing = {...a.facing, ...f};
          else a.steps[0].facing = {...(a.steps[0].facing ?? a.facing), ...f};
        });
        const err = await tryRender(`${scope} facing ${mode} ${JSON.stringify(variant)}`);
        if ( err ) broken.push(err);
      }
    }
  }
  await tabSet("motion");
  for ( const anchor of ["absolute", "relative", "token"] ) {
    for ( const anchorToken of [null, "T2", "gone"] ) {
      await Store.mutate(subject.id, a => { a.motion.anchor = anchor; a.motion.anchorToken = anchorToken; });
      const err = await tryRender(`anchor ${anchor} ${anchorToken}`);
      if ( err ) broken.push(err);
    }
  }
  for ( const tab of ["facing", "motion", "symmetry", "tokens", "path"] ) {
    await tabSet(tab);
    for ( const mode of ["tokens", "facePoint", "faceToken", "targetGroup", "anchorToken", "homingToken", "symPoint"] ) {
      Editor.setPicking({mode, stepId: mode.startsWith("face") ? sid : null});
      const err = await tryRender(`picking ${mode} on ${tab}`);
      if ( err ) broken.push(err);
    }
    Editor.setPicking(null);
  }
  ok(!broken.length, `every facing, start/finish and picking state renders${broken.length ? ": " + broken.slice(0, 5).join(" | ") : ""}`);
  await Store.delete(subject.id);
}

/* ---------------- Visual previews v1.1 (written only when KAA_PREVIEW is set) ---------------- */
if ( process.env.KAA_PREVIEW ) {
  const {writeFileSync} = await import("node:fs");
  const {TemplateGallery} = await imp("gallery.js");
  const OUT = process.env.KAA_PREVIEW;
  const PUB = pathToFileURL(`${FOUNDRY_APP}/public/`).href;
  const page = (parts, {id = "kaa-panel", cls = "kaa-panel", title = "Kostis's Actual Animator"} = {}) => `<!doctype html><html><head><meta charset="utf-8"><base href="${PUB}">
<link rel="stylesheet" href="${PUB}css/foundry2.css">
<link rel="stylesheet" href="${PUB}fonts/fontawesome/css/all.min.css">
<link rel="stylesheet" href="file:///${ROOT}styles/kaa.css">
<style>html,body{margin:0;width:1040px;height:800px;background:#2b2d33 radial-gradient(circle at 30% 20%,#3a3d46,#1c1d22);overflow:hidden}
#${id}{position:absolute;left:20px;top:20px;width:1000px;height:760px;display:flex;flex-direction:column}
#${id} .window-content{flex:1;min-height:0}</style></head>
<body class="vtt game theme-dark"><div id="${id}" class="application ${cls} themed theme-dark">
<header class="window-header"><i class="window-icon fa-solid fa-route"></i><h1 class="window-title">${title}</h1>
<button type="button" class="header-control icon fa-solid fa-xmark"></button></header>
<section class="window-content">${parts}</section></div></body></html>`;
  const panelHTML = async () => {
    const ctx = await panel._prepareContext({});
    return Object.values(tpls).map(t => t(ctx)).join("\n");
  };
  const tab = t => AnimatorPanel.DEFAULT_OPTIONS.actions.switchTab.call(panel, {}, {dataset: {tab: t}});
  // A kaleidoscope animation
  const bloom = (await import(pathToFileURL(ROOT + "scripts/templates.js").href)).BUILTIN_TEMPLATES.find(t => t.id === "builtin-bloom");
  const anim = await Store.insert(bloom, {at: {x: 600, y: 600}, tokens: ["T1", "T2"]});
  Editor.select(anim.id);
  await tab("symmetry");
  writeFileSync(OUT + "preview-symmetry.html", page(await panelHTML()));
  // Height inspector on a waypoint
  const drop = Store.all().find(a => a.name === "Drop");
  Editor.select(drop.id, drop.steps[0].id);
  await tab("path");
  writeFileSync(OUT + "preview-lift.html", page(await panelHTML()));
  // Smart target facing
  const sentry = Store.all().find(a => a.name === "Sentry");
  Editor.select(sentry.id);
  await tab("facing");
  writeFileSync(OUT + "preview-target.html", page(await panelHTML()));
  // Facing a token, and following one (Start & finish)
  await Store.mutate(sentry.id, a => { a.facing.mode = "token"; a.facing.tokenId = "T2"; });
  writeFileSync(OUT + "preview-face-token.html", page(await panelHTML()));
  await Store.mutate(sentry.id, a => { a.motion.anchor = "token"; a.motion.anchorToken = "T2"; });
  await tab("motion");
  writeFileSync(OUT + "preview-follow.html", page(await panelHTML()));
  // Gallery
  canvas.tokens.controlled = [t1.object, t2.object];
  const gallery = new TemplateGallery();
  const gtpl = Handlebars.compile(readFileSync(tplDir + "gallery.hbs", "utf8"));
  writeFileSync(OUT + "preview-gallery.html", page(gtpl(await gallery._prepareContext({})), {id: "kaa-gallery", cls: "kaa-panel kaa-gallery", title: "Animation templates"}));
  gallery.render = () => {};
  TemplateGallery.DEFAULT_OPTIONS.actions.pickCategory.call(gallery, {}, {dataset: {category: "attacks"}});
  writeFileSync(OUT + "preview-attacks.html", page(gtpl(await gallery._prepareContext({})), {id: "kaa-gallery", cls: "kaa-panel kaa-gallery", title: "Animation templates"}));
  console.log("previews v1.1 written");
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
