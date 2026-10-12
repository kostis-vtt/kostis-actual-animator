// Shared editing state between the control panel and the canvas layer.

import {LAYER_NAME, MODULE_ID} from "./const.js";
import {Store} from "./model.js";

export class Editor {
  /** Selected animation id. */
  static animId = null;

  /** Selected step id. */
  static stepId = null;

  /** Selected sub-element of the selected step: {type: "node"|"segment", index} */
  static sel = null;

  /** Local, unsaved version of an animation while it is being dragged on the canvas. */
  static preview = null;

  /** Increments every time the drag preview changes. */
  static previewVersion = 0;

  /** Whether the preview ghost is playing. */
  static ghost = false;

  /** Live playback-rate multiplier from the panel (also drives the preview ghost). */
  static rate = 1;

  /** Canvas picking mode requested by the panel: {mode: "tokens"|"facePoint"|"faceToken", stepId?} */
  static picking = null;

  /** Persistent editor options. */
  static opts = {
    snap: false,
    showAll: true,
    penSmooth: 0,
    polygonSides: 6,
    polygonStar: 0,
    spiralTurns: 3,
    spiralInner: 0.1,
    waveForm: "sine",
    waveAmplitude: 0.5,
    waveLength: 2,
    pointWait: 1000
  };

  static #listeners = new Set();

  static load() {
    try {
      Object.assign(this.opts, game.settings.get(MODULE_ID, "editor") ?? {});
    } catch(err) {
      // Setting not registered yet
    }
  }

  static async saveOpts() {
    await game.settings.set(MODULE_ID, "editor", {...this.opts});
  }

  static on(fn) {
    this.#listeners.add(fn);
  }

  static off(fn) {
    this.#listeners.delete(fn);
  }

  /**
   * Notify listeners.
   * @param {string} what   "selection" | "data" | "options" | "preview" | "ghost"
   */
  static emit(what) {
    for ( const fn of this.#listeners ) {
      try {
        fn(what);
      } catch(err) {
        console.error(`${MODULE_ID} |`, err);
      }
    }
  }

  /** The selected animation, including unsaved drag changes. */
  static get anim() {
    if ( !this.animId ) return null;
    if ( this.preview?.animId === this.animId ) return this.preview.anim;
    return Store.get(this.animId);
  }

  static get step() {
    return this.anim?.steps.find(s => s.id === this.stepId) ?? null;
  }

  static get stepIndex() {
    return this.anim?.steps.findIndex(s => s.id === this.stepId) ?? -1;
  }

  /** Effective animation for drawing purposes (preview-aware). */
  static resolve(anim) {
    if ( this.preview?.animId === anim.id ) return this.preview.anim;
    return anim;
  }

  static select(animId, stepId=null, sel=null) {
    const changed = (animId !== this.animId) || (stepId !== this.stepId)
      || (JSON.stringify(sel) !== JSON.stringify(this.sel));
    if ( animId !== this.animId ) this.ghost = false;
    this.animId = animId;
    this.stepId = stepId;
    this.sel = sel;
    if ( changed ) this.emit("selection");
  }

  /** Make sure the selection still refers to existing data. */
  static validate() {
    if ( this.animId && !Store.get(this.animId) ) {
      this.animId = null;
      this.stepId = null;
      this.sel = null;
      this.ghost = false;
    }
    const anim = this.anim;
    if ( anim && this.stepId && !anim.steps.some(s => s.id === this.stepId) ) {
      this.stepId = null;
      this.sel = null;
    }
  }

  static setPreview(anim) {
    this.preview = anim ? {animId: anim.id, anim} : null;
    this.previewVersion++;
    this.emit("preview");
  }

  /** Start or end canvas picking (activates the animator layer when starting). */
  static setPicking(picking) {
    this.picking = picking;
    if ( picking ) {
      const hint = {
        tokens: "KAA.Pick.Tokens",
        facePoint: "KAA.Pick.FacePoint",
        faceToken: "KAA.Pick.FaceToken",
        targetGroup: "KAA.Pick.TargetGroup",
        anchorToken: "KAA.Pick.AnchorToken",
        homingToken: "KAA.Pick.HomingToken",
        symPoint: "KAA.Pick.SymPoint"
      }[picking.mode];
      if ( hint ) ui.notifications.info(hint, {localize: true});
    }
    this.emit("picking");
  }

  static async setOpt(key, value) {
    if ( this.opts[key] === value ) return;
    this.opts[key] = value;
    this.emit("options");
    // Keep the scene-control toggles in sync when changed from the panel
    const toolName = {snap: "kaaSnap", showAll: "kaaShowAll"}[key];
    const tool = toolName && (ui.controls?.control?.name === LAYER_NAME) ? ui.controls.control.tools[toolName] : null;
    if ( tool && (tool.active !== value) ) ui.controls.render({reset: true});
    await this.saveOpts();
  }
}
