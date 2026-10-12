// Kostis's Actual Animator — entry point.

import {FLAG_PLAYBACK, LAYER_NAME, MODULE_ID, OPT_KEY} from "./const.js";
import {KaaLayer} from "./layer.js";
import {Runner} from "./runner.js";
import {FLAG_COPY, Playback, resolveTokens, tokenPivot} from "./playback.js";
import {Store, defaultStep, normalizeAnimation} from "./model.js";
import {Editor} from "./editor.js";
import {AnimatorPanel} from "./panel.js";
import {onRenderTokenHUD} from "./hud.js";
import {buildShape, shapeToPath} from "./shapes.js";
import {compileTimeline} from "./timeline.js";
import {TemplateGallery, openTemplateInEditor, placeTemplate} from "./gallery.js";
import {BUILTIN_TEMPLATES} from "./templates.js";
import {animationTrack, trackOffset} from "./track.js";

const TPL = `modules/${MODULE_ID}/templates`;

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * Macro / module API, available as `game.modules.get("kostis-actual-animator").api` and `globalThis.KAA`.
 * @example
 * // Play "Patrol" on the selected tokens at double speed
 * KAA.play("Patrol", canvas.tokens.controlled, {rate: 2});
 * // Stop and send everyone back to where they started
 * KAA.stopAll({mode: "origin"});
 */
