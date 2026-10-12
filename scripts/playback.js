// Playback control. A token's playback is stored in a token flag; every client derives the exact pose from it.
// Only the "authority" client writes the final resting position back to the database.

import {FLAG_PLAYBACK, MODULE_ID, OPT_KEY} from "./const.js";
import {facingFor, DEL, REPLACE, aimTargets, canPlay, needsTargets, newId, Store, symmetryCenterFor} from "./model.js";
import {compileTimeline, copyArc, homingCurve} from "./timeline.js";
import {artOffset, facingRotation} from "./facing.js";
import {liftHeight} from "./lift.js";
import {copyTransform, transformDirection, transformPoint, transformRotation} from "./symmetry.js";

/** Token flag marking a symmetry copy: {source, gid, index} */
export const FLAG_COPY = "copy";

/** Estimated server time in ms (identical across clients up to latency). */
export const serverNow = () => game.time.serverTime;

/** Playback time (ms along the timeline) at server time `now`. */
export function tauAt(pb, now=serverNow()) {
  if ( pb.paused ) return pb.tau0;
  return pb.tau0 + ((now - pb.t0) * pb.rate);
}

/* -------------------------------------------- */
/*  Token geometry helpers                      */
/* -------------------------------------------- */

/** Offset from a token's top-left corner to its centre, for its current size and shape. */
export function tokenPivot(doc) {
  const c = doc.getCenterPoint({x: 0, y: 0, elevation: 0});
  return {x: c.x, y: c.y};
}

/** Database (source) centre of a token. */
export function sourceCenter(doc) {
  const p = tokenPivot(doc);
  return {x: doc._source.x + p.x, y: doc._source.y + p.y};
}

/** Resolve tokens given as placeables, documents or ids. */
export function resolveTokens(tokens, scene) {
  scene = Store.scene(scene);
  const list = Array.isArray(tokens) || (tokens instanceof Set) ? Array.from(tokens) : [tokens];
  const out = [];
  for ( const t of list ) {
    let doc = null;
    if ( !t ) continue;
    if ( typeof t === "string" ) doc = scene?.tokens.get(t) ?? fromUuidSync(t);
    else if ( t instanceof foundry.canvas.placeables.Token ) doc = t.document;
    else if ( t.documentName === "Token" ) doc = t;
    if ( doc && !out.includes(doc) ) out.push(doc);
  }
  return out;
}

/** The playback group a token belongs to (its own playback id, or the group of the source it copies). */
function groupOf(doc) {
  return doc.getFlag(MODULE_ID, FLAG_PLAYBACK)?.gid ?? doc.getFlag(MODULE_ID, FLAG_COPY)?.gid ?? null;
}

/* -------------------------------------------- */
/*  Timelines                                   */
/* -------------------------------------------- */

const timelineCache = new Map();
const TIMELINE_CACHE_LIMIT = 300;

/**
 * Compile (or reuse) the timeline for a token's playback. The timeline only depends on the animation, the token's
 * size and the playback origin/offsets, so symmetry copies of one token share a single compiled timeline.
 */
export function timelineFor(doc, pb, anim) {
  const scene = doc.parent;
  const dims = {size: scene.dimensions.size, distance: scene.dimensions.distance || 1};
  const key = [scene.id, anim.id, anim.rev, doc.width, doc.height, doc.shape, dims.size, dims.distance,
    pb.ox, pb.oy, pb.delay, pb.phase, JSON.stringify(pb.targets ?? null), JSON.stringify(pb.anchor ?? null),
    JSON.stringify(pb.points ?? null)].join("|");
  let tl = timelineCache.get(key);
  if ( tl ) return tl;
  const pivot = tokenPivot(doc);
  const origin = {x: pb.ox + pivot.x, y: pb.oy + pivot.y};
  tl = compileTimeline(anim, {
    origin,
    dims,
    delay: pb.delay,
    phase: pb.phase,
    resolve: spec => snapshotPoint(spec, pb, origin)
  });
  if ( timelineCache.size >= TIMELINE_CACHE_LIMIT ) timelineCache.delete(timelineCache.keys().next().value);
  timelineCache.set(key, tl);
  return tl;
}

/** Where a homing leg was headed when playback started (fixes its duration identically on every client). */
function snapshotPoint(spec, pb, origin) {
  switch ( spec.to ) {
    case "target": {
      const list = pb.targets ?? [];
      return list.length ? list[spec.index % list.length] : null;
    }
    case "home": return origin;
    case "anchor": return pb.anchor ?? null;
    case "token": return pb.points?.[spec.tokenId] ?? null;
  }
  return null;
}

/** Live centre of a token (as currently displayed on this client). */
function liveCenter(scene, tokenId) {
  const doc = scene.tokens.get(tokenId);
  if ( !doc ) return null;
  const p = tokenPivot(doc);
  return {x: doc.x + p.x, y: doc.y + p.y};
}

/* -------------------------------------------- */
/*  Smart targeting                             */
/* -------------------------------------------- */

/** Fraction of bar 1 (usually hit points) remaining, or 1 when unknown. */
function healthFraction(doc) {
  try {
    const bar = doc.getBarAttribute?.("bar1");
    if ( (bar?.type === "bar") && (bar.max > 0) ) return Math.max(0, bar.value) / bar.max;
  } catch(err) {
    // Some systems throw for unusual bar configurations
  }
  return 1;
}

