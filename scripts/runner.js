// Per-client frame driver. Every frame it samples each playing token's timeline and writes the exact
// (fractional, unsnapped) pose straight into the rendered token, the same way Foundry's own animation
// system does — so vision, lights, attached regions and the HUD all follow the true path.

import {FLAG_PLAYBACK, MODULE_ID} from "./const.js";
import {Store} from "./model.js";
import {Playback, poseAt, serverNow, tokenPivot} from "./playback.js";

/** Animation context handed to Token#_onAnimationUpdate. */
const FRAME_CONTEXT = Object.freeze({name: `${MODULE_ID}.frame`, time: 1, duration: Infinity, to: {}, chain: []});

/** Shadows sit just below tokens in the primary canvas group. */
const SHADOW_SORT_LAYER = 699;

export class Runner {
  /**
   * @type {Map<string, {doc: TokenDocument, last: {x:number,y:number,rotation:number}|null, lifted: boolean,
   *   shadow: PIXI.DisplayObject|null, rot: number|null, rotTime: number}>}
   */
  static #entries = new Map();

  static #ticking = false;

  /** Visual lift (pixels up the screen) of each token's image. Vision, lights and the stored position stay on the ground. */
  static #rise = new WeakMap();

  /** How far a token's image is drawn above its true position. */
  static riseOf(token) {
    return this.#rise.get(token) ?? 0;
  }

  /** Number of tokens currently being driven on this client. */
  static get size() {
    return this.#entries.size;
  }