const API = {
  /** Play an animation (id or name) on tokens (defaults to its assigned tokens). */
  play: (anim, tokens, options) => Playback.play(anim, tokens, options),
  pause: (tokens, options) => Playback.pause(tokens, options),
  resume: (tokens, options) => Playback.resume(tokens, options),
  togglePause: (tokens, options) => Playback.togglePause(tokens, options),
  /** Stop tokens. mode: "here" (default) | "origin" | "end". */
  stop: (tokens, options) => Playback.stop(tokens, options),
  stopAll: options => Playback.stopAll(options),
  pauseAll: options => Playback.pauseAll(options),
  /** Change the live speed multiplier of playing tokens. */
  setRate: (tokens, rate, options) => Playback.setRate(tokens, rate, options),
  /** Jump playing tokens to a time (ms) of their animation. */
  seek: (tokens, ms, options) => Playback.seek(tokens, ms, options),
  isPlaying: token => !!resolveTokens(token)[0]?.getFlag(MODULE_ID, FLAG_PLAYBACK),
  status: token => Playback.status(resolveTokens(token)[0]),
  /** Tokens currently playing (optionally on one scene / for one animation id). */
  playing: (scene, animId) => Playback.playing(scene, animId),
  animations: scene => Store.all(scene),
  getAnimation: (idOrName, scene) => Store.get(idOrName, scene) ?? Store.all(scene).find(a => a.name === idOrName) ?? null,
  /**
   * Create an animation from plain data (steps with shapes in scene pixels, motion, facing, tokens…).
   * @example KAA.createAnimation({name: "Lap", steps: [{shape: {type: "ellipse", cx: 1000, cy: 800, rx: 300}}]})
   */
  createAnimation: (data, options={}) => Store.create({...data, steps: (data.steps ?? []).map(({shape, ...rest}) => defaultStep(shape, rest))}, options),
  /** Change an animation: `changes` is merged into it, or a function receives an editable copy. */
  updateAnimation: (id, changes, options={}) => Store.mutate(id, a => {
    if ( typeof changes === "function" ) return changes(a);
    foundry.utils.mergeObject(a, changes);
  }, options),
  /**
   * The drawn path of an animation, step by step, as polylines in travel order (reversed steps and loop start
   * points included). For drawing effects along a path.
   * @returns {{points: Float64Array, closed: boolean, length: number, stepId: string}[]}
   */
  track: (anim, {scene, spacing}={}) => {
    const a = typeof anim === "object" ? anim : API.getAnimation(anim, scene);
    return a ? animationTrack(a, {spacing}) : [];
  },
  /**
   * How far a token running an animation is from the drawn path: a relative animation is moved to begin where the
   * token began. Add it to a track's points to follow that token. {x: 0, y: 0} for absolute animations.
   */
  trackOffset: (anim, token, {scene}={}) => {
    const doc = token?.document ?? token;
    const a = typeof anim === "object" ? anim : API.getAnimation(anim, scene ?? doc?.parent);
    if ( !a || !doc?.getFlag ) return {x: 0, y: 0};
    return trackOffset(a, doc.getFlag(MODULE_ID, FLAG_PLAYBACK), tokenPivot(doc));
  },
  /**
   * Start drawing on an animation with one of the animator's tools.
   * @param {string|object} anim
   * @param {string} [tool="pen"]   pen, freehand, ellipse, rect, polygon, spiral, wave, figure8, point or edit
   */
  draw: (anim, tool="pen") => {
    const id = typeof anim === "object" ? anim.id : anim;
    const name = tool.startsWith("kaa") ? tool : `kaa${tool[0].toUpperCase()}${tool.slice(1)}`;
    AnimatorPanel.open({animId: id, tab: "path"});
    if ( canvas.ready ) ui.controls.activate({control: LAYER_NAME, tool: name});
  },
  deleteAnimation: async (id, options={}) => {
    // Stop tokens where they are first, so nothing snaps back to its start
    await Playback.stop(Playback.playing(options.scene ?? canvas.scene, id), {scene: options.scene});
    return Store.delete(id, options);
  },
  /** Assign tokens to an animation (adds by default). */
  assign: async (anim, tokens, {replace=false, scene}={}) => {
    const a = typeof anim === "object" ? anim : API.getAnimation(anim, scene);
    if ( !a ) return null;
    const ids = resolveTokens(tokens, scene).map(d => d.id);
    return Store.mutate(a.id, x => {
      x.tokens = replace ? ids : Array.from(new Set([...x.tokens, ...ids]));
    }, {scene});
  },
  openPanel: options => AnimatorPanel.open(options),
  /** Open the template gallery (optionally applying to specific token ids). */
  openTemplates: options => TemplateGallery.open(options),
  /** Built-in and saved templates. */
  templates: () => [...BUILTIN_TEMPLATES, ...Store.library()],
  /**
   * Add a template (name, id or the template object itself) to the scene, assign tokens and play it.
   * `targets` (token ids, tokens or documents) replaces the current user's targets for homing and following.
   * @example KAA.applyTemplate("Drop & bounce", canvas.tokens.controlled)
   * @example KAA.applyTemplate("Homing hammer", [hammer], {targets: [goblin.id]})
   */
  applyTemplate: async (nameOrId, tokens, {play=true, scene, targets, rate}={}) => {
    const all = [...BUILTIN_TEMPLATES, ...Store.library()];
    const tpl = (typeof nameOrId === "object") && nameOrId?.steps ? nameOrId
      : all.find(t => (t.id === nameOrId) || (t.name === nameOrId));
    if ( !tpl ) {
      ui.notifications.warn(`Template "${nameOrId}" not found.`);
      return null;
    }
    const docs = resolveTokens(tokens ?? canvas.tokens.controlled, scene);
    const anim = await placeTemplate(tpl, docs, {scene, targets, requireTargets: play && !!docs.length});
    if ( anim && play && docs.length ) await Playback.play(anim, docs, {scene, targets, rate});
    return anim;
  },
  /**
   * Put a template on the scene and open it in the editor (at the given tokens, else the middle of the view). Your own
   * templates stay linked, so the panel's "Update template" saves the changes back into them; a built-in one becomes
   * a copy to keep with "Save as template".
   * @example KAA.editTemplate("Orbit & strike", {tokens: canvas.tokens.controlled})
   */
  editTemplate: async (nameOrId, {tokens=[], scene}={}) => {
    const all = [...BUILTIN_TEMPLATES, ...Store.library()];
    const tpl = (typeof nameOrId === "object") && nameOrId?.steps ? nameOrId : all.find(t => (t.id === nameOrId) || (t.name === nameOrId));
    if ( !tpl ) {
      ui.notifications.warn(`Template "${nameOrId}" not found.`);
      return null;
    }
    return openTemplateInEditor(tpl, resolveTokens(tokens, scene), {link: !tpl.builtin});
  },
  /**
   * Make every point of an animation's drawn path a sharp corner (smooth 0) or a round curve (1, or anything between).
   * Shapes (circles, rectangles, stars…) become editable paths first. One undo step in the animator.
   * @example KAA.setSmooth("Seal", 0)    // a room's corners
   */
  setSmooth: (anim, smooth, {scene}={}) => {
    const a = typeof anim === "object" ? anim : API.getAnimation(anim, scene);
    if ( !a ) return null;
    const s = Math.min(1, Math.max(0, Number(smooth) || 0));
    return Store.mutate(a.id, x => {
      for ( const st of x.steps ) {
        if ( ["homing", "point"].includes(st.shape?.type) ) continue;
        if ( st.shape.type !== "path" ) {
          st.shape = shapeToPath(st.shape);
          st.startOffset = 0;
        }
        for ( const n of st.shape.nodes ) Object.assign(n, {smooth: s, mode: "auto", hin: null, hout: null, bend: 0});
      }
    }, {scene});
  },
  /** Low-level building blocks for advanced macros. */
  internals: {Store, Playback, Runner, Editor, buildShape, compileTimeline, defaultStep, normalizeAnimation}
};

