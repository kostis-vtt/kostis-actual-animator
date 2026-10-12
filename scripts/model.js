// Animation data model and persistence (scene flags + world library).

import {FLAG_ANIMS, MODULE_ID, PALETTE} from "./const.js";
import {normalizeShape, transformShape, translateShape} from "./shapes.js";
import {stepEndpoints} from "./timeline.js";

/* -------------------------------------------- */
/*  Operators                                   */
/* -------------------------------------------- */

const DEL = () => globalThis._del ?? new foundry.data.operators.ForcedDeletion();
const REPLACE = v => (globalThis._replace ? globalThis._replace(v) : foundry.data.operators.ForcedReplacement.create(v));
export {DEL, REPLACE};

/* -------------------------------------------- */
/*  Defaults                                    */
/* -------------------------------------------- */

export const newId = () => foundry.utils.randomID(16);

export function defaultMotion() {
  return {
    speed: 4,
    speedUnit: "grid",
    easeIn: 0,
    easeOut: 0,
    loop: "none",
    loopCount: 0,
    loopGap: 0,
    loopConnector: "travel",
    approach: "travel",
    anchor: "absolute",
    anchorToken: "target",
    finish: "stay"
  };
}

export function defaultFacing() {
  return {
    mode: "keep",
    art: "down",
    offset: 0,
    smoothing: 40,
    angle: 0,
    spinSpeed: 90,
    point: null,
    tokenId: null,
    reverse: false,
    swayAmp: 0,
    swayFreq: 0.5,
    turnRate: 0,
    target: {rule: "nearest", group: "enemies", tokens: [], range: 0}
  };
}

/** Vertical motion of a step (heights in grid squares). */
export function defaultLift() {
  return {mode: "none", height: 1, count: 4, decay: 0.5, freq: 0.5};
}

/** Symmetry / kaleidoscope copies. */
export function defaultSymmetry() {
  return {count: 1, mode: "rotate", center: "origin", point: null, axis: 0, link: "independent", keep: false};
}

/** How height is shown. */
export function defaultHeightFx() {
  return {scale: 0.25, rise: 0.35, shadow: true, elevation: true};
}

export function defaultStep(shape, extra={}) {
  return {
    id: newId(),
    label: "",
    shape: normalizeShape(shape),
    enabled: true,
    reverse: false,
    startOffset: 0,
    laps: 1,
    speedMul: 1,
    wait: 0,
    connector: "travel",
    facing: null,
    lift: defaultLift(),
    ...extra
  };
}

export function defaultAnimation(data={}) {
  return normalizeAnimation({
    id: newId(),
    name: "New animation",
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    ...data
  });
}

/* -------------------------------------------- */
/*  Normalisation                               */
/* -------------------------------------------- */

const num = (v, d) => (Number.isFinite(Number(v)) && (v !== null) && (v !== "") ? Number(v) : d);
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);

export function normalizeFacing(f, fallback=defaultFacing()) {
  f = {...fallback, ...(f ?? {})};
  return {
    mode: pick(f.mode, ["keep", "path", "turn", "spin", "fixed", "center", "point", "token", "target"], "keep"),
    art: pick(f.art, ["down", "up", "left", "right"], "down"),
    offset: num(f.offset, 0),
    smoothing: Math.max(0, num(f.smoothing, 40)),
    angle: num(f.angle, 0),
    spinSpeed: num(f.spinSpeed, 90),
    point: f.point && Number.isFinite(Number(f.point.x)) ? {x: Number(f.point.x), y: Number(f.point.y)} : null,
    tokenId: f.tokenId || null,
    reverse: !!f.reverse,
    swayAmp: num(f.swayAmp, 0),
    swayFreq: Math.max(0, num(f.swayFreq, 0.5)),
    turnRate: Math.max(0, num(f.turnRate, 0)),
    target: {
      rule: pick(f.target?.rule, ["nearest", "farthest", "mostDamaged", "leastDamaged"], "nearest"),
      group: pick(f.target?.group, ["enemies", "allies", "players", "all", "custom"], "enemies"),
      tokens: Array.from(new Set((f.target?.tokens ?? []).filter(t => typeof t === "string"))),
      range: Math.max(0, num(f.target?.range, 0))
    }
  };
}