  static isDriving(tokenId) {
    return this.#entries.has(tokenId);
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  static activate() {
    if ( this.#ticking || !canvas.app?.ticker ) return;
    // Run after Foundry's own token animations (OBJECTS + 1) and before render flags are applied (OBJECTS)
    const priority = (PIXI.UPDATE_PRIORITY.OBJECTS ?? (PIXI.UPDATE_PRIORITY.HIGH - 2)) + 0.5;
    canvas.app.ticker.add(this.#tick, this, priority);
    this.#ticking = true;
  }

  static deactivate() {
    if ( this.#ticking ) canvas.app?.ticker?.remove(this.#tick, this);
    this.#ticking = false;
    for ( const id of [...this.#entries.keys()] ) this.#drop(id);
  }

  /** Rebuild the set of driven tokens for the viewed scene. */
  static syncAll() {
    for ( const id of [...this.#entries.keys()] ) this.#drop(id);
    if ( !canvas.scene ) return;
    for ( const doc of canvas.scene.tokens ) this.sync(doc);
  }

  /** Start, update or stop driving a token according to its playback flag. */
  static sync(doc) {
    if ( doc.parent !== canvas.scene ) return;
    const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
    if ( !pb ) {
      this.#drop(doc.id);
      return;
    }
    const entry = this.#entries.get(doc.id);
    if ( entry ) entry.doc = doc;
    else this.#entries.set(doc.id, {doc, last: null, lifted: false, shadow: null, rot: null, rotTime: 0});
  }

  static release(tokenId) {
    this.#drop(tokenId);
  }

  /** Forget a token and clean up anything we drew for it. */
  static #drop(tokenId) {
    const entry = this.#entries.get(tokenId);
    if ( !entry ) return;
    this.#entries.delete(tokenId);
    Playback.lastPose.delete(tokenId);
    if ( entry.shadow && !entry.shadow.destroyed ) entry.shadow.destroy();
    const token = entry.doc.object;
    if ( token ) this.#rise.delete(token);
    if ( entry.lifted && token && !token.destroyed ) {
      // Restore the stored scale and elevation, which our height effect overrode
      token.renderFlags.set({refreshMesh: true, refreshElevation: true, refreshPosition: true});
    }
  }

  /* -------------------------------------------- */
  /*  Frame                                       */
  /* -------------------------------------------- */

  static #tick() {
    if ( !this.#entries.size ) return;
    const now = serverNow();
    const wall = performance.now();
    for ( const [id, entry] of this.#entries ) {
      const doc = entry.doc;
      const token = doc.object;
      if ( !token || token.destroyed || !token.mesh ) continue;
      const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
      if ( !pb ) {
        this.#drop(id);
        continue;
      }
      const anim = Store.get(pb.anim, doc.parent);
      if ( !anim ) continue;
      let pose;
      try {
        pose = poseAt(doc, pb, anim, now);
      } catch(err) {
        console.error(`${MODULE_ID} | Failed to evaluate playback for ${doc.name}`, err);
        this.#drop(id);
        continue;
      }
      this.#smoothRotation(entry, pose, wall);
      this.#apply(token, entry, pose, anim);
    }
  }

  /** Limit how fast a token may turn (facing "turn rate"); purely visual. */
  static #smoothRotation(entry, pose, wall) {
    const rate = pose.facing?.turnRate || 0;
    if ( (pose.rotation === undefined) || !(rate > 0) || (entry.rot === null) ) {
      if ( pose.rotation !== undefined ) entry.rot = pose.rotation;
      entry.rotTime = wall;
      return;
    }
    const dt = Math.min(0.25, Math.max(0, (wall - entry.rotTime) / 1000));
    entry.rotTime = wall;
    let delta = ((pose.rotation - entry.rot + 540) % 360) - 180;
    const max = rate * dt;
    if ( Math.abs(delta) > max ) delta = Math.sign(delta) * max;
    entry.rot = (((entry.rot + delta) % 360) + 360) % 360;
    pose.rotation = entry.rot;
  }

  static #apply(token, entry, pose, anim) {
    const doc = token.document;
    const changed = {};
    const size = doc.parent.dimensions.size;
    const fx = anim.height;
    const z = pose.z > 0 ? pose.z : 0;
    const rise = z * size * fx.rise;
    const x = pose.x;
    const y = pose.y;
    // The lift is drawn by offsetting only the token's image (see the _refreshPosition patch in main.js)
    if ( this.riseOf(token) !== rise ) {
      if ( rise > 0 ) this.#rise.set(token, rise);
      else this.#rise.delete(token);
      token.renderFlags.set({refreshPosition: true});
    }
    if ( doc.x !== x ) {
      doc.x = x;
      changed.x = x;
    }
    if ( doc.y !== y ) {
      doc.y = y;
      changed.y = y;
    }
    if ( (pose.rotation !== undefined) && (doc.rotation !== pose.rotation) ) {
      doc.rotation = pose.rotation;
      changed.rotation = pose.rotation;
    }

    // Height: grow the token, raise its elevation readout and cast a shadow on the ground
    if ( (z > 0) || entry.lifted ) {
      const src = doc._source;
      const k = 1 + (z * fx.scale);
      const sx = src.texture.scaleX * k;
      const sy = src.texture.scaleY * k;
      if ( (doc.texture.scaleX !== sx) || (doc.texture.scaleY !== sy) ) {
        doc.texture.scaleX = sx;
        doc.texture.scaleY = sy;
        changed.texture = {scaleX: sx, scaleY: sy};
      }
      const elev = src.elevation + (fx.elevation ? z * (doc.parent.dimensions.distance || 1) : 0);
      if ( doc.elevation !== elev ) {
        doc.elevation = elev;
        changed.elevation = elev;
      }
      entry.lifted = z > 0;
      this.#drawShadow(token, entry, pose, z, fx);
    }

    entry.last = {x: doc.x, y: doc.y, rotation: doc.rotation};
    Playback.lastPose.set(doc.id, entry.last);
    if ( !foundry.utils.isEmpty(changed) ) token._onAnimationUpdate(changed, FRAME_CONTEXT);
  }

  static #drawShadow(token, entry, pose, z, fx) {
    if ( !fx.shadow || !(z > 0) ) {
      if ( entry.shadow ) entry.shadow.visible = false;
      return;
    }
    let g = entry.shadow;
    if ( !g || g.destroyed ) {
      const Cls = foundry.canvas.primary?.PrimaryGraphics ?? PIXI.Graphics;
      g = entry.shadow = new Cls();
      g.sortLayer = SHADOW_SORT_LAYER;
      g.eventMode = "none";
      canvas.primary.addChild(g);
    }
    const doc = token.document;
    const {width, height} = doc.getSize();
    const pivot = tokenPivot(doc);
    // The shadow stays on the ground: it shrinks and fades as the token rises
    const fade = 1 / (1 + (z * 0.6));
    g.clear();
    g.beginFill(0x000000, 0.42 * fade);
    g.drawEllipse(0, 0, (width / 2) * 0.82 * fade, (height / 2) * 0.5 * fade);
    g.endFill();
    g.position.set(pose.x + pivot.x, pose.y + pivot.y + ((height / 2) * 0.25));
    g.elevation = doc._source.elevation;
    g.sort = doc.sort - 1;
    g.visible = token.visible && !token.document.hidden;
  }

  /* -------------------------------------------- */
  /*  Hand-off to Foundry's animation system      */
  /* -------------------------------------------- */

  /**
   * Called right before a Token placeable processes a database update. When the update moves the token or ends
   * its playback, Foundry's internal animation state is synchronised to the pose we last displayed, so any
   * movement animation Foundry starts next begins exactly where the token visibly is (no snapping back).
   * @param {Token} token
   * @param {object} changed
   */
  static beforeTokenUpdate(token, changed) {
    const entry = this.#entries.get(token.id);
    if ( !entry?.last ) return;
    const doc = token.document;
    const ended = !doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
    const moved = ["x", "y", "width", "height", "shape", "rotation"].some(k => k in changed);
    if ( !ended && !moved ) return;
    const source = {x: doc.x, y: doc.y, rotation: doc.rotation};
    doc.x = entry.last.x;
    doc.y = entry.last.y;
    doc.rotation = entry.last.rotation;
    try {
      token.stopAnimation({reset: false});
    } finally {
      doc.x = source.x;
      doc.y = source.y;
      doc.rotation = source.rotation;
    }
    entry.last = null;
    if ( ended ) this.#drop(token.id);
  }
}