/* -------------------------------------------- */
/*  Kostis's Flying Paths                       */
/* -------------------------------------------- */

// Join the family launcher when the hub module is enabled (the animator works fine on its own too)
Hooks.once("kostisFlyingPaths.register", kfp => {
  kfp.registerSubmodule({
    id: MODULE_ID,
    open: () => API.openPanel(),
    actions: [
      {label: "Templates", icon: "fa-solid fa-shapes", run: () => API.openTemplates()},
      {label: "Draw a path", icon: "fa-solid fa-pen-nib", run: () => ui.controls.activate({control: LAYER_NAME, tool: "kaaPen"})}
    ]
  });
});

/* -------------------------------------------- */
/*  Init                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();

  CONFIG.Canvas.layers[LAYER_NAME] = {layerClass: KaaLayer, group: "interface"};

  foundry.applications.handlebars.loadTemplates({"kaa-facing": `${TPL}/facing.hbs`});
  foundry.applications.handlebars.loadTemplates([`${TPL}/sidebar.hbs`, `${TPL}/editor.hbs`, `${TPL}/transport.hbs`,
    `${TPL}/gallery.hbs`]);

  const module = game.modules.get(MODULE_ID);
  module.api = API;
  globalThis.KAA = API;
});

Hooks.once("setup", () => {
  Editor.load();
  patchTokenUpdate();
});

Hooks.once("ready", () => {
  Playback.initialize();
  for ( const uuid of Playback.registry ) {
    const doc = fromUuidSync(uuid);
    const gid = doc?.getFlag(MODULE_ID, FLAG_PLAYBACK)?.gid;
    if ( gid ) groupMemory.set(uuid, gid);
  }
});

/** Last known playback group of each playing token, so its copies can follow it when it stops. */
const groupMemory = new Map();

function registerSettings() {
  game.settings.register(MODULE_ID, "interruptOnMove", {
    name: "KAA.Settings.InterruptOnMove.Name",
    hint: "KAA.Settings.InterruptOnMove.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "playersCanPlay", {
    name: "KAA.Settings.PlayersCanPlay.Name",
    hint: "KAA.Settings.PlayersCanPlay.Hint",
    scope: "world", config: true, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "startLead", {
    name: "KAA.Settings.StartLead.Name",
    hint: "KAA.Settings.StartLead.Hint",
    scope: "world", config: true, type: Number, default: 150,
    range: {min: 0, max: 1000, step: 10}
  });
  game.settings.register(MODULE_ID, "showRunning", {
    name: "KAA.Settings.ShowRunning.Name",
    hint: "KAA.Settings.ShowRunning.Hint",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: () => canvas[LAYER_NAME]?.scheduleRefresh()
  });
  game.settings.register(MODULE_ID, "library", {scope: "world", config: false, type: Object, default: {}});
  game.settings.register(MODULE_ID, "editor", {scope: "client", config: false, type: Object, default: {}});
}

function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "openPanel", {
    name: "KAA.Keys.OpenPanel",
    editable: [],
    restricted: true,
    onDown: () => {
      AnimatorPanel.open();
      return true;
    }
  });
  game.keybindings.register(MODULE_ID, "openTemplates", {
    name: "KAA.Keys.OpenTemplates",
    editable: [],
    restricted: true,
    onDown: () => {
      TemplateGallery.open();
      return true;
    }
  });
  game.keybindings.register(MODULE_ID, "finishPath", {
    name: "KAA.Keys.FinishPath",
    editable: [{key: "Enter"}],
    restricted: true,
    onDown: () => !!canvas[LAYER_NAME]?.active && canvas[LAYER_NAME].finishDraft()
  });
  game.keybindings.register(MODULE_ID, "pauseAll", {
    name: "KAA.Keys.PauseAll",
    editable: [],
    restricted: true,
    onDown: () => {
      const docs = Playback.playing(canvas.scene);
      const running = docs.filter(d => !d.getFlag(MODULE_ID, FLAG_PLAYBACK)?.paused);
      if ( running.length ) Playback.pause(running);
      else Playback.resume(docs);
      return true;
    }
  });
  game.keybindings.register(MODULE_ID, "stopAll", {
    name: "KAA.Keys.StopAll",
    editable: [],
    restricted: true,
    onDown: () => {
      Playback.stopAll({scene: canvas.scene});
      return true;
    }
  });
}