export function normalizeLift(l) {
  l = {...defaultLift(), ...(l ?? {})};
  return {
    mode: pick(l.mode, ["none", "arc", "hops", "bounce", "skip", "bob"], "none"),
    height: Math.max(0, num(l.height, 1)),
    count: Math.min(50, Math.max(1, Math.round(num(l.count, 4)))),
    decay: Math.min(0.95, Math.max(0.05, num(l.decay, 0.5))),
    freq: Math.max(0.01, num(l.freq, 0.5))
  };
}

export function normalizeStep(s) {
  const d = defaultStep(s.shape ?? {type: "point", x: 0, y: 0});
  return {
    id: s.id || d.id,
    label: String(s.label ?? ""),
    shape: normalizeShape(s.shape ?? d.shape),
    enabled: s.enabled !== false,
    reverse: !!s.reverse,
    startOffset: Math.min(1, Math.max(0, num(s.startOffset, 0))),
    laps: Math.max(0.01, num(s.laps, 1)),
    speedMul: Math.max(0.01, num(s.speedMul, 1)),
    wait: Math.max(0, num(s.wait, 0)),
    connector: pick(s.connector, ["travel", "teleport"], "travel"),
    facing: s.facing ? normalizeFacing(s.facing) : null,
    lift: normalizeLift(s.lift)
  };
}

/** Who may play an animation (the GM always may; players only ever on tokens they own). */
export const ACCESS_MODES = {
  setting: "Players who own the token, if the world setting allows it",
  owners: "Anyone who owns the token",
  players: "Only the players chosen here (on tokens they own)",
  gm: "Only the GM"
};

export function normalizeAccess(a) {
  return {
    mode: pick(a?.mode, Object.keys(ACCESS_MODES), "setting"),
    users: Array.from(new Set((Array.isArray(a?.users) ? a.users : []).filter(u => (typeof u === "string") && u)))
  };
}

/**
 * May a user play an animation on a token?
 * @param {object} anim
 * @param {TokenDocument} doc
 * @param {User} [user]
 */
export function canPlay(anim, doc, user=game.user) {
  if ( user?.isGM ) return true;
  if ( !user || !doc?.testUserPermission?.(user, "OWNER") ) return false;
  const access = normalizeAccess(anim?.access);
  switch ( access.mode ) {
    case "gm": return false;
    case "owners": return true;
    case "players": return access.users.includes(user.id);
    default: return !!game.settings.get(MODULE_ID, "playersCanPlay");
  }
}

export function normalizeAnimation(a) {
  const m = {...defaultMotion(), ...(a.motion ?? {})};
  return {
    id: a.id || newId(),
    name: String(a.name ?? "Animation").slice(0, 120) || "Animation",
    color: /^#[0-9a-f]{6}$/i.test(a.color ?? "") ? a.color : PALETTE[0],
    folder: String(a.folder ?? ""),
    sort: num(a.sort, 0),
    rev: num(a.rev, 0),
    steps: (a.steps ?? []).map(normalizeStep),
    motion: {
      speed: Math.max(0.01, num(m.speed, 4)),
      speedUnit: pick(m.speedUnit, ["grid", "units", "px"], "grid"),
      easeIn: Math.max(0, num(m.easeIn, 0)),
      easeOut: Math.max(0, num(m.easeOut, 0)),
      loop: pick(m.loop, ["none", "loop", "pingpong"], "none"),
      loopCount: Math.max(0, Math.round(num(m.loopCount, 0))),
      loopGap: Math.max(0, num(m.loopGap, 0)),
      loopConnector: pick(m.loopConnector, ["travel", "teleport"], "travel"),
      approach: pick(m.approach, ["travel", "teleport"], "travel"),
      anchor: pick(m.anchor, ["absolute", "relative", "token"], "absolute"),
      anchorToken: typeof m.anchorToken === "string" && m.anchorToken ? m.anchorToken : "target",
      finish: pick(m.finish, ["stay", "return", "teleport"], "stay")
    },
    facing: normalizeFacing(a.facing),
    tokens: Array.from(new Set((a.tokens ?? []).filter(t => typeof t === "string"))),
    stagger: {
      mode: pick(a.stagger?.mode, ["none", "delay", "spread"], "none"),
      delay: Math.max(0, num(a.stagger?.delay, 500))
    },
    symmetry: normalizeSymmetry(a.symmetry),
    height: normalizeHeightFx(a.height),
    templateId: typeof a.templateId === "string" ? a.templateId : null,
    access: normalizeAccess(a.access),
    created: num(a.created, Date.now())
  };
}