/** Is `other` part of the target group, from the point of view of `self`? */
function inGroup(self, other, target) {
  const D = CONST.TOKEN_DISPOSITIONS;
  switch ( target.group ) {
    case "enemies": {
      const s = self.disposition;
      if ( s === D.FRIENDLY ) return other.disposition === D.HOSTILE;
      if ( s === D.HOSTILE ) return other.disposition === D.FRIENDLY;
      return (other.disposition === D.HOSTILE) || (other.disposition === D.FRIENDLY);
    }
    case "allies":
      return other.disposition === self.disposition;
    case "players":
      return !!other.actor?.hasPlayerOwner;
    case "custom":
      return target.tokens.includes(other.id);
    default:
      return true;
  }
}

/**
 * Pick the token a "smart target" facing should look at.
 * @returns {{x:number,y:number}|null}   Its live centre
 */
export function selectTarget(doc, pb, facing, pos) {
  const target = facing.target;
  const scene = doc.parent;
  const range = target.range > 0 ? target.range * scene.dimensions.size : Infinity;
  const gid = pb.gid ?? null;
  let best = null;
  let bestScore = Infinity;
  for ( const other of scene.tokens ) {
    if ( (other === doc) || other.hidden ) continue;
    if ( gid && (groupOf(other) === gid) ) continue;
    if ( !inGroup(doc, other, target) ) continue;
    const c = liveCenter(scene, other.id);
    const d = Math.hypot(c.x - pos.x, c.y - pos.y);
    if ( d > range ) continue;
    let score;
    switch ( target.rule ) {
      case "farthest": score = -d; break;
      case "mostDamaged": score = (healthFraction(other) * 1e7) + d; break;
      case "leastDamaged": score = (-healthFraction(other) * 1e7) + d; break;
      default: score = d;
    }
    if ( score < bestScore ) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/* -------------------------------------------- */
/*  Pose                                        */
/* -------------------------------------------- */

/**
 * Sample the full pose of a playing token.
 * @returns {{x:number, y:number, rotation:number|undefined, z:number, sample:object, tau:number, tl:object}}
 *   x/y are the token's top-left position (fractional); z is the height above the ground in grid squares
 */
export function poseAt(doc, pb, anim, now=serverNow()) {
  const tl = timelineFor(doc, pb, anim);
  const tau = tauAt(pb, now);
  const scene = doc.parent;
  const pivot = tokenPivot(doc);
  const pose = composePose(tl, anim, tau, {
    sym: pb.sym,
    origin: {x: pb.ox + pivot.x, y: pb.oy + pivot.y},
    originRotation: pb.or,
    grid: scene.dimensions.size,
    center: id => liveCenter(scene, id),
    targetIds: (pb.targets ?? []).map(t => t.id),
    snapTargets: pb.targets ?? [],
    anchorStart: pb.anchor ?? null,
    points: pb.points ?? {},
    targetCenter: (f, pos) => selectTarget(doc, pb, f, pos)
  });
  return {...pose, x: pose.x - pivot.x, y: pose.y - pivot.y, tl};
}

/** Point and direction a fraction of the way along a freshly aimed homing curve. */
function homingAt(a, b, arc, frac, stop) {
  const lut = homingCurve(a, b, arc);
  const d = Math.max(0, lut.length - stop) * Math.min(1, Math.max(0, frac));
  const p = lut.pointAt(d);
  return {x: p.x, y: p.y, dir: lut.angleAt(d, 2)};
}

/**
 * Turn a timeline sample into a final pose: symmetry copies, live homing legs, following an anchor token, facing
 * and height. Shared by real playback and the editor's preview ghost so both always agree.
 * @param {Timeline} tl
 * @param {object} anim
 * @param {number} tau            Playback time (ms)
 * @param {object} env
 * @param {object} [env.sym]                       Symmetry copy descriptor
 * @param {{x:number,y:number}} env.origin         The token's start centre
 * @param {number} env.originRotation
 * @param {number} env.grid                        Grid size in px
 * @param {(id: string) => ({x,y}|null)} env.center   Live centre of a token
 * @param {string[]} env.targetIds                 Tokens that were targeted at play time
 * @param {{x,y}[]} [env.snapTargets]              Their centres at play time (fallback if they vanish)
 * @param {{id:string,x:number,y:number}|null} env.anchorStart   The anchor token and where it stood at play time
 * @param {object} [env.points]                    Specific tokens' centres at play time
 * @param {Function} [env.targetCenter]            Smart-target lookup for facing
 * @returns {{x:number, y:number, rotation:number|undefined, z:number, sample:object, tau:number, facing:object}}
 *   x/y are the token's centre
 */
export function composePose(tl, anim, tau, env) {
  const raw = tl.evaluate(tau);
  const t = copyTransform(env.sym);
  const copyIndex = env.sym?.i ?? 0;
  const copies = env.sym?.n ?? 1;

  // Following an anchor token: everything drawn around it moves with it (eased in over the approach)
  let delta = {x: 0, y: 0};
  if ( (anim.motion.anchor === "token") && env.anchorStart ) {
    const live = env.center(env.anchorStart.id) ?? env.anchorStart;
    let w = 1;
    if ( (raw.step === -1) && !raw.done && (tl.prefix.T > 0) ) w = Math.min(1, Math.max(0, tau / tl.prefix.T));
    delta = {x: (live.x - env.anchorStart.x) * w, y: (live.y - env.anchorStart.y) * w};
  }

  // Live destinations of homing legs; copies spread across the targets and curve to alternating sides
  const liveEnd = spec => {
    switch ( spec.to ) {
      case "target": {
        const ids = env.targetIds ?? [];
        if ( !ids.length ) return null;
        const k = (spec.index + copyIndex) % ids.length;
        return env.center(ids[k]) ?? env.snapTargets?.[k] ?? null;
      }
      case "home": return transformPoint(t, env.origin);
      case "anchor": return env.anchorStart ? (env.center(env.anchorStart.id) ?? env.anchorStart) : null;
      case "token": return env.center(spec.tokenId) ?? env.points?.[spec.tokenId] ?? null;
    }
    return null;
  };

  let sample;
  if ( raw.homing ) {
    const h = raw.homing;
    const stopPx = (h.spec.stop || 0) * (env.grid || 100);
    let a;
    if ( h.from.kind === "homing" ) {
      a = liveEnd(h.from.spec);
      // Chained legs start where the previous leg stopped short
      if ( a && h.from.spec.stop ) {
        const prevStart = transformPoint(t, {x: raw.x, y: raw.y});
        const L = Math.hypot(a.x - prevStart.x, a.y - prevStart.y) || 1;
        const back = Math.min(L, h.from.spec.stop * (env.grid || 100));
        a = {x: a.x - ((a.x - prevStart.x) / L * back), y: a.y - ((a.y - prevStart.y) / L * back)};
      }
    } else {
      const p = transformPoint(t, {x: h.from.x + tl.offset.x, y: h.from.y + tl.offset.y});
      a = {x: p.x + delta.x, y: p.y + delta.y};
    }
    const b = liveEnd(h.spec);
    if ( a && b ) {
      const arc = copyArc(h.spec.arc, copyIndex, copies);
      const q = homingAt(a, b, arc, h.frac, stopPx);
      sample = {...raw, x: q.x, y: q.y, dir: q.dir ?? raw.dir};
    }
  }
  if ( !sample ) {
    sample = t.identity ? {...raw} : {...raw, ...transformPoint(t, raw), dir: transformDirection(t, raw.dir)};
    sample.x += delta.x;
    sample.y += delta.y;
  }

  const facing = raw.step >= 0 ? facingFor(anim, raw.step) : anim.facing;
  const center0 = raw.step >= 0 ? tl.stepCenter(raw.step) : null;
  let center = center0 && !t.identity ? transformPoint(t, center0) : center0;
  if ( center ) center = {x: center.x + delta.x, y: center.y + delta.y};
  const rotation = facingRotation(facing, sample, {
    tau,
    originRotation: env.originRotation,
    center,
    offset: tl.offset,
    tokenCenter: env.center,
    targetCenter: env.targetCenter,
    rawDir: raw.homing ? sample.dir : raw.dir,
    startDir: tl.startDir,
    transform: raw.homing ? {identity: true} : t
  });
  const step = (raw.step >= 0) && !raw.done ? anim.steps[raw.step] : null;
  const z = step?.lift && (step.lift.mode !== "none") ? liftHeight(step.lift, raw.liftFrac, tau / 1000) : 0;
  return {x: sample.x, y: sample.y, rotation, z, sample, tau, facing};
}

/** Current pose of any token: its animated pose if playing, otherwise its database pose. */
function currentPose(doc) {
  const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
  const anim = pb ? Store.get(pb.anim, doc.parent) : null;
  if ( pb && anim ) {
    const pose = poseAt(doc, pb, anim);
    return {x: pose.x, y: pose.y, rotation: pose.rotation ?? doc._source.rotation};
  }
  return {x: doc._source.x, y: doc._source.y, rotation: doc._source.rotation};
}

/* -------------------------------------------- */
/*  Authority                                   */
/* -------------------------------------------- */

/** Is this client responsible for committing the final position of a token's playback? */
export function isAuthority(doc, pb) {
  const gm = game.users.activeGM;
  if ( gm ) return gm.isSelf;
  const by = game.users.get(pb?.by);
  if ( by?.active && doc.canUserModify(by, "update") ) return by.isSelf;
  const owners = game.users.filter(u => u.active && doc.canUserModify(u, "update")).sort((a, b) => a.id.localeCompare(b.id));
  return owners[0]?.isSelf ?? false;
}

/* -------------------------------------------- */
/*  Playback API                                */
/* -------------------------------------------- */

export class Playback {
  /** Uuids of every token (any scene) with an active playback. */
  static registry = new Set();

  /** Last pose drawn for each token on this client (token id → {x, y, rotation}). Kept by the Runner. */
  static lastPose = new Map();

  /** Playback ids for which a commit is in flight. */
  static #committing = new Set();

  static #interval = null;

  /** Serialises every operation that creates or removes symmetry copies, so they can never interleave. */
  static #queue = Promise.resolve();

  /** Run `fn` after every queued copy operation has finished. */
  static #serial(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(err => console.error(`${MODULE_ID} | Symmetry update failed`, err));
    return run;
  }

  static get lead() {
    return Math.max(0, Number(game.settings.get(MODULE_ID, "startLead")) || 0);
  }

  /** Scan all scenes for running playbacks and start the authority loop. */
  static initialize() {
    this.registry.clear();
    for ( const scene of game.scenes ) {
      for ( const t of scene.tokens ) if ( t.getFlag(MODULE_ID, FLAG_PLAYBACK) ) this.registry.add(t.uuid);
    }
    clearInterval(this.#interval);
    this.#interval = setInterval(() => this.#authorityTick(), 200);
  }

  static track(doc) {
    if ( doc.getFlag(MODULE_ID, FLAG_PLAYBACK) ) this.registry.add(doc.uuid);
    else this.registry.delete(doc.uuid);
  }

  static untrack(doc) {
    this.registry.delete(doc.uuid);
  }

  static #ticks = 0;

  /** Commit finished playbacks (and clean up orphaned ones) on the authority client. */
  static async #authorityTick() {
    if ( !game.ready ) return;
    if ( game.users.activeGM?.isSelf && ((++this.#ticks % 5) === 0) ) {
      await this.#serial(() => this.#sweep()).catch(() => {});
    }
    const now = serverNow();
    const finishing = new Map();
    for ( const uuid of this.registry ) {
      const doc = fromUuidSync(uuid);
      if ( !doc?.parent ) {
        this.registry.delete(uuid);
        continue;
      }
      const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
      if ( !pb ) {
        this.registry.delete(uuid);
        continue;
      }
      if ( this.#committing.has(pb.id) || !isAuthority(doc, pb) ) continue;
      const anim = Store.get(pb.anim, doc.parent);
      let mode = null;
      if ( !anim ) mode = "here";
      else if ( !pb.paused ) {
        const tl = timelineFor(doc, pb, anim);
        if ( !tl.infinite && (tauAt(pb, now) >= tl.duration) ) mode = "end";
      }
      if ( !mode ) continue;
      const list = finishing.get(doc.parent) ?? [];
      list.push({doc, mode});
      finishing.set(doc.parent, list);
    }
    for ( const [scene, list] of finishing ) {
      await this.#commit(scene, list).catch(err => console.error(`${MODULE_ID} | Failed to commit`, err));
    }
  }

  /**
   * Write final positions and clear playbacks. Symmetry copies are removed unless the animation keeps them.
   * @param {Scene} scene
   * @param {{doc: TokenDocument, mode: "here"|"origin"|"end"}[]} list
   */
  static async #commit(scene, list, {detach=false}={}) {
    const updates = [];
    const deletions = [];
    const movement = {};
    const ids = [];
    const now = serverNow();
    const canDelete = game.user.can("TOKEN_DELETE");
    for ( const {doc, mode} of list ) {
      const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
      if ( !pb || this.#committing.has(pb.id) || !scene.tokens.has(doc.id) ) continue;
      const anim = Store.get(pb.anim, scene);
      const copy = doc.getFlag(MODULE_ID, FLAG_COPY);
      ids.push(pb.id);
      if ( copy && !anim?.symmetry.keep && !detach ) {
        // Only users who may delete tokens remove copies; anyone else just stops them and the GM tidies up
        if ( canDelete ) deletions.push(doc.id);
        else updates.push({_id: doc.id, flags: {[MODULE_ID]: {[FLAG_PLAYBACK]: DEL()}}});
        continue;
      }
      let pose;
      if ( mode === "origin" || !anim ) {
        if ( mode === "origin" ) {
          // Copies return to their mirrored/rotated share of the origin
          const t = copyTransform(pb.sym);
          const pivot = tokenPivot(doc);
          const c = transformPoint(t, {x: pb.ox + pivot.x, y: pb.oy + pivot.y});
          pose = {x: c.x - pivot.x, y: c.y - pivot.y, rotation: transformRotation(t, pb.or, anim ? artOffset(anim.facing) : -90)};
        } else pose = this.lastPose.get(doc.id) ?? {x: doc.x, y: doc.y, rotation: doc.rotation};
      } else {
        // "end" rests at the finish of a finite run; endless loops (and "here") rest where they are right now
        const tl = timelineFor(doc, pb, anim);
        const evalPb = (mode === "end") && !tl.infinite ? {...pb, paused: true, tau0: tl.duration + 1} : pb;
        pose = poseAt(doc, evalPb, anim, now);
      }
      const x = Math.round(pose.x);
      const y = Math.round(pose.y);
      const flags = {[FLAG_PLAYBACK]: DEL()};
      if ( copy ) flags[FLAG_COPY] = DEL();
      const update = {_id: doc.id, flags: {[MODULE_ID]: flags}};
      if ( (x !== doc._source.x) || (y !== doc._source.y) ) {
        update.x = x;
        update.y = y;
        movement[doc.id] = {waypoints: [{x, y, action: "displace"}], autoRotate: false, showRuler: false};
      }
      if ( (pose.rotation !== undefined) && (Math.abs(pose.rotation - doc._source.rotation) > 1e-6) ) {
        update.rotation = ((pose.rotation % 360) + 360) % 360;
      }
      updates.push(update);
    }
    if ( !updates.length && !deletions.length ) return;
    ids.forEach(id => this.#committing.add(id));
    try {
      if ( updates.length ) {
        await scene.updateEmbeddedDocuments("Token", updates, {
          animate: false,
          pan: false,
          movement,
          [OPT_KEY]: {commit: true}
        });
      }
      const gone = deletions.filter(id => scene.tokens.has(id));
      if ( gone.length ) await scene.deleteEmbeddedDocuments("Token", gone, {[OPT_KEY]: {despawn: true}});
    } finally {
      ids.forEach(id => this.#committing.delete(id));
    }
    Hooks.callAll(`${MODULE_ID}.stopped`, scene, [...updates.map(u => u._id), ...deletions]);
  }

  /* -------------------------------------------- */
  /*  Symmetry copies                             */
  /* -------------------------------------------- */

  /** Tokens on a scene that are symmetry copies in a playback group. */
  static copiesOf(scene, gid) {
    if ( !gid ) return [];
    return scene.tokens.filter(t => t.getFlag(MODULE_ID, FLAG_COPY)?.gid === gid);
  }

  /** Build the creation data of one symmetry copy. */
  static #copyData(source, sourcePb, sym, index, anim, now) {
    const data = source.toObject();
    delete data._id;
    delete data._movementHistory;
    data.flags ??= {};
    const pb = {...sourcePb, id: newId(), sym: {...sym, i: index}};
    data.flags[MODULE_ID] = {[FLAG_COPY]: {source: source.id, gid: sourcePb.gid, index, anim: anim.id}, [FLAG_PLAYBACK]: pb};
    if ( anim.symmetry.link === "independent" ) data.actorLink = false;
    // Start where the copy will first be drawn, so nothing flashes at the original's position
    try {
      const pose = poseAt(source, pb, anim, now);
      data.x = Math.round(pose.x);
      data.y = Math.round(pose.y);
      if ( pose.rotation !== undefined ) data.rotation = ((pose.rotation % 360) + 360) % 360;
    } catch(err) {
      console.warn(`${MODULE_ID} | Could not place symmetry copy`, err);
    }
    return data;
  }

  /**
   * Create, update and remove symmetry copies so every playing token of the scene matches its animation's
   * symmetry settings. Runs on the active GM whenever animations change, so the copy slider works live.
   */
  static reconcileSymmetry(scene) {
    return this.#serial(() => this.#reconcile(scene)).catch(() => {});
  }

  static async #reconcile(scene) {
    if ( !game.users.activeGM?.isSelf || !scene ) return;
    const now = serverNow();
    const updates = [];
    const creates = [];
    const deletes = [];
    for ( const doc of scene.tokens ) {
      const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
      if ( !pb || doc.getFlag(MODULE_ID, FLAG_COPY) || this.#committing.has(pb.id) ) continue;
      const anim = Store.get(pb.anim, scene);
      if ( !anim ) continue;
      const want = anim.symmetry.count;
      const gid = pb.gid ?? pb.id;
      const copies = this.copiesOf(scene, gid);
      if ( (want <= 1) && !copies.length && (!pb.sym || (pb.sym.n <= 1)) ) continue;
      const tl = timelineFor(doc, pb, anim);
      const pivot = tokenPivot(doc);
      const c = symmetryCenterFor(anim, {x: pb.ox + pivot.x, y: pb.oy + pivot.y}, tl.offset);
      const sym = {n: want, mode: anim.symmetry.mode, axis: anim.symmetry.axis, cx: c.x, cy: c.y};
      const same = pb.sym && (pb.sym.n === sym.n) && (pb.sym.mode === sym.mode) && (pb.sym.axis === sym.axis)
        && (Math.abs(pb.sym.cx - sym.cx) < 0.01) && (Math.abs(pb.sym.cy - sym.cy) < 0.01);
      const sourcePb = {...pb, gid, sym: {...sym, i: 0}};
      if ( !same || (pb.gid !== gid) ) updates.push({_id: doc.id, flags: {[MODULE_ID]: {[FLAG_PLAYBACK]: REPLACE(sourcePb)}}});
      // Copies deleted on purpose (e.g. destroyed in combat) are never brought back
      const removed = new Set(pb.removed ?? []);
      const seen = new Set();
      for ( const copy of copies ) {
        const index = copy.getFlag(MODULE_ID, FLAG_COPY).index;
        if ( (index >= want) || seen.has(index) ) {
          deletes.push(copy.id);
          continue;
        }
        seen.add(index);
        const cpb = copy.getFlag(MODULE_ID, FLAG_PLAYBACK);
        if ( !same && cpb ) {
          updates.push({_id: copy.id, flags: {[MODULE_ID]: {[FLAG_PLAYBACK]: REPLACE({...cpb, sym: {...sym, i: index}})}}});
        }
      }
      if ( !game.user.can("TOKEN_CREATE") ) continue;
      for ( let i = 1; i < want; i++ ) {
        if ( !seen.has(i) && !removed.has(i) ) creates.push(this.#copyData(doc, sourcePb, sym, i, anim, now));
      }
    }
    if ( deletes.length ) await scene.deleteEmbeddedDocuments("Token", deletes, {[OPT_KEY]: {despawn: true}});
    if ( updates.length ) await scene.updateEmbeddedDocuments("Token", updates, {[OPT_KEY]: {patch: true}});
    if ( creates.length ) await scene.createEmbeddedDocuments("Token", creates, {[OPT_KEY]: {spawn: true}});
  }

  /**
   * Find symmetry copies that no longer belong to a running group — their source was deleted or stopped, an undo
   * brought them back, another module interfered — and tidy them up. Runs on the active GM about once a second.
   */
  static async #sweep() {
    for ( const scene of game.scenes ) {
      const orphaned = new Set();
      for ( const t of scene.tokens ) {
        const copy = t.getFlag(MODULE_ID, FLAG_COPY);
        if ( !copy ) continue;
        const spb = scene.tokens.get(copy.source)?.getFlag(MODULE_ID, FLAG_PLAYBACK);
        if ( !spb || (spb.gid !== copy.gid) ) orphaned.add(copy.gid);
      }
      for ( const gid of orphaned ) await this.cleanupGroup(scene, gid);
    }
  }

  /**
   * Remember that a copy was deleted on purpose (e.g. it was destroyed in combat), so live symmetry updates never
   * bring it back. Runs on the active GM.
   */
  static async markRemoved(scene, copyFlag) {
    const source = scene?.tokens.get(copyFlag?.source);
    const pb = source?.getFlag(MODULE_ID, FLAG_PLAYBACK);
    if ( !pb || (pb.gid !== copyFlag.gid) ) return;
    const removed = Array.from(new Set([...(pb.removed ?? []), copyFlag.index]));
    await source.update({flags: {[MODULE_ID]: {[FLAG_PLAYBACK]: REPLACE({...pb, removed})}}}, {[OPT_KEY]: {patch: true}});
  }

  /**
   * Stop and tidy up the copies of a group whose source is no longer playing (stopped by a player, moved by hand,
   * deleted…). Runs on the active GM. Copies stopped by someone who couldn't delete them are removed here.
   */
  static async cleanupGroup(scene, gid) {
    if ( !scene || !gid ) return;
    const copies = this.copiesOf(scene, gid);
    const running = copies.filter(c => {
      const pb = c.getFlag(MODULE_ID, FLAG_PLAYBACK);
      return pb && !this.#committing.has(pb.id);
    });
    if ( running.length ) await this.#commit(scene, running.map(doc => ({doc, mode: "here"})));
    const orphans = this.copiesOf(scene, gid).filter(c => !c.getFlag(MODULE_ID, FLAG_PLAYBACK));
    const remove = [];
    const release = [];
    for ( const c of orphans ) {
      const anim = Store.get(c.getFlag(MODULE_ID, FLAG_COPY).anim, scene);
      if ( anim?.symmetry.keep ) release.push({_id: c.id, flags: {[MODULE_ID]: {[FLAG_COPY]: DEL()}}});
      else remove.push(c.id);
    }
    if ( release.length ) await scene.updateEmbeddedDocuments("Token", release, {[OPT_KEY]: {patch: true}});
    const gone = remove.filter(id => scene.tokens.has(id));
    if ( gone.length && game.user.can("TOKEN_DELETE") ) {
      await scene.deleteEmbeddedDocuments("Token", gone, {[OPT_KEY]: {despawn: true}});
    }
  }

  /* -------------------------------------------- */

  /**
   * Play an animation on tokens.
   * @param {string|object} animOrId          Animation, id, or name
   * @param {Token|TokenDocument|string|Array} tokens   Tokens to animate (defaults to the animation's assigned tokens)
   * @param {object} [options]
   * @param {Scene} [options.scene]
   * @param {number} [options.rate=1]         Playback speed multiplier
   * @param {string} [options.stagger]        Override stagger mode ("none"|"delay"|"spread")
   * @param {number} [options.staggerDelay]   Override delay between tokens (ms)
   */
  static async play(animOrId, tokens, {scene, rate=1, stagger, staggerDelay, targets}={}) {
    scene = Store.scene(scene);
    const anim = typeof animOrId === "object" ? animOrId
      : (Store.get(animOrId, scene) ?? Store.all(scene).find(a => a.name === animOrId));
    if ( !anim ) {
      ui.notifications.warn("KAA.Warn.NoAnimation", {localize: true});
      return [];
    }
    let docs = resolveTokens(tokens ?? anim.tokens, scene).filter(d => (d.parent === scene) && scene.tokens.has(d.id));
    if ( !docs.length ) {
      ui.notifications.warn("KAA.Warn.NoTokens", {localize: true});
      return [];
    }
    if ( !anim.steps.some(s => s.enabled !== false) ) {
      ui.notifications.warn("KAA.Warn.NoSteps", {localize: true});
      return [];
    }
    const denied = docs.filter(d => !d.canUserModify(game.user, "update"));
    if ( denied.length ) {
      ui.notifications.warn(game.i18n.format("KAA.Warn.CannotControl", {names: denied.map(d => d.name).join(", ")}));
      docs = docs.filter(d => !denied.includes(d));
      if ( !docs.length ) return [];
    }
    // Players play only what the animation allows them to (its "Who can play it")
    if ( !game.user.isGM ) {
      const allowed = docs.filter(d => canPlay(anim, d));
      if ( !allowed.length ) {
        ui.notifications.warn("KAA.Warn.NotAllowed", {localize: true});
        return [];
      }
      docs = allowed;
    }

    // Order tokens as listed in the animation so staggering is predictable
    const order = anim.tokens;
    docs.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });

    // Homing legs and anchors are aimed at what the player has targeted when they press play
    const centerOf = d => {
      const c = tokenPivot(d);
      return {id: d.id, x: d._source.x + c.x, y: d._source.y + c.y};
    };
    // Explicit targets (e.g. a GM acting for a player) replace the current user's targets
    const targetDocs = (targets ? resolveTokens(targets, scene) : [...(game.user.targets ?? [])].map(t => t.document))
      .filter(d => d?.parent === scene);
    const homingSteps = anim.steps.filter(st => st.enabled !== false && st.shape.type === "homing");
    const movers = new Set(docs.map(d => d.id));
    const aimed = targetDocs.filter(d => !movers.has(d.id));
    if ( needsTargets(anim) && !aimed.length ) {
      ui.notifications.warn("KAA.Warn.NeedsTarget", {localize: true});
      return [];
    }
    const {anchor: anchorDoc, strikes} = aimTargets(anim, scene, aimed);
    const snap = {targets: strikes.map(centerOf)};
    if ( anchorDoc ) snap.anchor = centerOf(anchorDoc);
    for ( const st of homingSteps ) {
      if ( (st.shape.to !== "token") || !st.shape.tokenId ) continue;
      const d = scene.tokens.get(st.shape.tokenId);
      if ( d ) (snap.points ??= {})[d.id] = centerOf(d);
    }

    const mode = stagger ?? anim.stagger.mode;
    const delayStep = staggerDelay ?? anim.stagger.delay;
    const now = serverNow();
    const t0 = now + this.lead;
    const dims = {size: scene.dimensions.size, distance: scene.dimensions.distance || 1};
    const n = docs.length;
    const poses = docs.map(d => currentPose(d));
    const centers = docs.map((d, i) => {
      const p = tokenPivot(d);
      return {x: poses[i].x + p.x, y: poses[i].y + p.y};
    });
    const delays = new Array(n).fill(0);
    const phases = new Array(n).fill(0);

    if ( mode === "delay" ) docs.forEach((_d, i) => delays[i] = i * delayStep);
    else if ( (mode === "spread") && (n > 1) ) {
      const resolve = origin => spec => snapshotPoint(spec, snap, origin);
      const probe = compileTimeline(anim, {origin: centers[0], dims, resolve: resolve(centers[0])});
      if ( probe.infinite ) {
        // Evenly spaced around the loop; each token trails the previous one by 1/n of a cycle
        const cycle = probe.cycleDuration;
        docs.forEach((_d, i) => phases[i] = ((n - i) % n) * (cycle / n));
        // Tokens that reach their place sooner wait at their origin, so everyone joins the loop together
        const joins = docs.map((_d, i) => compileTimeline(anim, {origin: centers[i], dims, phase: phases[i],
          resolve: resolve(centers[i])}).joinTime);
        const J = Math.max(...joins);
        docs.forEach((_d, i) => delays[i] = J - joins[i]);
      } else {
        const step = probe.duration / n;
        docs.forEach((_d, i) => delays[i] = i * step);
      }
    }

    // Spawning shares a queue with live symmetry updates, so a pending update can't add the same copies again
    return this.#serial(() => this.#start(scene, anim, docs, {rate, now, t0, centers, poses, delays, phases, snap}));
  }

  /** Second half of play(): write playbacks and create symmetry copies. */
  static async #start(scene, anim, docs, {rate, now, t0, centers, poses, delays, phases, snap}) {
    // Copies already running for these tokens are replaced
    const symN = anim.symmetry.count;
    const canSpawn = (symN > 1) && game.user.can("TOKEN_CREATE");
    const stale = [];
    for ( const doc of docs ) {
      const gid = groupOf(doc);
      if ( gid && !doc.getFlag(MODULE_ID, FLAG_COPY) ) stale.push(...this.copiesOf(scene, gid).map(c => c.id));
    }

    const updates = [];
    const creates = [];
    docs.forEach((doc, i) => {
      const pose = poses[i];
      const id = newId();
      const pb = {
        id, gid: id, anim: anim.id, t0, tau0: 0, rate: Math.max(0.01, Number(rate) || 1), paused: false,
        ox: pose.x, oy: pose.y, or: pose.rotation ?? 0, delay: delays[i], phase: phases[i], by: game.user.id,
        ...snap
      };
      const isCopy = !!doc.getFlag(MODULE_ID, FLAG_COPY);
      if ( canSpawn && !isCopy ) {
        const tl = timelineFor(doc, pb, anim);
        const c = symmetryCenterFor(anim, centers[i], tl.offset);
        const sym = {n: symN, mode: anim.symmetry.mode, axis: anim.symmetry.axis, cx: c.x, cy: c.y};
        pb.sym = {...sym, i: 0};
        for ( let k = 1; k < symN; k++ ) creates.push(this.#copyData(doc, pb, sym, k, anim, now));
      }
      updates.push({_id: doc.id, flags: {[MODULE_ID]: {[FLAG_PLAYBACK]: REPLACE(pb)}}});
    });
    const staleIds = game.user.can("TOKEN_DELETE") ? stale.filter(id => scene.tokens.has(id) && !docs.some(d => d.id === id)) : [];
    if ( staleIds.length ) await scene.deleteEmbeddedDocuments("Token", staleIds, {[OPT_KEY]: {despawn: true}});
    await scene.updateEmbeddedDocuments("Token", updates, {[OPT_KEY]: {play: true}});
    if ( creates.length ) await scene.createEmbeddedDocuments("Token", creates, {[OPT_KEY]: {spawn: true}});
    if ( (symN > 1) && !canSpawn ) ui.notifications.warn("KAA.Warn.NoCopies", {localize: true});
    Hooks.callAll(`${MODULE_ID}.started`, scene, anim, docs);
    return docs;
  }

  /** Expand a list of tokens with the symmetry copies of any sources in it. */
  static #withCopies(docs) {
    const out = new Set(docs);
    for ( const doc of docs ) {
      if ( doc.getFlag(MODULE_ID, FLAG_COPY) ) continue;
      const gid = doc.getFlag(MODULE_ID, FLAG_PLAYBACK)?.gid;
      for ( const c of this.copiesOf(doc.parent, gid) ) out.add(c);
    }
    return [...out];
  }

  /** Apply a change to the playback of tokens (and their symmetry copies). */
  static async #patch(tokens, scene, fn) {
    scene = Store.scene(scene);
    const docs = this.#withCopies(resolveTokens(tokens, scene));
    const now = serverNow();
    const byScene = new Map();
    for ( const doc of docs ) {
      const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
      if ( !pb || !doc.canUserModify(game.user, "update") ) continue;
      const next = fn({...pb}, now, doc);
      if ( !next ) continue;
      const list = byScene.get(doc.parent) ?? [];
      list.push({_id: doc.id, flags: {[MODULE_ID]: {[FLAG_PLAYBACK]: REPLACE(next)}}});
      byScene.set(doc.parent, list);
    }
    for ( const [s, updates] of byScene ) {
      await s.updateEmbeddedDocuments("Token", updates, {[OPT_KEY]: {patch: true}});
    }
  }

  static pause(tokens, {scene}={}) {
    return this.#patch(tokens, scene, (pb, now) => {
      if ( pb.paused ) return null;
      return {...pb, paused: true, tau0: tauAt(pb, now), t0: now};
    });
  }

  static resume(tokens, {scene}={}) {
    const t1 = serverNow() + this.lead;
    return this.#patch(tokens, scene, pb => {
      if ( !pb.paused ) return null;
      return {...pb, paused: false, t0: t1};
    });
  }

  static togglePause(tokens, {scene}={}) {
    // Decide once for the whole group so copies never end up half paused
    const docs = resolveTokens(tokens, Store.scene(scene));
    const anyRunning = docs.some(d => {
      const pb = d.getFlag(MODULE_ID, FLAG_PLAYBACK);
      return pb && !pb.paused;
    });
    return anyRunning ? this.pause(tokens, {scene}) : this.resume(tokens, {scene});
  }

  /** Change the live playback speed multiplier without any jump in position. */
  static setRate(tokens, rate, {scene}={}) {
    rate = Math.max(0.01, Number(rate) || 1);
    return this.#patch(tokens, scene, (pb, now) => ({...pb, rate, tau0: tauAt(pb, now), t0: now}));
  }

  /** Jump to a playback time (ms). */
  static seek(tokens, tau, {scene}={}) {
    return this.#patch(tokens, scene, (pb, now) => ({...pb, tau0: Math.max(0, tau), t0: now}));
  }

  /**
   * Stop tokens (symmetry copies of a stopped token stop with it).
   * @param {*} tokens
   * @param {object} [options]
   * @param {"here"|"origin"|"end"} [options.mode="here"]   Where the token should rest
   */
  static async stop(tokens, {scene, mode="here", detach=false}={}) {
    scene = Store.scene(scene);
    const given = resolveTokens(tokens, scene);
    // Detaching a single copy must not drag the rest of its group along
    const docs = (detach ? given : this.#withCopies(given)).filter(d => d.getFlag(MODULE_ID, FLAG_PLAYBACK)
      && d.canUserModify(game.user, "update"));
    const byScene = new Map();
    for ( const doc of docs ) {
      const list = byScene.get(doc.parent) ?? [];
      list.push({doc, mode});
      byScene.set(doc.parent, list);
    }
    for ( const [s, list] of byScene ) await this.#commit(s, list, {detach});
  }

  /** Stop every playing token on a scene (or all scenes). */
  static async stopAll({scene, mode="here"}={}) {
    const docs = [];
    for ( const uuid of this.registry ) {
      const doc = fromUuidSync(uuid);
      if ( doc && (!scene || (doc.parent === Store.scene(scene))) ) docs.push(doc);
    }
    const byScene = new Map();
    for ( const d of docs ) byScene.set(d.parent, [...(byScene.get(d.parent) ?? []), d]);
    for ( const [s, list] of byScene ) await this.stop(list, {scene: s, mode});
  }

  static async pauseAll({scene}={}) {
    const docs = this.playing(scene);
    const byScene = new Map();
    for ( const d of docs ) byScene.set(d.parent, [...(byScene.get(d.parent) ?? []), d]);
    for ( const [s, list] of byScene ) await this.pause(list, {scene: s});
  }

  /** Playing token documents (optionally on one scene, optionally for one animation). */
  static playing(scene, animId) {
    const out = [];
    const sc = scene ? Store.scene(scene) : null;
    for ( const uuid of this.registry ) {
      const doc = fromUuidSync(uuid);
      if ( !doc ) continue;
      if ( sc && (doc.parent !== sc) ) continue;
      if ( animId && (doc.getFlag(MODULE_ID, FLAG_PLAYBACK)?.anim !== animId) ) continue;
      out.push(doc);
    }
    return out;
  }

  /** Status of a token's playback for UI display. */
  static status(doc) {
    const pb = doc?.getFlag(MODULE_ID, FLAG_PLAYBACK);
    if ( !pb ) return {playing: false};
    const anim = Store.get(pb.anim, doc.parent);
    if ( !anim ) return {playing: true, paused: pb.paused, anim: null, progress: null};
    const tl = timelineFor(doc, pb, anim);
    const tau = tauAt(pb);
    let progress;
    let cycles = null;
    if ( tl.infinite ) {
      const c = tl.cycleDuration || 1;
      progress = (((tau - tl.prefix.T) % c) + c) % c / c;
      cycles = Math.max(0, Math.floor((tau - tl.prefix.T) / c));
    } else progress = tl.duration > 0 ? Math.min(1, Math.max(0, tau / tl.duration)) : 1;
    const copies = pb.gid ? this.copiesOf(doc.parent, pb.gid).length : 0;
    return {playing: true, paused: pb.paused, anim, progress, cycles, rate: pb.rate, infinite: tl.infinite,
      tau, duration: tl.duration, copies, isCopy: !!doc.getFlag(MODULE_ID, FLAG_COPY)};
  }
}