/**
 * Let the Runner hand a token back to Foundry's animation system right before an update is processed,
 * so the next core animation starts from the pose the token visibly has. Also draws the height effect by raising
 * only the token's image, so vision, light and region tests stay at the token's true (ground) position.
 */
function patchTokenUpdate() {
  // Our own token operations (starting, pausing, committing, spawning and removing copies) are bookkeeping, not
  // user edits: keep them out of the token layer's Ctrl+Z history, or undo would replay them and resurrect copies.
  const TokenLayer = CONFIG.Canvas.layers.tokens?.layerClass ?? foundry.canvas.layers.TokenLayer;
  const originalStore = TokenLayer.prototype.storeHistory;
  TokenLayer.prototype.storeHistory = function(type, data, options) {
    if ( options?.[OPT_KEY] ) return;
    return originalStore.call(this, type, data, options);
  };

  const afterRefreshPosition = function() {
    const rise = Runner.riseOf(this);
    if ( rise && this.mesh ) this.mesh.position.y -= rise;
  };
  if ( globalThis.libWrapper && game.modules.get("lib-wrapper")?.active ) {
    libWrapper.register(MODULE_ID, "foundry.canvas.placeables.Token.prototype._refreshPosition", function(wrapped, ...args) {
      const result = wrapped(...args);
      afterRefreshPosition.call(this);
      return result;
    }, "WRAPPER");
  } else {
    const proto = foundry.canvas.placeables.Token.prototype;
    const original = proto._refreshPosition;
    proto._refreshPosition = function(...args) {
      const result = original.apply(this, args);
      afterRefreshPosition.call(this);
      return result;
    };
  }

  const before = function(changed) {
    try {
      Runner.beforeTokenUpdate(this, changed);
    } catch(err) {
      console.error(`${MODULE_ID} | beforeTokenUpdate`, err);
    }
  };
  if ( globalThis.libWrapper && game.modules.get("lib-wrapper")?.active ) {
    libWrapper.register(MODULE_ID, "foundry.canvas.placeables.Token.prototype._onUpdate", function(wrapped, changed, ...args) {
      before.call(this, changed);
      return wrapped(changed, ...args);
    }, "WRAPPER");
    return;
  }
  const proto = foundry.canvas.placeables.Token.prototype;
  const original = proto._onUpdate;
  proto._onUpdate = function(changed, ...args) {
    before.call(this, changed);
    return original.call(this, changed, ...args);
  };
}

/* -------------------------------------------- */
/*  Canvas lifecycle                            */
/* -------------------------------------------- */

let lastScale = null;

Hooks.on("canvasReady", () => {
  Runner.activate();
  Runner.syncAll();
  Editor.validate();
  lastScale = canvas.stage.scale.x;
  canvas[LAYER_NAME]?.refresh();
  AnimatorPanel.instance?.requestRender();
});

Hooks.on("canvasTearDown", () => {
  Runner.deactivate();
});

Hooks.on("canvasPan", (_canvas, view) => {
  if ( view?.scale === lastScale ) return;
  lastScale = view?.scale;
  canvas[LAYER_NAME]?.scheduleRefresh();
});

/* -------------------------------------------- */
/*  Document hooks                              */
/* -------------------------------------------- */