export function normalizeSymmetry(y) {
  y = {...defaultSymmetry(), ...(y ?? {})};
  return {
    count: Math.min(50, Math.max(1, Math.round(num(y.count, 1)))),
    mode: pick(y.mode, ["rotate", "mirror"], "rotate"),
    center: pick(y.center, ["origin", "path", "point"], "origin"),
    point: y.point && Number.isFinite(Number(y.point.x)) ? {x: Number(y.point.x), y: Number(y.point.y)} : null,
    axis: num(y.axis, 0),
    link: pick(y.link, ["independent", "linked"], "independent"),
    keep: !!y.keep
  };
}

export function normalizeHeightFx(h) {
  h = {...defaultHeightFx(), ...(h ?? {})};
  return {
    scale: Math.min(2, Math.max(0, num(h.scale, 0.25))),
    rise: Math.min(2, Math.max(0, num(h.rise, 0.35))),
    shadow: h.shadow !== false,
    elevation: h.elevation !== false
  };
}

/** Steps with fixed geometry (everything but homing legs, which are aimed at play time). */
export const isGeometric = step => step?.shape?.type !== "homing";

/** The first enabled step that has fixed geometry. */
export function firstGeometricStep(anim) {
  return anim.steps.find(s => (s.enabled !== false) && isGeometric(s)) ?? null;
}

/** Does playing this animation need targeted tokens (homing at a target, or following "the first target")? */
export function needsTargets(anim) {
  const m = anim.motion ?? {};
  return (anim.steps ?? []).some(s => (s.enabled !== false) && (s.shape?.type === "homing") && ((s.shape.to ?? "target") === "target"))
    || ((m.anchor === "token") && ((m.anchorToken ?? "target") === "target"));
}

/**
 * Split targeted tokens into the anchor token (for animations that follow a token) and the tokens homing legs
 * strike. The anchor is left out of the strikes whenever another target remains, so "target the ally to orbit
 * first, then the enemies" just works.
 * @param {object} anim
 * @param {Scene} scene
 * @param {TokenDocument[]} targets       In targeting order
 * @returns {{anchor: TokenDocument|null, strikes: TokenDocument[]}}
 */
export function aimTargets(anim, scene, targets) {
  let anchor = null;
  if ( anim.motion?.anchor === "token" ) {
    const id = anim.motion.anchorToken ?? "target";
    anchor = id === "target" ? (targets[0] ?? null) : (scene?.tokens.get(id) ?? null);
  }
  const rest = anchor ? targets.filter(d => d.id !== anchor.id) : targets;
  return {anchor, strikes: rest.length ? rest : targets};
}

/** Facing configuration in effect for a step (its override, or the animation's). */
export function facingFor(anim, stepIndex) {
  const step = anim.steps[stepIndex];
  return step?.facing ?? anim.facing;
}

/** Translate every step of an animation. */
export function translateAnimation(anim, dx, dy) {
  const a = foundry.utils.deepClone(anim);
  for ( const s of a.steps ) s.shape = translateShape(s.shape, dx, dy);
  const move = p => (p ? {x: p.x + dx, y: p.y + dy} : p);
  a.facing.point = move(a.facing.point);
  for ( const s of a.steps ) if ( s.facing ) s.facing.point = move(s.facing.point);
  if ( a.symmetry ) a.symmetry.point = move(a.symmetry.point);
  return a;
}

