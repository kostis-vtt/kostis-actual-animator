// The animator control panel.

import {ART_FACING, EASE_PRESETS, HOMING_TARGETS, FACING_MODES, FLAG_PLAYBACK, LAYER_NAME, MODULE_ID, MODULE_TITLE, PALETTE,
  SHAPE_TYPES, SPEED_UNITS, TOOLS} from "./const.js";
import {Editor} from "./editor.js";
import {ChoiceGuard, rememberPosition, savePosition, savedPosition} from "./window-ui.js";
import {ACCESS_MODES, Store, defaultStep, firstGeometricStep, isGeometric, newId, animationCenter, transformAnimation,
  translateAnimation} from "./model.js";
import {LIFT_MODES} from "./lift.js";
import {SYMMETRY_MODES} from "./symmetry.js";
import {TEMPLATE_CATEGORIES} from "./templates.js";
import {TemplateGallery} from "./gallery.js";
import {animationSVG} from "./thumbs.js";
import {buildShape, shapeToPath, translateShape} from "./shapes.js";
import {compileTimeline, stepEndpoints} from "./timeline.js";
import {Playback, resolveTokens} from "./playback.js";

const {ApplicationV2, HandlebarsApplicationMixin, DialogV2} = foundry.applications.api;
const TPL = `modules/${MODULE_ID}/templates`;

const round = (v, d=2) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** Number fields of each shape type for the inspector. */
const SHAPE_FIELDS = {
  path: [{key: "closed", label: "Closed loop", kind: "checkbox", hint: "Join the last node back to the first"}],
  ellipse: [
    {key: "cx", label: "Centre X"}, {key: "cy", label: "Centre Y"},
    {key: "rx", label: "Radius X", min: 1}, {key: "ry", label: "Radius Y", min: 1},
    {key: "rotation", label: "Rotation °"}, {key: "sweep", label: "Arc °", min: 1, max: 360, hint: "Less than 360 makes an open arc"}
  ],
  rect: [
    {key: "cx", label: "Centre X"}, {key: "cy", label: "Centre Y"},
    {key: "w", label: "Width", min: 1}, {key: "h", label: "Height", min: 1},
    {key: "rotation", label: "Rotation °"}, {key: "radius", label: "Corner radius", min: 0}
  ],
  polygon: [
    {key: "cx", label: "Centre X"}, {key: "cy", label: "Centre Y"},
    {key: "radius", label: "Radius", min: 1}, {key: "sides", label: "Sides", min: 3, max: 48, step: 1},
    {key: "rotation", label: "Rotation °"},
    {key: "star", label: "Star depth %", dtype: "Percent", min: 0, max: 95, hint: "0 = plain polygon"},
    {key: "smooth", label: "Corner smoothing %", dtype: "Percent", min: 0, max: 100}
  ],
  spiral: [
    {key: "cx", label: "Centre X"}, {key: "cy", label: "Centre Y"},
    {key: "r0", label: "Inner radius", min: 0}, {key: "r1", label: "Outer radius", min: 1},
    {key: "turns", label: "Turns", min: 0.1, step: 0.25}, {key: "rotation", label: "Rotation °"},
    {key: "ccw", label: "Counter-clockwise", kind: "checkbox"}
  ],
  wave: [
    {key: "x0", label: "Start X"}, {key: "y0", label: "Start Y"},
    {key: "x1", label: "End X"}, {key: "y1", label: "End Y"},
    {key: "amplitude", label: "Amplitude"}, {key: "wavelength", label: "Wavelength", min: 4},
    {key: "form", label: "Form", kind: "select", options: {sine: "Smooth sine", zigzag: "Sharp zig-zag"}}
  ],
  figure8: [
    {key: "cx", label: "Centre X"}, {key: "cy", label: "Centre Y"},
    {key: "w", label: "Width", min: 2}, {key: "h", label: "Height", min: 2},
    {key: "rotation", label: "Rotation °"}
  ],
  point: [{key: "x", label: "X"}, {key: "y", label: "Y"}],
  homing: [
    {key: "to", label: "Flies to", kind: "select", options: HOMING_TARGETS},
    {key: "index", label: "Target number", dtype: "Index1", min: 1, step: 1, when: sh => sh.to === "target",
      hint: "Which of your targeted tokens (in the order you targeted them). Symmetry copies take the next ones."},
    {key: "tokenId", label: "Token", kind: "token", when: sh => sh.to === "token"},
    {key: "arc", label: "Curve %", dtype: "Percent", min: -200, max: 200, hint: "How far the flight bows sideways; copies alternate sides"},
    {key: "stop", label: "Stop short (squares)", min: 0, step: 0.25, hint: "Land this far before the destination (e.g. 1 to end beside it)"}
  ]
};