const touchesModuleFlags = changed => foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`);

Hooks.on("updateToken", (doc, changed, options) => {
  if ( !touchesModuleFlags(changed) ) return;
  Playback.track(doc);
  Runner.sync(doc);
  const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
  if ( pb?.gid ) groupMemory.set(doc.uuid, pb.gid);
  else if ( groupMemory.has(doc.uuid) ) {
    // Whoever stopped a source (GM, player, a manual move), its symmetry copies stop with it; the GM tidies up
    const gid = groupMemory.get(doc.uuid);
    groupMemory.delete(doc.uuid);
    if ( game.users.activeGM?.isSelf && !doc.getFlag(MODULE_ID, FLAG_COPY) ) Playback.cleanupGroup(doc.parent, gid);
  }
  if ( doc.parent === canvas.scene ) {
    AnimatorPanel.instance?.requestRender(["sidebar", "editor", "transport"]);
    canvas[LAYER_NAME]?.scheduleRefresh();
    const hud = canvas.tokens?.hud;
    if ( hud?.rendered && (hud.object?.document === doc) ) hud.render();
  }
});

Hooks.on("createToken", doc => {
  Playback.track(doc);
  Runner.sync(doc);
});

Hooks.on("deleteToken", (doc, options) => {
  Playback.untrack(doc);
  Runner.release(doc.id);
  if ( !options?.[OPT_KEY] && game.users.activeGM?.isSelf ) {
    const copy = doc.getFlag(MODULE_ID, FLAG_COPY);
    if ( copy ) Playback.markRemoved(doc.parent, copy).catch(err => console.error(err));
    else Store.forgetToken(doc.parent, doc.id).catch(err => console.error(err));
  }
  const gid = groupMemory.get(doc.uuid);
  groupMemory.delete(doc.uuid);
  if ( gid && !options?.[OPT_KEY] && game.users.activeGM?.isSelf && !doc.getFlag(MODULE_ID, FLAG_COPY) ) {
    Playback.cleanupGroup(doc.parent, gid);
  }
  if ( doc.parent === canvas.scene ) AnimatorPanel.instance?.requestRender();
});

Hooks.on("updateScene", (scene, changed) => {
  if ( !touchesModuleFlags(changed) ) return;
  Store.invalidate();
  // Symmetry settings apply live to tokens that are already playing
  if ( game.users.activeGM?.isSelf ) Playback.reconcileSymmetry(scene);
  if ( scene !== canvas.scene ) return;
  Editor.validate();
  Editor.emit("data");
  canvas[LAYER_NAME]?.scheduleRefresh();
  AnimatorPanel.instance?.requestRender();
});

Hooks.on("controlToken", () => {
  AnimatorPanel.instance?.requestRender(["editor", "transport"]);
});

Hooks.on("renderTokenHUD", onRenderTokenHUD);

/**
 * A manual move of a playing token ends its animation (configurable). Foundry measures moves from the stored
 * position, which stays at the playback's start while a token animates, so the move is cancelled, the token is
 * stopped where it visibly is, and the move is issued again from there (arrow keys move relative to that spot).
 */
Hooks.on("preMoveToken", (doc, move, options) => {
  if ( options[OPT_KEY] || options[`${OPT_KEY}.reissue`] ) return;
  if ( !doc.getFlag(MODULE_ID, FLAG_PLAYBACK) ) return;
  if ( !game.settings.get(MODULE_ID, "interruptOnMove") ) return;
  const waypoints = [...(move.passed?.waypoints ?? []), ...(move.pending?.waypoints ?? [])].filter(w => !w.intermediate);
  const last = waypoints.at(-1);
  if ( !last ) return;
  const keyboard = move.method === "keyboard";
  const delta = {x: last.x - move.origin.x, y: last.y - move.origin.y};
  const isCopy = !!doc.getFlag(MODULE_ID, FLAG_COPY);
  (async () => {
    // A dragged symmetry copy is detached from its group and becomes an ordinary token
    await Playback.stop([doc], {mode: "here", detach: isCopy});
    if ( !doc.parent?.tokens.has(doc.id) ) return;
    let target;
    if ( keyboard ) {
      const p = {x: doc._source.x + delta.x, y: doc._source.y + delta.y, elevation: doc._source.elevation};
      const snapped = canvas.grid?.isGridless ? p : doc.getSnappedPosition(p);
      target = [{x: Math.round(snapped.x), y: Math.round(snapped.y)}];
    } else target = waypoints.map(w => ({x: w.x, y: w.y, elevation: w.elevation, action: w.action}));
    await doc.move(target, {autoRotate: move.autoRotate, showRuler: move.showRuler, [`${OPT_KEY}.reissue`]: true});
  })().catch(err => console.error(`${MODULE_ID} | Could not hand the move back`, err));
  return false;
});