/**
 * Rotate and/or scale an animation (or only some of its steps) around a point.
 * @param {object} anim
 * @param {object} t
 * @param {number} [t.scale=1]
 * @param {number} [t.rotate=0]       Degrees
 * @param {{x:number,y:number}} t.about
 * @param {string[]} [t.stepIds]      Limit to these steps
 */
export function transformAnimation(anim, {scale=1, rotate=0, about, stepIds}={}) {
  const a = foundry.utils.deepClone(anim);
  const rad = rotate * Math.PI / 180;
  const P = p => {
    if ( !p ) return p;
    const dx = (p.x - about.x) * scale;
    const dy = (p.y - about.y) * scale;
    return {x: about.x + (dx * Math.cos(rad)) - (dy * Math.sin(rad)), y: about.y + (dx * Math.sin(rad)) + (dy * Math.cos(rad))};
  };
  for ( const s of a.steps ) {
    if ( stepIds && !stepIds.includes(s.id) ) continue;
    s.shape = transformShape(s.shape, {scale, rotate, about});
    if ( s.lift ) s.lift.height *= scale;
    if ( s.facing ) {
      s.facing.point = P(s.facing.point);
      s.facing.smoothing *= scale;
    }
  }
  if ( !stepIds ) {
    a.facing.point = P(a.facing.point);
    a.facing.smoothing *= scale;
    a.symmetry.point = P(a.symmetry.point);
  }
  return a;
}

/** Convert an animation to grid units (templates are stored scale-free so they fit any scene). */
export function toTemplate(anim, gridSize, extra={}) {
  const a = transformAnimation(anim, {scale: 1 / gridSize, about: {x: 0, y: 0}});
  // Heights are already in squares; undo the scaling applied to them
  for ( const s of a.steps ) s.lift.height = anim.steps.find(x => x.id === s.id)?.lift.height ?? s.lift.height;
  if ( a.motion.speedUnit === "px" ) {
    a.motion.speed /= gridSize;
    a.motion.speedUnit = "grid";
  }
  if ( (a.motion.anchor === "token") && (a.motion.anchorToken !== "target") ) a.motion.anchorToken = "target";
  return {...a, tokens: [], rev: 0, unit: "grid", ...extra};
}

/** Convert a grid-unit template into scene pixels. */
export function fromTemplate(tpl, gridSize) {
  if ( tpl.unit !== "grid" ) return normalizeAnimation(tpl);
  const a = normalizeAnimation(tpl);
  const scaled = transformAnimation(a, {scale: gridSize, about: {x: 0, y: 0}});
  for ( const s of scaled.steps ) s.lift.height = a.steps.find(x => x.id === s.id)?.lift.height ?? s.lift.height;
  return scaled;
}

/* -------------------------------------------- */
/*  Store                                       */
/* -------------------------------------------- */

const UNDO_LIMIT = 60;

/** Animations whose edit history is kept (the most recently changed ones: casts and patrols make and delete many). */
const UNDO_ANIMATIONS = 50;

/**
 * Scene-scoped animation storage. Animations live in scene flags so every client sees edits instantly,
 * and running animations update live when their paths are edited.
 */
export class Store {
  /** @type {Map<string, object[]>} animation id -> stack of previous versions */
  static #undo = new Map();

  /** Locally-pending versions (written but not yet echoed back by the server). */
  static #pending = new Map();

  static scene(scene) {
    if ( scene instanceof foundry.abstract.Document ) return scene;
    if ( typeof scene === "string" ) return game.scenes.get(scene);
    return canvas?.scene ?? null;
  }

  /** Raw map of animations on a scene. */
  static raw(scene) {
    scene = this.scene(scene);
    return scene?.flags?.[MODULE_ID]?.[FLAG_ANIMS] ?? {};
  }