export class AnimatorPanel extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "kaa-panel",
    classes: ["kaa-panel"],
    window: {title: MODULE_TITLE, icon: "fa-solid fa-route", resizable: true},
    position: {width: 960, height: 720},
    actions: {
      newAnim: AnimatorPanel.#onNewAnim,
      selectAnim: AnimatorPanel.#onSelectAnim,
      quickPlay: AnimatorPanel.#onQuickPlay,
      quickStop: AnimatorPanel.#onQuickStop,
      toggleFolder: AnimatorPanel.#onToggleFolder,
      openTemplates: AnimatorPanel.#onOpenTemplates,
      transform: AnimatorPanel.#onTransform,
      importAnim: AnimatorPanel.#onImport,
      exportAnim: AnimatorPanel.#onExport,
      duplicate: AnimatorPanel.#onDuplicate,
      deleteAnim: AnimatorPanel.#onDeleteAnim,
      saveTemplate: AnimatorPanel.#onSaveTemplate,
      updateTemplate: AnimatorPanel.#onUpdateTemplate,
      unlinkTemplate: AnimatorPanel.#onUnlinkTemplate,
      anchorToToken: AnimatorPanel.#onAnchorToToken,
      addHoming: AnimatorPanel.#onAddHoming,
      undo: AnimatorPanel.#onUndo,
      locate: AnimatorPanel.#onLocate,
      moveHere: AnimatorPanel.#onMoveHere,
      switchTab: AnimatorPanel.#onTab,
      tool: AnimatorPanel.#onTool,
      selectStep: AnimatorPanel.#onSelectStep,
      stepUp: AnimatorPanel.#onStepUp,
      stepDown: AnimatorPanel.#onStepDown,
      toggleStep: AnimatorPanel.#onToggleStep,
      deleteStep: AnimatorPanel.#onDeleteStep,
      duplicateStep: AnimatorPanel.#onDuplicateStep,
      convertStep: AnimatorPanel.#onConvertStep,
      nodeStep: AnimatorPanel.#onNodeStep,
      nodePreset: AnimatorPanel.#onNodePreset,
      allNodes: AnimatorPanel.#onAllNodes,
      speedPreset: AnimatorPanel.#onSpeedPreset,
      easePreset: AnimatorPanel.#onEasePreset,
      stepFacing: AnimatorPanel.#onStepFacing,
      pick: AnimatorPanel.#onPick,
      assignSelected: AnimatorPanel.#onAssignSelected,
      unassign: AnimatorPanel.#onUnassign,
      clearTokens: AnimatorPanel.#onClearTokens,
      tokenPlay: AnimatorPanel.#onTokenPlay,
      tokenPause: AnimatorPanel.#onTokenPause,
      tokenStop: AnimatorPanel.#onTokenStop,
      panToken: AnimatorPanel.#onPanToken,
      play: AnimatorPanel.#onPlay,
      playSelected: AnimatorPanel.#onPlaySelected,
      pause: AnimatorPanel.#onPause,
      stop: AnimatorPanel.#onStop,
      restart: AnimatorPanel.#onRestart,
      ghost: AnimatorPanel.#onGhost,
      stopAll: AnimatorPanel.#onStopAll,
      pauseAll: AnimatorPanel.#onPauseAll,
      color: AnimatorPanel.#onColor
    }
  };

  static PARTS = {
    sidebar: {template: `${TPL}/sidebar.hbs`, scrollable: [".kaa-list"]},
    editor: {template: `${TPL}/editor.hbs`, scrollable: [".kaa-tab-body"]},
    transport: {template: `${TPL}/transport.hbs`}
  };

  /* -------------------------------------------- */

  static #instance = null;

  static get instance() {
    return this.#instance;
  }

  /**
   * Open (or bring forward) the panel.
   * @param {object} [options]
   * @param {string} [options.animId]   Select this animation
   * @param {string} [options.tab]      Switch to this tab
   * @param {string} [options.tokenId]  Focus the first animation assigned to this token
   * @param {boolean} [options.focus=true]
   */
  static open({animId, tab, tokenId, focus=true}={}) {
    if ( !game.user.isGM ) {
      ui.notifications.warn("KAA.Warn.GMOnly", {localize: true});
      return null;
    }
    const app = this.#instance ??= new this({position: savedPosition(this.DEFAULT_OPTIONS.id)});
    if ( tokenId ) {
      const anim = Store.all().find(a => a.tokens.includes(tokenId));
      if ( anim ) animId = anim.id;
      else {
        app.#pendingToken = tokenId;
        tab ??= "tokens";
      }
    }
    if ( animId ) Editor.select(animId);
    if ( tab ) app.#tab = tab;
    if ( app.rendered ) {
      app.render();
      if ( focus ) app.bringToFront();
    } else app.render({force: true});
    return app;
  }

  /* -------------------------------------------- */

  #tab = "path";

  #search = "";



  #collapsed = new Set();

  #renderTimer = null;

  #statusTimer = null;

  #pendingToken = null;

  #onEditor = what => {
    if ( what === "preview" ) return;
    // A pick on the map is over: the panel comes back
    if ( (what === "picking") && !Editor.picking && this.#pickCollapse ) this.#restoreAfterPick();
    this.requestRender();
  };

  /** Never redraw under an open dropdown (it would snap shut). */
  #choices = new ChoiceGuard(() => this.render());

  /** The panel's collapsing while it is tucked away for a pick on the map. */
  #pickCollapse = null;

  /** Picks that end with one click on the map: the panel steps aside for them. */
  static #SINGLE_PICKS = new Set(["facePoint", "faceToken", "anchorToken", "homingToken", "symPoint"]);

  #collapseForPick() {
    if ( !this.rendered || this.minimized ) return;
    this.#pickCollapse = Promise.resolve(this.minimize()).catch(() => null);
  }

  async #restoreAfterPick() {
    const collapsing = this.#pickCollapse;
    this.#pickCollapse = null;
    await collapsing;
    if ( this.rendered && this.minimized ) await this.maximize();
  }

  /** @override */
  render(options, _options) {
    const force = (options === true) || options?.force;
    if ( this.rendered && !force && this.#choices.hold() ) return Promise.resolve(this);
    return super.render(options, _options);
  }

  /** @override */
  setPosition(position) {
    const out = super.setPosition(position);
    rememberPosition(this);
    return out;
  }

  /** @override */
  async close(options={}) {
    // Escape while the panel is tucked away for a pick: cancel the pick and bring it back (Foundry would close it)
    if ( options.closeKey && this.#pickCollapse ) {
      Editor.setPicking(null);
      return this;
    }
    return super.close(options);
  }

  /** Parts awaiting a debounced render: undefined = none, null = all, Set = some. */
  #pendingParts = undefined;

  /** Debounced render of all (or some) parts. */
  requestRender(parts) {
    if ( !this.rendered ) return;
    if ( !parts ) this.#pendingParts = null;
    else if ( this.#pendingParts !== null ) {
      this.#pendingParts ??= new Set();
      for ( const p of parts ) this.#pendingParts.add(p);
    }
    clearTimeout(this.#renderTimer);
    this.#renderTimer = setTimeout(() => {
      const p = this.#pendingParts;
      this.#pendingParts = undefined;
      if ( this.rendered ) this.render(p ? {parts: [...p]} : {});
    }, 40);
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    Editor.on(this.#onEditor);
    this.element.addEventListener("change", this.#onChange.bind(this));
    this.element.addEventListener("input", this.#onInput.bind(this));
    this.#choices.watch(this.element);
    this.#statusTimer = setInterval(() => this.#updateLiveStatus(), 250);
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    savePosition(this);
    Editor.off(this.#onEditor);
    clearInterval(this.#statusTimer);
    clearTimeout(this.#renderTimer);
    if ( Editor.ghost ) {
      Editor.ghost = false;
      Editor.emit("ghost");
    }
    AnimatorPanel.#instance = null;
  }

  /* -------------------------------------------- */
  /*  Context                                     */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(_options) {
    const scene = canvas.scene;
    Editor.validate();
    const ctx = {
      scene: !!scene,
      sceneName: scene?.name ?? "",
      canEdit: Store.canEdit(scene),
      tab: this.#tab,
      tabs: [
        {id: "path", label: "Path & shapes", icon: "fa-solid fa-bezier-curve"},
        {id: "motion", label: "Motion", icon: "fa-solid fa-gauge-high"},
        {id: "facing", label: "Facing", icon: "fa-solid fa-compass"},
        {id: "symmetry", label: "Symmetry", icon: "fa-solid fa-snowflake"},
        {id: "tokens", label: "Tokens", icon: "fa-solid fa-users"}
      ].map(t => ({...t, active: t.id === this.#tab}))
    };
    if ( !scene ) return ctx;

    const all = Store.all(scene);
    const playing = Playback.playing(scene);
    const playMap = new Map();
    for ( const d of playing ) {
      const pb = d.getFlag(MODULE_ID, FLAG_PLAYBACK);
      const e = playMap.get(pb.anim) ?? {count: 0, paused: 0};
      e.count++;
      if ( pb.paused ) e.paused++;
      playMap.set(pb.anim, e);
    }

    // Sidebar
    const groups = new Map();
    const q = this.#search.trim().toLowerCase();
    ctx.search = this.#search;
    for ( const a of all ) {
      const pl = playMap.get(a.id);
      const tokenCount = a.tokens.filter(id => scene.tokens.has(id)).length;
      const search = `${a.name} ${a.folder}`.toLowerCase();
      const row = {
        id: a.id, name: a.name, color: a.color, folder: a.folder,
        steps: a.steps.length,
        tokens: tokenCount,
        selected: a.id === Editor.animId,
        playing: pl?.count ?? 0,
        paused: !!pl && (pl.paused === pl.count),
        search,
        hidden: !!q && !search.includes(q),
        sub: [`${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`,
          `${tokenCount} token${tokenCount === 1 ? "" : "s"}`].join(" · ")
      };
      const key = a.folder.trim();
      if ( !groups.has(key) ) groups.set(key, []);
      groups.get(key).push(row);
    }
    ctx.groups = [...groups.entries()].sort(([a], [b]) => (a === "") - (b === "") || a.localeCompare(b)).map(([name, rows]) => ({
      name, label: name || "Animations", rows, count: rows.length, collapsed: this.#collapsed.has(name), named: !!name
    }));
    ctx.empty = !all.length;
    ctx.scenePlaying = playing.length;

    // Selected animation
    const anim = Editor.anim;
    ctx.anim = anim ? this.#animContext(anim, scene, playMap) : null;
    ctx.opts = this.#optsContext();
    ctx.tools = Object.entries(TOOLS).map(([name, t]) => ({
      name, icon: t.icon, title: t.title,
      active: canvas[LAYER_NAME]?.active && (game.activeTool === name)
    }));
    ctx.transport = this.#transportContext(anim, scene, playMap);
    ctx.picking = Editor.picking?.mode ?? null;
    return ctx;
  }

  #optsContext() {
    const o = Editor.opts;
    return {
      snap: o.snap,
      penSmooth: Math.round(o.penSmooth * 100),
      polygonSides: o.polygonSides,
      polygonStar: Math.round(o.polygonStar * 100),
      spiralTurns: o.spiralTurns,
      spiralInner: Math.round(o.spiralInner * 100),
      waveForm: o.waveForm,
      waveAmplitude: o.waveAmplitude,
      waveLength: o.waveLength,
      pointWait: o.pointWait / 1000
    };
  }

  #animContext(anim, scene, playMap) {
    const dims = scene.dimensions;
    const unitsPerPx = (dims.distance || 1) / dims.size;
    const units = scene.grid.units || "u";
    const fmtLen = px => `${round(px * unitsPerPx, 1)} ${units}`;

    // Steps
    let totalLen = 0;
    const steps = anim.steps.map((s, i) => {
      const built = buildShape(s.shape);
      const L = built.lut.length;
      if ( s.enabled ) totalLen += L * (built.closed ? s.laps : Math.max(1, Math.round(s.laps)));
      const type = SHAPE_TYPES[s.shape.type];
      const homing = !isGeometric(s);
      const homingLabel = homing ? ({target: `to target ${s.shape.index + 1}`, home: "back to its start", anchor: "to the anchor",
        token: `to ${scene.tokens.get(s.shape.tokenId)?.name ?? "a token"}`}[s.shape.to]) : null;
      return {
        id: s.id, num: i + 1, label: s.label || (homing ? `Homing leg ${homingLabel}` : type.label), icon: type.icon, type: s.shape.type,
        enabled: s.enabled, selected: s.id === Editor.stepId, closed: built.closed,
        length: homing ? "live" : (s.shape.type === "point" ? "stop" : fmtLen(L)),
        laps: s.laps, reverse: s.reverse, wait: round(s.wait / 1000, 2), teleport: s.connector === "teleport",
        first: i === 0, last: i === anim.steps.length - 1, hasFacing: !!s.facing, speedMul: s.speedMul,
        nodes: s.shape.type === "path" ? s.shape.nodes.length : null
      };
    });

    // Timing estimate
    let stats = null;
    const first = anim.steps.find(s => s.enabled);
    if ( first ) {
      try {
        const geo = firstGeometricStep(anim);
        const layer = canvas[LAYER_NAME];
        const assigned = scene.tokens.get(anim.tokens.find(t => scene.tokens.has(t)));
        const origin = geo ? stepEndpoints(geo).start
          : (assigned ? assigned.getCenterPoint({x: assigned._source.x, y: assigned._source.y}) : {x: 0, y: 0});
        const tl = compileTimeline(anim, {origin, dims: {size: dims.size, distance: dims.distance || 1},
          resolve: spec => layer?.homingPreviewEnd(anim, spec) ?? null});
        stats = {
          length: fmtLen(totalLen),
          cycle: `${round(tl.cycleDuration / 1000, 2)} s`,
          total: tl.infinite ? "∞ (endless)" : `${round(tl.duration / 1000, 2)} s`
        };
      } catch(err) {
        console.error(err);
      }
    }

    // Selected step inspector
    const stepData = anim.steps.find(s => s.id === Editor.stepId);
    let step = null;
    if ( stepData ) {
      const built = buildShape(stepData.shape);
      const idx = anim.steps.indexOf(stepData);
      const sh = stepData.shape;
      const tokenChoices = Object.fromEntries(scene.tokens.contents.map(t => [t.id, t.name]));
      const fields = (SHAPE_FIELDS[sh.type] ?? []).filter(f => !f.when || f.when(sh)).map(f => {
        const raw = sh[f.key];
        let value = raw;
        if ( f.kind === "token" ) f = {...f, kind: "select", options: {"": "— choose —", ...tokenChoices}};
        if ( f.dtype === "Percent" ) value = Math.round(raw * 100);
        else if ( f.dtype === "Index1" ) value = raw + 1;
        else if ( typeof raw === "number" ) value = round(raw, 2);
        return {
          ...f, name: `shape.${f.key}`, value, checked: f.kind === "checkbox" ? !!raw : undefined,
          dtype: f.dtype ?? (f.kind === "checkbox" ? "Boolean" : (f.kind === "select" ? "String" : "Number")),
          isCheckbox: f.kind === "checkbox", isSelect: f.kind === "select",
          options: f.options ? Object.entries(f.options).map(([k, label]) => ({value: k, label, selected: k === raw})) : null,
          step: f.step ?? "any"
        };
      });
      step = {
        id: stepData.id, num: idx + 1, first: idx === 0, label: stepData.label, typeLabel: SHAPE_TYPES[sh.type].label,
        icon: SHAPE_TYPES[sh.type].icon, type: sh.type, enabled: stepData.enabled,
        closed: built.closed, isPath: sh.type === "path", isPoint: sh.type === "point",
        canConvert: !["path", "point", "homing"].includes(sh.type),
        isHoming: sh.type === "homing",
        homingToken: sh.type === "homing" && sh.to === "token",
        reverse: stepData.reverse, startOffset: Math.round(stepData.startOffset * 1000) / 10,
        laps: stepData.laps, lapsLabel: built.closed ? "Laps" : "Passes",
        lapsHint: built.closed ? "Times around the loop (fractions allowed, e.g. 0.5 = half way)"
          : "Each extra pass reverses direction (there and back)",
        speedMul: stepData.speedMul, wait: round(stepData.wait / 1000, 2), connector: stepData.connector,
        length: fmtLen(built.lut.length), fields,
        facing: stepData.facing ? this.#facingContext(stepData.facing, "sfacing", scene, anim) : null,
        lift: this.#liftContext(stepData, built)
      };
      if ( sh.type === "path" ) {
        const sel = Editor.sel;
        step.nodeCount = sh.nodes.length;
        if ( (sel?.type === "node") && sh.nodes[sel.index] ) {
          const n = sh.nodes[sel.index];
          step.node = {
            index: sel.index, num: sel.index + 1, x: round(n.x), y: round(n.y),
            smooth: Math.round((n.smooth || 0) * 100), manual: n.mode === "manual",
            corner: (n.mode === "auto") && !(n.smooth > 0)
          };
        }
        if ( (sel?.type === "segment") && sh.nodes[sel.index] ) {
          step.segment = {index: sel.index, num: sel.index + 1, nextNum: ((sel.index + 1) % sh.nodes.length) + 1,
            bend: Math.round((sh.nodes[sel.index].bend || 0) * 100)};
        }
      }
    }

    // Tokens
    const tokens = anim.tokens.map(id => {
      const doc = scene.tokens.get(id);
      if ( !doc ) return {id, missing: true, name: "Missing token"};
      const st = Playback.status(doc);
      const mine = st.playing && (st.anim?.id === anim.id);
      return {
        id, name: doc.name, img: doc.texture.src, playing: mine, paused: mine && st.paused,
        other: st.playing && !mine ? (st.anim?.name ?? "another animation") : null,
        progress: mine ? Math.round((st.progress ?? 0) * 100) : 0,
        lockRotation: doc.lockRotation
      };
    });
    const pending = this.#pendingToken && scene.tokens.get(this.#pendingToken);
    const lockWarn = (anim.facing.mode !== "keep") && tokens.some(t => t.lockRotation);
    const m = anim.motion;
    const infinite = (m.loop !== "none") && (m.loopCount === 0);

    return {
      ...anim,
      steps, step, stats,
      hasSteps: steps.length > 0,
      canUndo: Store.canUndo(anim.id),
      palette: PALETTE.map(c => ({color: c, active: c === anim.color})),
      motion: {
        ...m,
        easeIn: round(m.easeIn / 1000, 2), easeOut: round(m.easeOut / 1000, 2), loopGap: round(m.loopGap / 1000, 2),
        units: Object.entries(SPEED_UNITS).map(([k, label]) => ({value: k, label: k === "units" ? `${units} / s` : label, selected: k === m.speedUnit})),
        loopNone: m.loop === "none", loopLoop: m.loop === "loop", loopPing: m.loop === "pingpong",
        absolute: m.anchor === "absolute", relative: m.anchor === "relative", follow: m.anchor === "token", infinite,
        anchorChoices: [{value: "target", label: "The first token I target (T) when playing", selected: m.anchorToken === "target"},
          ...scene.tokens.contents.map(t => ({value: t.id, label: t.name, selected: t.id === m.anchorToken}))],
        easePresets: Object.entries(EASE_PRESETS).map(([k, p]) => ({key: k, label: p.label,
          active: (p.in === m.easeIn) && (p.out === m.easeOut)}))
      },
      stagger: {...anim.stagger, delay: round(anim.stagger.delay / 1000, 2)},
      facing: this.#facingContext(anim.facing, "facing", scene, anim),
      symmetry: this.#symmetryContext(anim),
      height: {
        scale: Math.round(anim.height.scale * 100), rise: Math.round(anim.height.rise * 100),
        shadow: anim.height.shadow, elevation: anim.height.elevation,
        used: anim.steps.some(st => st.lift.mode !== "none")
      },
      transformTarget: stepData ? `step ${anim.steps.indexOf(stepData) + 1}` : "the whole animation",
      template: (() => {
        const t = anim.templateId ? Store.library().find(x => x.id === anim.templateId) : null;
        return t ? {id: t.id, name: t.name} : null;
      })(),
      relative: anim.motion.anchor === "relative",
      anchorToken: (() => {
        const id = anim.tokens.find(t => scene.tokens.has(t)) ?? canvas.tokens.controlled[0]?.id;
        return id ? scene.tokens.get(id)?.name : null;
      })(),
      tokens, lockWarn,
      access: {
        modes: Object.entries(ACCESS_MODES).map(([value, label]) => ({value, label, selected: value === anim.access.mode})),
        chosen: anim.access.mode === "players",
        players: game.users.filter(u => !u.isGM).map(u => ({id: u.id, name: u.name, checked: anim.access.users.includes(u.id)}))
      },
      pendingToken: pending ? {id: pending.id, name: pending.name} : null,
      selectedCount: canvas.tokens.controlled.length,
      playingCount: playMap.get(anim.id)?.count ?? 0
    };
  }

  #facingContext(f, prefix, scene, anim) {
    const tokenOptions = scene.tokens.contents
      .filter(t => !anim.tokens.includes(t.id) || (t.id === f.tokenId))
      .map(t => ({id: t.id, name: t.name, selected: t.id === f.tokenId}))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rules = {nearest: "Nearest", farthest: "Farthest", mostDamaged: "Most wounded", leastDamaged: "Least wounded"};
    const groups = {enemies: "Enemies", allies: "Allies", players: "Player characters", all: "Any token",
      custom: "My chosen group"};
    const custom = f.target.tokens.map(id => scene.tokens.get(id)?.name).filter(Boolean);
    return {
      prefix, ...f,
      modes: Object.entries(FACING_MODES).map(([k, v]) => ({key: k, ...v, active: k === f.mode})),
      arts: Object.entries(ART_FACING).map(([k, v]) => ({key: k, label: v.label, active: k === f.art,
        icon: {down: "fa-arrow-down", up: "fa-arrow-up", left: "fa-arrow-left", right: "fa-arrow-right"}[k]})),
      isPath: f.mode === "path", isSpin: f.mode === "spin", isFixed: f.mode === "fixed",
      isPoint: f.mode === "point", isToken: f.mode === "token", isCenter: f.mode === "center",
      isTurn: f.mode === "turn", isTarget: f.mode === "target",
      usesArt: ["path", "center", "point", "token", "target"].includes(f.mode),
      usesTurnRate: ["path", "center", "point", "token", "target", "turn"].includes(f.mode),
      pointLabel: f.point ? `${Math.round(f.point.x)}, ${Math.round(f.point.y)}` : "not set",
      tokenOptions,
      target: {
        ...f.target,
        rules: Object.entries(rules).map(([value, label]) => ({value, label, selected: value === f.target.rule})),
        groups: Object.entries(groups).map(([value, label]) => ({value, label, selected: value === f.target.group})),
        isCustom: f.target.group === "custom",
        customLabel: custom.length ? custom.slice(0, 4).join(", ") + (custom.length > 4 ? ` +${custom.length - 4}` : "") : "nobody yet",
        usesHealth: ["mostDamaged", "leastDamaged"].includes(f.target.rule)
      },
      hint: FACING_MODES[f.mode]?.hint
    };
  }

  #liftContext(step, built) {
    const l = step.lift;
    const isPoint = (step.shape.type === "point") || (built.lut.length < 0.5);
    return {
      ...l,
      decay: Math.round(l.decay * 100),
      on: l.mode !== "none",
      modes: Object.entries(LIFT_MODES).map(([key, v]) => ({key, ...v, active: key === l.mode})),
      showCount: ["hops", "bounce", "skip"].includes(l.mode),
      showDecay: ["bounce", "skip"].includes(l.mode),
      showFreq: l.mode === "bob",
      hint: LIFT_MODES[l.mode]?.hint,
      needsWait: isPoint && !["none", "bob"].includes(l.mode) && !(step.wait > 0)
    };
  }

  #symmetryContext(anim) {
    const y = anim.symmetry;
    return {
      ...y,
      modes: Object.entries(SYMMETRY_MODES).map(([key, v]) => ({key, ...v, active: key === y.mode})),
      isMirror: y.mode === "mirror",
      centerOrigin: y.center === "origin", centerPath: y.center === "path", centerPoint: y.center === "point",
      pointLabel: y.point ? `${Math.round(y.point.x)}, ${Math.round(y.point.y)}` : "not set",
      copies: y.count - 1,
      on: y.count > 1,
      canSpawn: game.user.can("TOKEN_CREATE"),
      svg: animationSVG(anim, {width: 320, height: 200})
    };
  }

  #transportContext(anim, scene, playMap) {
    const pl = anim ? playMap.get(anim.id) : null;
    return {
      hasAnim: !!anim,
      playing: pl?.count ?? 0,
      allPaused: !!pl && (pl.paused === pl.count),
      rate: Editor.rate,
      rateLabel: `${round(Editor.rate, 2)}×`,
      ghost: Editor.ghost,
      assigned: anim ? anim.tokens.filter(id => scene.tokens.has(id)).length : 0,
      selected: canvas.tokens.controlled.length
    };
  }

  /* -------------------------------------------- */
  /*  Live status                                 */
  /* -------------------------------------------- */

  #updateLiveStatus() {
    if ( !this.rendered || !canvas.scene ) return;
    for ( const el of this.element.querySelectorAll("[data-progress-token]") ) {
      const doc = canvas.scene.tokens.get(el.dataset.progressToken);
      const st = Playback.status(doc);
      const bar = el.querySelector(".kaa-progress-fill");
      if ( bar ) bar.style.width = `${Math.round((st.progress ?? 0) * 100)}%`;
      const label = el.querySelector(".kaa-progress-label");
      if ( label ) {
        if ( !st.playing ) label.textContent = "idle";
        else if ( st.paused ) label.textContent = "paused";
        else if ( st.infinite ) label.textContent = `loop ${st.cycles + 1}`;
        else label.textContent = `${Math.round((st.progress ?? 0) * 100)}%`;
      }
    }
  }

  /* -------------------------------------------- */
  /*  Form handling                               */
  /* -------------------------------------------- */

  static #parse(el) {
    const dtype = el.dataset.dtype;
    if ( el.type === "checkbox" ) return el.checked;
    const raw = el.value;
    switch ( dtype ) {
      case "Number": {
        const n = Number(raw);
        return Number.isFinite(n) && (raw !== "") ? n : undefined;
      }
      case "Percent": {
        const n = Number(raw);
        return Number.isFinite(n) && (raw !== "") ? n / 100 : undefined;
      }
      case "Index1": {
        const n = Math.round(Number(raw));
        return Number.isFinite(n) && (raw !== "") ? Math.max(0, n - 1) : undefined;
      }
      case "Seconds": {
        const n = Number(raw);
        return Number.isFinite(n) && (raw !== "") ? n * 1000 : undefined;
      }
      default:
        return raw;
    }
  }

  /** Apply a named field to a (cloned) animation. */
  static #applyField(anim, name, value) {
    const [scope, ...rest] = name.split(".");
    const key = rest.join(".");
    const step = anim.steps.find(s => s.id === Editor.stepId);
    const set = (obj, k, v) => foundry.utils.setProperty(obj, k, v);
    switch ( scope ) {
      case "anim":
        anim[key] = value;
        break;
      case "motion":
        anim.motion[key] = value;
        break;
      case "stagger":
        anim.stagger[key] = value;
        break;
      case "symmetry":
        anim.symmetry[key] = value;
        break;
      case "height":
        anim.height[key] = value;
        break;
      case "access":
        if ( key === "mode" ) anim.access.mode = value;
        else if ( key.startsWith("user.") ) {
          const id = key.slice(5);
          const users = new Set(anim.access.users);
          if ( value ) users.add(id);
          else users.delete(id);
          anim.access.users = [...users];
        } else return false;
        break;
      case "facing":
        set(anim.facing, key, value);
        break;
      case "sfacing":
        if ( !step ) return false;
        step.facing ??= foundry.utils.deepClone(anim.facing);
        set(step.facing, key, value);
        break;
      case "lift":
        if ( !step ) return false;
        step.lift[key] = value;
        break;
      case "step":
        if ( !step ) return false;
        step[key] = value;
        break;
      case "shape":
        if ( !step ) return false;
        step.shape[key] = value;
        break;
      case "node": {
        const sel = Editor.sel;
        const node = step?.shape.nodes?.[sel?.index];
        if ( !node ) return false;
        if ( key === "smooth" ) {
          node.smooth = value;
          node.mode = "auto";
          node.hin = node.hout = null;
        } else node[key] = value;
        break;
      }
      case "segment": {
        const node = step?.shape.nodes?.[Editor.sel?.index];
        if ( !node ) return false;
        node.bend = value;
        break;
      }
      default:
        return false;
    }
    return true;
  }

  /** Live preview while dragging sliders. */
  #onInput(event) {
    const el = event.target;
    if ( el.name === "search" ) {
      this.#search = el.value;
      const q = el.value.trim().toLowerCase();
      for ( const row of this.element.querySelectorAll(".kaa-anim-row") ) {
        row.hidden = !!q && !row.dataset.search.includes(q);
      }
      return;
    }
    const out = el.closest(".kaa-range")?.querySelector(".kaa-range-value");
    if ( out ) out.textContent = el.value + (el.dataset.suffix ?? "");
    if ( el.name === "symmetry.count" ) {
      const big = this.element.querySelector(".kaa-sym-n");
      if ( big ) big.textContent = el.value;
    }
    if ( el.name === "rate" ) return;
    if ( el.type !== "range" ) return;
    const anim = Editor.anim;
    if ( !anim ) return;
    const value = AnimatorPanel.#parse(el);
    if ( value === undefined ) return;
    const copy = foundry.utils.deepClone(anim);
    if ( AnimatorPanel.#applyField(copy, el.name, value) ) Editor.setPreview(copy);
  }

  async #onChange(event) {
    const el = event.target;
    const name = el.name;
    if ( !name || (name === "search") ) return;
    // A chosen tile lets go of the focus: every tile of a group shares a name, so after the redraw Foundry would focus
    // (and scroll to) the group's first tile instead
    if ( el.type === "radio" ) el.blur?.();
    const value = AnimatorPanel.#parse(el);
    if ( value === undefined ) return;

    if ( name === "rate" ) {
      Editor.rate = value;
      Editor.emit("rate");
      const anim = Editor.anim;
      if ( anim ) await Playback.setRate(Playback.playing(canvas.scene, anim.id), value);
      this.requestRender(["transport"]);
      return;
    }
    if ( name.startsWith("opts.") ) {
      await Editor.setOpt(name.slice(5), value);
      return;
    }
    const anim = Editor.anim;
    if ( !anim ) return;
    const copy = foundry.utils.deepClone(Store.get(anim.id) ?? anim);
    if ( !AnimatorPanel.#applyField(copy, name, value) ) return;
    await Store.save(copy);
    if ( Editor.preview ) Editor.setPreview(null);
  }

  /* -------------------------------------------- */
  /*  Helpers                                     */
  /* -------------------------------------------- */

  /** Activate the animator layer with a given tool. */
  static activateTool(tool="kaaEdit") {
    const layer = canvas[LAYER_NAME];
    if ( !layer ) return;
    if ( layer.active ) ui.controls.activate({control: LAYER_NAME, tool});
    else layer.activate({tool});
  }

  /** Tokens an animation should play on: assigned ones, otherwise the selected ones. */
  static #targets(anim) {
    const assigned = anim.tokens.filter(id => canvas.scene.tokens.has(id));
    if ( assigned.length ) return assigned;
    return canvas.tokens.controlled.map(t => t.document);
  }

  /* -------------------------------------------- */
  /*  Actions: library & sidebar                  */
  /* -------------------------------------------- */

  static async #onNewAnim() {
    const anim = await Store.create({});
    if ( !anim ) return;
    Editor.select(anim.id);
    this.#tab = "path";
    // Pre-assign selected tokens for convenience
    const selected = canvas.tokens.controlled.map(t => t.id);
    if ( selected.length ) await Store.mutate(anim.id, a => {
      a.tokens = selected;
    }, {undo: false});
    AnimatorPanel.activateTool("kaaPen");
    ui.notifications.info("KAA.Info.DrawNow", {localize: true});
  }

  static #onSelectAnim(_event, target) {
    Editor.select(target.closest("[data-anim-id]").dataset.animId);
  }

  static async #onQuickPlay(event, target) {
    event.stopPropagation();
    const anim = Store.get(target.closest("[data-anim-id]").dataset.animId);
    if ( anim ) await Playback.play(anim, AnimatorPanel.#targets(anim), {rate: Editor.rate});
  }

  static async #onQuickStop(event, target) {
    event.stopPropagation();
    const id = target.closest("[data-anim-id]").dataset.animId;
    await Playback.stop(Playback.playing(canvas.scene, id));
  }

  static #onToggleFolder(_event, target) {
    const name = target.dataset.folder ?? "";
    if ( this.#collapsed.has(name) ) this.#collapsed.delete(name);
    else this.#collapsed.add(name);
    this.render({parts: ["sidebar"]});
  }

  static #onOpenTemplates(_event, target) {
    TemplateGallery.open({category: target?.dataset?.category ?? "all"});
  }

  /** Rotate or scale the selected step (or the whole animation) around its centre. */
  static async #onTransform(_event, target) {
    const anim = Editor.anim;
    if ( !anim ) return;
    const step = Editor.step;
    const ops = {rotL: {rotate: -15}, rotR: {rotate: 15}, rot90: {rotate: 90}, shrink: {scale: 0.9}, grow: {scale: 1.1}};
    const op = ops[target.dataset.op];
    if ( !op ) return;
    const about = step ? buildShape(step.shape).center : (animationCenter(anim) ?? {x: 0, y: 0});
    await Store.save(transformAnimation(anim, {...op, about, stepIds: step ? [step.id] : undefined}));
  }

  static async #onImport() {
    const result = await DialogV2.input({
      window: {title: "Import animation", icon: "fa-solid fa-file-import"},
      classes: ["kaa-dialog"],
      position: {width: 520},
      content: `<p class="kaa-muted">Paste animation JSON exported from this module.</p>
        <textarea name="json" rows="12" style="width:100%;font-family:monospace;font-size:11px"></textarea>
        <label class="kaa-check"><input type="checkbox" name="center" checked> Place at the centre of the current view</label>`,
      ok: {label: "Import", icon: "fa-solid fa-file-import"}
    });
    if ( !result?.json ) return;
    try {
      let data = JSON.parse(result.json);
      if ( data?.module === MODULE_ID ) data = data.animation;
      if ( !Array.isArray(data?.steps) ) throw new Error("Not an animation");
      const at = result.center ? {x: canvas.stage.pivot.x, y: canvas.stage.pivot.y} : null;
      const created = await Store.insert(data, {at});
      if ( created ) Editor.select(created.id);
    } catch(err) {
      ui.notifications.error(`Import failed: ${err.message}`);
    }
  }

  static async #onExport() {
    const anim = Editor.anim;
    if ( !anim ) return;
    const data = {module: MODULE_ID, version: game.modules.get(MODULE_ID).version, animation: {...anim, tokens: []}};
    const json = JSON.stringify(data, null, 2);
    await DialogV2.wait({
      window: {title: `Export: ${anim.name}`, icon: "fa-solid fa-file-export"},
      classes: ["kaa-dialog"],
      position: {width: 560},
      content: `<textarea readonly rows="16" style="width:100%;font-family:monospace;font-size:11px">${foundry.utils.escapeHTML(json)}</textarea>`,
      buttons: [
        {action: "copy", label: "Copy", icon: "fa-solid fa-copy", callback: () => {
          game.clipboard.copyPlainText(json);
          ui.notifications.info("Copied to clipboard.");
        }},
        {action: "download", label: "Download", icon: "fa-solid fa-download", callback: () => {
          foundry.utils.saveDataToFile(json, "application/json", `${anim.name.slugify() || "animation"}.kaa.json`);
        }},
        {action: "close", label: "Close", default: true}
      ]
    });
  }

  static async #onDuplicate() {
    const anim = Editor.anim;
    if ( !anim ) return;
    const copy = await Store.duplicate(anim.id);
    if ( copy ) Editor.select(copy.id);
  }

  static async #onDeleteAnim() {
    const anim = Editor.anim;
    if ( !anim ) return;
    const ok = await DialogV2.confirm({
      window: {title: "Delete animation"},
      content: `<p>Delete <strong>${foundry.utils.escapeHTML(anim.name)}</strong>? Tokens playing it will stop where they are.</p>`
    });
    if ( !ok ) return;
    await Playback.stop(Playback.playing(canvas.scene, anim.id));
    await Store.delete(anim.id);
    Editor.select(null);
  }

  /** Save the selected animation as a reusable template (available on every scene). */
  static async #onSaveTemplate() {
    const anim = Editor.anim;
    if ( !anim ) return;
    const esc = foundry.utils.escapeHTML;
    const options = Object.entries(TEMPLATE_CATEGORIES)
      .map(([k, c]) => `<option value="${k}" ${k === "mine" ? "selected" : ""}>${esc(c.label)}</option>`).join("");
    const result = await DialogV2.input({
      window: {title: "Save as template", icon: "fa-solid fa-book-bookmark"},
      classes: ["kaa-dialog"],
      position: {width: 460},
      content: `<div class="kaa-form">
        <label>Name <input type="text" name="name" value="${esc(anim.name)}" autofocus></label>
        <label>Category <select name="category">${options}</select></label>
        <label>Description <textarea name="description" rows="3" placeholder="What does it do? When would you use it?"></textarea></label>
        <p class="kaa-muted">Templates are stored in grid squares, so they fit any scene. Assigned tokens are not saved.</p>
      </div>`,
      ok: {label: "Save template", icon: "fa-solid fa-floppy-disk"}
    });
    if ( !result?.name ) return;
    const tpl = await Store.saveToLibrary(anim, result);
    // Stay linked, so later edits can be saved back into the template
    if ( tpl ) await Store.mutate(anim.id, a => {
      a.templateId = tpl.id;
    }, {undo: false});
    ui.notifications.info(game.i18n.format("KAA.Info.SavedToLibrary", {name: result.name}));
  }

  /** Save the animation's current state back into the template it came from. */
  static async #onUpdateTemplate() {
    const anim = Editor.anim;
    if ( !anim?.templateId ) return;
    const tpl = await Store.updateTemplate(anim.templateId, anim);
    if ( tpl ) ui.notifications.info(game.i18n.format("KAA.Info.TemplateUpdated", {name: tpl.name}));
  }

  static async #onUnlinkTemplate() {
    const anim = Editor.anim;
    if ( anim ) await Store.mutate(anim.id, a => {
      a.templateId = null;
    }, {undo: false});
  }

  /** Move a relative animation's drawn path so it starts at its first assigned (or the selected) token. */
  static async #onAnchorToToken() {
    const anim = Editor.anim;
    if ( !anim ) return;
    const id = anim.tokens.find(t => canvas.scene.tokens.has(t)) ?? canvas.tokens.controlled[0]?.id;
    const doc = id ? canvas.scene.tokens.get(id) : null;
    const first = firstGeometricStep(anim);
    if ( !doc || !first ) return;
    const start = stepEndpoints(first).start;
    const center = doc.getCenterPoint({x: doc._source.x, y: doc._source.y});
    await Store.save(translateAnimation(anim, center.x - start.x, center.y - start.y));
  }

  /** Add a homing leg: fly to a target, back home, to the anchor or to a specific token. */
  static async #onAddHoming(_event, target) {
    let anim = Editor.anim;
    const to = target.dataset.to ?? "target";
    const step = defaultStep({type: "homing", to, index: 0, arc: to === "home" ? -0.25 : 0.25, stop: 0});
    if ( !anim ) {
      anim = await Store.create({steps: [step], motion: {anchor: "relative"}});
      if ( anim ) Editor.select(anim.id, step.id);
      return;
    }
    await Store.mutate(anim.id, a => {
      a.steps.push(step);
    });
    Editor.select(anim.id, step.id);
  }

  static async #onUndo() {
    const anim = Editor.anim;
    if ( anim ) await Store.undo(anim.id);
  }

  /** Pan the canvas to the animation. */
  static #onLocate() {
    const anim = Editor.anim;
    const c = anim ? animationCenter(anim) : null;
    if ( c ) canvas.animatePan({x: c.x, y: c.y, duration: 400});
  }

  /** Move the whole animation to the centre of the current view. */
  static async #onMoveHere() {
    const anim = Editor.anim;
    const c = anim ? animationCenter(anim) : null;
    if ( !c ) return;
    // translateAnimation also carries facing points, per-step facing points and the symmetry centre
    await Store.save(translateAnimation(anim, canvas.stage.pivot.x - c.x, canvas.stage.pivot.y - c.y));
  }

  static #onTab(_event, target) {
    this.#tab = target.dataset.tab;
    this.render({parts: ["editor"]});
  }

  static async #onColor(_event, target) {
    const anim = Editor.anim;
    if ( anim ) await Store.mutate(anim.id, a => {
      a.color = target.dataset.color;
    });
  }

  /* -------------------------------------------- */
  /*  Actions: path tab                           */
  /* -------------------------------------------- */

  static #onTool(_event, target) {
    AnimatorPanel.activateTool(target.dataset.tool);
    this.requestRender(["editor"]);
  }

  static #onSelectStep(_event, target) {
    const id = target.closest("[data-step-id]").dataset.stepId;
    Editor.select(Editor.animId, Editor.stepId === id ? null : id);
  }

  static async #moveStep(target, delta) {
    const id = target.closest("[data-step-id]").dataset.stepId;
    await Store.mutate(Editor.animId, a => {
      const i = a.steps.findIndex(s => s.id === id);
      const j = i + delta;
      if ( (i < 0) || (j < 0) || (j >= a.steps.length) ) return;
      [a.steps[i], a.steps[j]] = [a.steps[j], a.steps[i]];
    });
  }

  static #onStepUp(event, target) {
    event.stopPropagation();
    return AnimatorPanel.#moveStep(target, -1);
  }

  static #onStepDown(event, target) {
    event.stopPropagation();
    return AnimatorPanel.#moveStep(target, 1);
  }

  static async #onToggleStep(event, target) {
    event.stopPropagation();
    const id = target.closest("[data-step-id]").dataset.stepId;
    await Store.mutate(Editor.animId, a => {
      const s = a.steps.find(x => x.id === id);
      if ( s ) s.enabled = !s.enabled;
    });
  }

  static async #onDeleteStep(event, target) {
    event.stopPropagation();
    const id = target.closest("[data-step-id]").dataset.stepId;
    await Store.mutate(Editor.animId, a => {
      a.steps = a.steps.filter(s => s.id !== id);
    });
    if ( Editor.stepId === id ) Editor.select(Editor.animId, null);
  }

  static async #onDuplicateStep(event, target) {
    event.stopPropagation();
    const id = target.closest("[data-step-id]").dataset.stepId;
    const g = canvas.dimensions.size;
    let newStepId = null;
    await Store.mutate(Editor.animId, a => {
      const i = a.steps.findIndex(s => s.id === id);
      if ( i < 0 ) return;
      const copy = foundry.utils.deepClone(a.steps[i]);
      copy.id = newStepId = newId();
      copy.shape = translateShape(copy.shape, g / 2, g / 2);
      a.steps.splice(i + 1, 0, copy);
    });
    if ( newStepId ) Editor.select(Editor.animId, newStepId);
  }

  static async #onConvertStep() {
    const step = Editor.step;
    if ( !step ) return;
    await Store.mutate(Editor.animId, a => {
      const s = a.steps.find(x => x.id === step.id);
      s.shape = shapeToPath(s.shape);
      s.startOffset = 0;
    });
    ui.notifications.info("KAA.Info.Converted", {localize: true});
  }

  /** Select the previous/next node of a path. */
  static #onNodeStep(_event, target) {
    const step = Editor.step;
    if ( !step || (step.shape.type !== "path") ) return;
    const n = step.shape.nodes.length;
    const cur = Editor.sel?.type === "node" ? Editor.sel.index : -1;
    const next = ((cur + Number(target.dataset.delta)) % n + n) % n;
    Editor.select(Editor.animId, step.id, {type: "node", index: next});
  }

  /** Quick node types: sharp corner / smooth curve / free handles. */
  static async #onNodePreset(_event, target) {
    const step = Editor.step;
    const sel = Editor.sel;
    if ( !step || (sel?.type !== "node") ) return;
    const preset = target.dataset.preset;
    await Store.mutate(Editor.animId, a => {
      const sh = a.steps.find(x => x.id === step.id).shape;
      const n = sh.nodes[sel.index];
      if ( preset === "corner" ) Object.assign(n, {mode: "auto", smooth: 0, hin: null, hout: null});
      else if ( preset === "smooth" ) Object.assign(n, {mode: "auto", smooth: 1, hin: null, hout: null});
      else if ( preset === "manual" ) {
        const built = buildShape(sh);
        const h = built.handles[sel.index];
        Object.assign(n, {mode: "manual", hin: {...h.hin}, hout: {...h.hout}});
        if ( Math.hypot(h.hout.x, h.hout.y) < 1 ) {
          const g = canvas.dimensions.size / 2;
          n.hin = {x: -g, y: 0};
          n.hout = {x: g, y: 0};
        }
      }
    });
  }

  /** Make every node of the selected path a corner or a smooth node. */
  static async #onAllNodes(_event, target) {
    const step = Editor.step;
    if ( !step || (step.shape.type !== "path") ) return;
    const smooth = target.dataset.preset === "smooth" ? 1 : 0;
    await Store.mutate(Editor.animId, a => {
      const sh = a.steps.find(x => x.id === step.id).shape;
      for ( const n of sh.nodes ) Object.assign(n, {mode: "auto", smooth, hin: null, hout: null, bend: smooth ? n.bend : 0});
    });
  }

  /* -------------------------------------------- */
  /*  Actions: motion & facing                    */
  /* -------------------------------------------- */

  static async #onSpeedPreset(_event, target) {
    const v = Number(target.dataset.speed);
    await Store.mutate(Editor.animId, a => {
      a.motion.speed = v;
      a.motion.speedUnit = "grid";
    });
  }

  static async #onEasePreset(_event, target) {
    const p = EASE_PRESETS[target.dataset.preset];
    if ( !p ) return;
    await Store.mutate(Editor.animId, a => {
      a.motion.easeIn = p.in;
      a.motion.easeOut = p.out;
    });
  }

  /** Toggle a per-step facing override. */
  static async #onStepFacing() {
    const step = Editor.step;
    if ( !step ) return;
    await Store.mutate(Editor.animId, a => {
      const s = a.steps.find(x => x.id === step.id);
      s.facing = s.facing ? null : foundry.utils.deepClone(a.facing);
    });
  }

  static #onPick(_event, target) {
    const mode = target.dataset.pick;
    const stepId = target.dataset.scope === "sfacing" ? Editor.stepId : null;
    AnimatorPanel.activateTool("kaaEdit");
    Editor.setPicking({mode, stepId});
    // Out of the way while you click on the map (back as soon as the pick is made, or cancelled with Escape)
    if ( AnimatorPanel.#SINGLE_PICKS.has(mode) ) this.#collapseForPick();
  }

  /* -------------------------------------------- */
  /*  Actions: tokens                             */
  /* -------------------------------------------- */

  static async #onAssignSelected(_event, target) {
    const anim = Editor.anim;
    if ( !anim ) return;
    let ids = canvas.tokens.controlled.map(t => t.id);
    if ( this.#pendingToken && !ids.length ) ids = [this.#pendingToken];
    if ( !ids.length ) return ui.notifications.warn("KAA.Warn.SelectTokens", {localize: true});
    const replace = target.dataset.replace === "true";
    await Store.mutate(anim.id, a => {
      a.tokens = replace ? ids : Array.from(new Set([...a.tokens, ...ids]));
    });
    this.#pendingToken = null;
  }

  static async #onUnassign(_event, target) {
    const id = target.closest("[data-token-id]").dataset.tokenId;
    await Store.mutate(Editor.animId, a => {
      a.tokens = a.tokens.filter(t => t !== id);
    });
  }

  static async #onClearTokens() {
    await Store.mutate(Editor.animId, a => {
      a.tokens = [];
    });
  }

  static async #onTokenPlay(_event, target) {
    const id = target.closest("[data-token-id]").dataset.tokenId;
    await Playback.play(Editor.animId, [id], {rate: Editor.rate, stagger: "none"});
  }

  static async #onTokenPause(_event, target) {
    const id = target.closest("[data-token-id]").dataset.tokenId;
    await Playback.togglePause([id]);
  }

  static async #onTokenStop(_event, target) {
    const id = target.closest("[data-token-id]").dataset.tokenId;
    await Playback.stop([id], {mode: target.dataset.mode ?? "here"});
  }

  static #onPanToken(_event, target) {
    const doc = canvas.scene.tokens.get(target.closest("[data-token-id]").dataset.tokenId);
    if ( doc?.object ) canvas.animatePan({...doc.object.center, duration: 400});
  }

  /* -------------------------------------------- */
  /*  Actions: transport                          */
  /* -------------------------------------------- */

  static async #onPlay() {
    const anim = Editor.anim;
    if ( !anim ) return;
    await Playback.play(anim, AnimatorPanel.#targets(anim), {rate: Editor.rate});
  }

  static async #onPlaySelected() {
    const anim = Editor.anim;
    if ( !anim ) return;
    const docs = canvas.tokens.controlled.map(t => t.document);
    if ( !docs.length ) return ui.notifications.warn("KAA.Warn.SelectTokens", {localize: true});
    await Playback.play(anim, docs, {rate: Editor.rate});
  }

  static async #onPause() {
    const anim = Editor.anim;
    if ( !anim ) return;
    const docs = Playback.playing(canvas.scene, anim.id);
    const anyRunning = docs.some(d => !d.getFlag(MODULE_ID, FLAG_PLAYBACK)?.paused);
    if ( anyRunning ) await Playback.pause(docs);
    else await Playback.resume(docs);
  }

  static async #onStop(_event, target) {
    const anim = Editor.anim;
    if ( !anim ) return;
    await Playback.stop(Playback.playing(canvas.scene, anim.id), {mode: target.dataset.mode ?? "here"});
  }

  static async #onRestart() {
    const anim = Editor.anim;
    if ( !anim ) return;
    // Restart the original tokens only: their symmetry copies are re-created by play()
    const docs = Playback.playing(canvas.scene, anim.id).filter(d => !d.getFlag(MODULE_ID, "copy"));
    const targets = docs.length ? docs : resolveTokens(AnimatorPanel.#targets(anim));
    if ( docs.length ) await Playback.stop(docs, {mode: "origin"});
    await Playback.play(anim, targets.filter(d => canvas.scene.tokens.has(d.id)), {rate: Editor.rate});
  }

  static #onGhost() {
    Editor.ghost = !Editor.ghost;
    if ( Editor.ghost ) AnimatorPanel.activateTool(game.activeTool?.startsWith("kaa") ? game.activeTool : "kaaEdit");
    Editor.emit("ghost");
    this.requestRender(["transport"]);
  }

  static async #onStopAll() {
    await Playback.stopAll({scene: canvas.scene});
  }

  static async #onPauseAll() {
    await Playback.pauseAll({scene: canvas.scene});
  }
}