  /**
   * Normalised animations keyed by their raw flag object. Flag objects are replaced whenever the scene updates,
   * so identity is a free and exact cache key. Normalised results are shared: never mutate them, clone first.
   * @type {WeakMap<object, object>}
   */
  static #normalized = new WeakMap();

  /** Drop cached normalisations (called whenever animation flags change, in case data was mutated in place). */
  static invalidate() {
    this.#normalized = new WeakMap();
  }

  static #norm(data, id) {
    let a = this.#normalized.get(data);
    if ( !a ) {
      a = normalizeAnimation({...data, id});
      this.#normalized.set(data, a);
    }
    return a;
  }

  /** All animations of a scene, normalised and sorted. */
  static all(scene) {
    scene = this.scene(scene);
    if ( !scene ) return [];
    const out = [];
    for ( const [id, data] of Object.entries(this.raw(scene)) ) {
      if ( !data || (typeof data !== "object") ) continue;
      out.push(this.#withPending(scene, this.#norm(data, id)));
    }
    out.sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
    return out;
  }

  static get(id, scene) {
    scene = this.scene(scene);
    const data = this.raw(scene)[id];
    if ( !data || (typeof data !== "object") ) return null;
    return this.#withPending(scene, this.#norm(data, id));
  }

  static #withPending(scene, anim) {
    const p = this.#pending.get(`${scene.id}.${anim.id}`);
    return p && (p.rev > anim.rev) ? p : anim;
  }

  static canEdit(scene) {
    scene = this.scene(scene);
    return !!scene?.canUserModify(game.user, "update");
  }

  /**
   * Persist an animation (full replace).
   * @param {object} anim
   * @param {object} [options]
   * @param {Scene} [options.scene]
   * @param {boolean} [options.undo=true]   Record the previous version for undo
   */
  static async save(anim, {scene, undo=true}={}) {
    scene = this.scene(scene);
    if ( !scene ) return null;
    if ( !this.canEdit(scene) ) {
      ui.notifications.warn("KAA.Warn.NoPermission", {localize: true});
      return null;
    }
    const prior = this.get(anim.id, scene);
    if ( undo && prior ) this.#pushUndo(prior);
    const next = normalizeAnimation({...anim, rev: Math.max(anim.rev ?? 0, prior?.rev ?? 0) + 1});
    // Deleted tokens never linger in an animation (an undo of an older version could otherwise bring them back)
    next.tokens = next.tokens.filter(id => scene.tokens.has(id));
    const key = `${scene.id}.${next.id}`;
    this.#pending.set(key, next);
    try {
      await scene.update({flags: {[MODULE_ID]: {[FLAG_ANIMS]: {[next.id]: REPLACE(next)}}}});
    } finally {
      if ( this.#pending.get(key) === next ) this.#pending.delete(key);
    }
    return next;
  }

  /** Apply a mutation to a stored animation and save it. */
  static async mutate(id, fn, {scene, undo=true}={}) {
    const anim = this.get(id, scene);
    if ( !anim ) return null;
    const copy = foundry.utils.deepClone(anim);
    const result = fn(copy);
    return this.save(result ?? copy, {scene, undo});
  }

  static async create(data={}, {scene}={}) {
    scene = this.scene(scene);
    const all = this.all(scene);
    const anim = defaultAnimation({sort: (all.at(-1)?.sort ?? 0) + 10, ...data});
    if ( !data.name ) anim.name = `Animation ${all.length + 1}`;
    return this.save(anim, {scene, undo: false});
  }

  static async duplicate(id, {scene}={}) {
    const src = this.get(id, scene);
    if ( !src ) return null;
    const copy = foundry.utils.deepClone(src);
    copy.id = newId();
    copy.name = `${src.name} (copy)`;
    copy.rev = 0;
    copy.tokens = [];
    copy.sort = src.sort + 1;
    for ( const s of copy.steps ) s.id = newId();
    return this.save(copy, {scene, undo: false});
  }

  /** Remove a deleted token from every animation of a scene. */
  static async forgetToken(scene, tokenId) {
    for ( const anim of this.all(scene) ) {
      if ( !anim.tokens.includes(tokenId) ) continue;
      await this.save({...anim, tokens: anim.tokens.filter(t => t !== tokenId)}, {scene, undo: false});
    }
  }

  static async delete(id, {scene}={}) {
    scene = this.scene(scene);
    if ( !scene || !this.canEdit(scene) ) return;
    const prior = this.get(id, scene);
    if ( prior ) this.#pushUndo(prior);
    await scene.update({flags: {[MODULE_ID]: {[FLAG_ANIMS]: {[id]: DEL()}}}});
  }

  static #pushUndo(anim) {
    const stack = this.#undo.get(anim.id) ?? [];
    stack.push(foundry.utils.deepClone(anim));
    if ( stack.length > UNDO_LIMIT ) stack.shift();
    // Most recent last (a Map keeps insertion order): drop the histories of animations not touched for longest
    this.#undo.delete(anim.id);
    this.#undo.set(anim.id, stack);
    while ( this.#undo.size > UNDO_ANIMATIONS ) this.#undo.delete(this.#undo.keys().next().value);
  }

  static canUndo(id) {
    return !!this.#undo.get(id)?.length;
  }

  /** Restore the previous version of an animation. */
  static async undo(id, {scene}={}) {
    const stack = this.#undo.get(id);
    const prev = stack?.pop();
    if ( !prev ) return null;
    const current = this.get(id, scene);
    prev.rev = (current?.rev ?? prev.rev) + 1;
    return this.save(prev, {scene, undo: false});
  }

  /* -------------------------------------------- */
  /*  Library (world-level templates)             */
  /* -------------------------------------------- */

  /** User templates: raw entries keep their metadata (unit, category, description). */
  static library() {
    const lib = game.settings.get(MODULE_ID, "library") ?? {};
    return Object.values(lib).map(t => ({...normalizeAnimation(t), unit: t.unit, category: t.category ?? "mine",
      description: t.description ?? ""})).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Save an animation as a reusable template (stored in grid units).
   * @param {object} anim
   * @param {object} [meta]   {name, category, description}
   */
  static async saveToLibrary(anim, meta={}, {scene}={}) {
    scene = this.scene(scene);
    const lib = foundry.utils.deepClone(game.settings.get(MODULE_ID, "library") ?? {});
    const gridSize = scene?.dimensions?.size ?? 100;
    const tpl = toTemplate(normalizeAnimation(foundry.utils.deepClone(anim)), gridSize, {
      name: meta.name || anim.name,
      category: meta.category || "mine",
      description: meta.description ?? "",
      anchorOrigin: anchorOriginOf(anim, scene, gridSize)
    });
    tpl.id = newId();
    tpl.templateId = null;
    lib[tpl.id] = tpl;
    await game.settings.set(MODULE_ID, "library", lib);
    return tpl;
  }

  /** Overwrite a saved template with the current state of an animation (keeps its name, category and description). */
  static async updateTemplate(id, anim, {scene}={}) {
    scene = this.scene(scene);
    const lib = foundry.utils.deepClone(game.settings.get(MODULE_ID, "library") ?? {});
    const old = lib[id];
    if ( !old ) return null;
    const gridSize = scene?.dimensions?.size ?? 100;
    const tpl = toTemplate(normalizeAnimation(foundry.utils.deepClone(anim)), gridSize, {
      name: old.name, category: old.category ?? "mine", description: old.description ?? "",
      anchorOrigin: anchorOriginOf(anim, scene, gridSize)
    });
    tpl.id = id;
    tpl.templateId = null;
    lib[id] = tpl;
    await game.settings.set(MODULE_ID, "library", lib);
    return tpl;
  }

  static async deleteFromLibrary(id) {
    const lib = foundry.utils.deepClone(game.settings.get(MODULE_ID, "library") ?? {});
    delete lib[id];
    await game.settings.set(MODULE_ID, "library", lib);
  }

  /**
   * Insert a library template (or imported data) into a scene.
   * @param {object} data
   * @param {object} [options]
   * @param {{x:number,y:number}} [options.at]   Re-centre the paths on this point
   */
  static async insert(data, {scene, at, tokens=[], link=false}={}) {
    scene = this.scene(scene);
    const scaled = data.unit === "grid" ? fromTemplate(data, scene?.dimensions?.size ?? 100) : data;
    let anim = normalizeAnimation({...foundry.utils.deepClone(scaled), tokens, rev: 0, templateId: link ? data.id : null});
    anim.id = newId();
    for ( const s of anim.steps ) s.id = newId();
    if ( at ) {
      // Relative animations are anchored at their start; ones that follow a token are placed around it (`at` is
      // then the token's centre); absolute ones are centred on the point
      const relative = anim.motion.anchor === "relative";
      const first = firstGeometricStep(anim);
      let ref = (relative && first ? stepEndpoints(first).start : null) ?? animationCenter(anim);
      if ( (anim.motion.anchor === "token") && data.anchorOrigin ) {
        const k = data.unit === "grid" ? (scene?.dimensions?.size ?? 100) : 1;
        ref = {x: data.anchorOrigin.x * k, y: data.anchorOrigin.y * k};
      }
      if ( ref ) anim = translateAnimation(anim, at.x - ref.x, at.y - ref.y);
    }
    const all = this.all(scene);
    anim.sort = (all.at(-1)?.sort ?? 0) + 10;
    return this.save(anim, {scene, undo: false});
  }
}

/** Where the followed token stands relative to an animation's drawing, in grid units (templates only). */
function anchorOriginOf(anim, scene, gridSize) {
  if ( anim.motion?.anchor !== "token" ) return null;
  const doc = anim.motion.anchorToken !== "target" ? scene?.tokens.get(anim.motion.anchorToken) : null;
  let p = null;
  if ( doc ) {
    const w = (doc.width ?? 1) * gridSize;
    const h = (doc.height ?? 1) * gridSize;
    p = {x: doc._source.x + (w / 2), y: doc._source.y + (h / 2)};
  }
  p ??= animationCenter(anim);
  return p ? {x: p.x / gridSize, y: p.y / gridSize} : null;
}

/**
 * The centre symmetry copies turn around, in scene space, for a token starting at `origin`.
 * @param {object} anim
 * @param {{x:number,y:number}} origin        The token's start centre
 * @param {{x:number,y:number}} [offset]      Relative-anchor translation of the timeline
 */
export function symmetryCenterFor(anim, origin, offset={x: 0, y: 0}) {
  const s = anim.symmetry;
  if ( s.center === "path" ) {
    const c = animationCenter(anim);
    if ( c ) return {x: c.x + offset.x, y: c.y + offset.y};
  }
  if ( (s.center === "point") && s.point ) {
    const rel = anim.motion.anchor === "relative";
    return {x: s.point.x + (rel ? offset.x : 0), y: s.point.y + (rel ? offset.y : 0)};
  }
  return {x: origin.x, y: origin.y};
}

/** Rough centre of all shapes of an animation. */
export function animationCenter(anim) {
  const pts = [];
  for ( const s of anim.steps ) {
    const sh = s.shape;
    if ( sh.type === "homing" ) continue;
    if ( sh.type === "path" ) pts.push(...sh.nodes);
    else if ( sh.type === "point" ) pts.push({x: sh.x, y: sh.y});
    else if ( sh.type === "wave" ) pts.push({x: sh.x0, y: sh.y0}, {x: sh.x1, y: sh.y1});
    else pts.push({x: sh.cx, y: sh.cy});
  }
  if ( !pts.length ) return null;
  return {x: pts.reduce((t, p) => t + p.x, 0) / pts.length, y: pts.reduce((t, p) => t + p.y, 0) / pts.length};
}
