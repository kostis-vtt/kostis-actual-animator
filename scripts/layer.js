// The animator canvas layer: drawing tools, on-canvas editing handles, path rendering and the preview ghost.

import {FLAG_PLAYBACK, LAYER_NAME, MODULE_ID, MODULE_TITLE, TOOLS} from "./const.js";
import {Editor} from "./editor.js";
import {Store, aimTargets, animationCenter, defaultStep, facingFor, firstGeometricStep, isGeometric, symmetryCenterFor} from "./model.js";
import {buildShape, makeNode, nodeHandles, pathCurves, translateShape} from "./shapes.js";
import {clamp, dist, rotateAround, simplifyRDP, toDeg, toRad} from "./geometry.js";
import {compileTimeline, homingCurve, stepEndpoints} from "./timeline.js";
import {Playback, composePose, tokenPivot} from "./playback.js";
import {facingRotation} from "./facing.js";
import {liftHeight} from "./lift.js";
import {copyTransform, transformDirection, transformPoint} from "./symmetry.js";

const newGraphics = () => new (PIXI.smooth?.SmoothGraphics ?? PIXI.Graphics)();
const ROUND = {join: PIXI.LINE_JOIN.ROUND, cap: PIXI.LINE_CAP.ROUND};
const DRAG_SHAPE_TOOLS = new Set(["kaaEllipse", "kaaRect", "kaaPolygon", "kaaSpiral", "kaaWave", "kaaFigure8"]);
const START_COLOR = 0x3ddc84;
const END_COLOR = 0xff5d5d;

/** Cubic Bézier point. */
function bez(c, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {x: (a * c.p0.x) + (b * c.c1.x) + (d * c.c2.x) + (e * c.p3.x), y: (a * c.p0.y) + (b * c.c1.y) + (d * c.c2.y) + (e * c.p3.y)};
}

export class KaaLayer extends foundry.canvas.layers.InteractionLayer {

  /** @inheritDoc */
  static get layerOptions() {
    return Object.assign(super.layerOptions, {name: LAYER_NAME, zIndex: 650});
  }

  /** @override */
  static prepareSceneControls() {
    const tools = {};
    let order = 0;
    for ( const [name, t] of Object.entries(TOOLS) ) {
      tools[name] = {name, order: order++, title: t.title, icon: t.icon};
    }
    tools.kaaSnap = {
      name: "kaaSnap", order: order++, title: "Snap new points to the grid (hold Ctrl to invert while drawing)",
      icon: "fa-solid fa-border-all", toggle: true, active: Editor.opts.snap,
      onChange: (_event, active) => Editor.setOpt("snap", active)
    };
    tools.kaaShowAll = {
      name: "kaaShowAll", order: order++, title: "Show the paths of every animation on this scene",
      icon: "fa-solid fa-layer-group", toggle: true, active: Editor.opts.showAll,
      onChange: (_event, active) => Editor.setOpt("showAll", active)
    };
    tools.kaaPanel = {
      name: "kaaPanel", order: order++, title: "Open the animator control panel",
      icon: "fa-solid fa-sliders", button: true,
      onChange: () => game.modules.get(MODULE_ID).api.openPanel()
    };
    return {
      name: LAYER_NAME,
      order: 20,
      title: MODULE_TITLE,
      layer: LAYER_NAME,
      icon: "fa-solid fa-route",
      visible: game.user.isGM,
      activeTool: "kaaEdit",
      onChange: (_event, active) => {
        if ( active ) canvas[LAYER_NAME]?.activate();
      },
      onToolChange: (_event, tool, active) => {
        if ( active ) canvas[LAYER_NAME]?._onToolChanged(tool.name);
      },
      tools
    };
  }

  /* -------------------------------------------- */
  /*  State                                       */
  /* -------------------------------------------- */

  /** Scene pixels per screen pixel (keeps handles a constant size at any zoom). */
  #s = 1;

  #paths;

  #overlay;

  #labels;

  #ghostLayer;

  /** Hit-testable handles of the selected step. */
  #handles = [];

  /** Active drag operation. */
  #drag = null;

  /** In-progress drawing. */
  #draft = null;

  #hover = null;

  #refreshQueued = false;

  #ghost = {running: false, start: 0, key: null, tl: null, sprites: [], transforms: [], size: null};

  #onEditorChange = what => {
    if ( what === "ghost" ) this.#syncGhost();
    this.scheduleRefresh();
  };

  #onPointerMove = () => {
    if ( !this.active ) return;
    const m = canvas.mousePosition;
    this.#hover = {x: m.x, y: m.y};
    if ( this.#draft?.tool === "kaaPen" ) this.scheduleRefresh();
  };

  /* -------------------------------------------- */
  /*  Drawing lifecycle                           */
  /* -------------------------------------------- */

  /** @inheritDoc */
  async _draw(options) {
    await super._draw(options);
    this.#paths = this.addChild(newGraphics());
    this.#overlay = this.addChild(newGraphics());
    this.#labels = this.addChild(new PIXI.Container());
    this.#ghostLayer = this.addChild(new PIXI.Container());
    // Purely visual: all pointer input is routed through the canvas to the layer's _on* handlers
    for ( const c of this.children ) c.eventMode = "none";
    Editor.on(this.#onEditorChange);
    this.refresh();
  }

  /** @inheritDoc */
  async _tearDown(options) {
    Editor.off(this.#onEditorChange);
    this.#stopGhost();
    this.#draft = null;
    this.#drag = null;
    this.#handles = [];
    this.#paths = this.#overlay = this.#labels = this.#ghostLayer = null;
    return super._tearDown(options);
  }

  /** @inheritDoc */
  _activate() {
    canvas.stage.on("pointermove", this.#onPointerMove);
    this.#syncGhost();
    this.refresh();
  }

  /** @inheritDoc */
  _deactivate() {
    canvas.stage.off("pointermove", this.#onPointerMove);
    this.#draft = null;
    this.#drag = null;
    if ( Editor.preview ) Editor.setPreview(null);
    if ( Editor.picking ) Editor.setPicking(null);
    this.#stopGhost();
    this.refresh();
  }

  _onToolChanged(_tool) {
    this.#draft = null;
    this.scheduleRefresh();
  }

  /** Coalesce redraw requests into one per frame. */
  scheduleRefresh() {
    if ( this.#refreshQueued ) return;
    this.#refreshQueued = true;
    requestAnimationFrame(() => {
      this.#refreshQueued = false;
      this.refresh();
    });
  }

  /** Redraw paths, handles and drafts. */
  refresh() {
    if ( !this.#paths || this.#paths.destroyed ) return;
    this.#s = 1 / (canvas.stage.scale.x || 1);
    this.#paths.clear();
    this.#overlay.clear();
    for ( const c of this.#labels.removeChildren() ) c.destroy();
    this.#handles = [];
    if ( !canvas.scene ) return;
    const showRunning = !this.active && game.user.isGM && game.settings.get(MODULE_ID, "showRunning");
    if ( !this.active && !showRunning ) return;
    Editor.validate();

    const anims = Store.all();
    if ( showRunning ) {
      const playing = new Set(Playback.playing(canvas.scene).map(d => d.getFlag(MODULE_ID, FLAG_PLAYBACK)?.anim));
      for ( const a of anims ) if ( playing.has(a.id) ) this.#drawAnim(this.#paths, a, {selected: false, alpha: 0.45});
      return;
    }
    for ( const a of anims ) {
      if ( a.id === Editor.animId ) continue;
      if ( !Editor.opts.showAll ) continue;
      this.#drawAnim(this.#paths, Editor.resolve(a), {selected: false, alpha: 0.32});
    }
    const sel = Editor.anim;
    if ( sel ) {
      this.#drawTokenRings(this.#overlay, sel);
      if ( sel.symmetry.count > 1 ) this.#drawSymmetry(this.#paths, sel);
      if ( sel.motion.anchor === "relative" ) this.#drawRelativeOutlines(this.#paths, sel);
      this.#drawAnim(this.#paths, sel, {selected: true, alpha: 1});
      this.#drawHandles(this.#overlay, sel);
    }
    this.#drawDraft(this.#overlay);
  }

  /**
   * Where the symmetry centre is while editing: the token the animation would start from, the path centre,
   * or the chosen point.
   */
  previewCenter(anim, origin) {
    const s = anim.symmetry;
    const first = firstGeometricStep(anim);
    const start = first ? stepEndpoints(first).start : (this.#previewOrigin(anim) ?? {x: 0, y: 0});
    if ( s.center === "path" ) return animationCenter(anim) ?? start;
    if ( s.center === "point" ) return s.point ?? start;
    if ( anim.motion.anchor === "relative" ) return start;
    return origin ?? this.#previewOrigin(anim) ?? start;
  }

  /** Centre of the first assigned (or selected) token, used as the preview origin. */
  #previewOrigin(anim) {
    const doc = this.#ghostToken(anim);
    if ( !doc ) return null;
    const p = tokenPivot(doc);
    return {x: doc._source.x + p.x, y: doc._source.y + p.y};
  }

  /** Draw the symmetric copies of the selected animation (live kaleidoscope preview). */
  #drawSymmetry(g, anim) {
    const s = this.#s;
    const color = Number(foundry.utils.Color.from(anim.color));
    const c = this.previewCenter(anim);
    const n = anim.symmetry.count;
    const alpha = Math.max(0.12, 0.45 - (n * 0.006));
    for ( let i = 1; i < n; i++ ) {
      const t = copyTransform({i, n, mode: anim.symmetry.mode, axis: anim.symmetry.axis, cx: c.x, cy: c.y});
      g.lineStyle({width: 2 * s, color, alpha, ...ROUND});
      for ( const step of anim.steps ) {
        if ( (step.enabled === false) || !isGeometric(step) ) continue;
        const lut = buildShape(step.shape).lut;
        if ( lut.count < 2 ) {
          const q = transformPoint(t, lut.start);
          g.drawCircle(q.x, q.y, 4 * s);
          continue;
        }
        const {xs, ys} = lut;
        const q0 = transformPoint(t, {x: xs[0], y: ys[0]});
        g.moveTo(q0.x, q0.y);
        for ( let k = 1; k < xs.length; k++ ) {
          const q = transformPoint(t, {x: xs[k], y: ys[k]});
          g.lineTo(q.x, q.y);
        }
      }
    }
    // Centre marker
    g.lineStyle({width: 2 * s, color: 0xffffff, alpha: 0.85});
    g.drawCircle(c.x, c.y, 9 * s);
    g.moveTo(c.x - (14 * s), c.y);
    g.lineTo(c.x + (14 * s), c.y);
    g.moveTo(c.x, c.y - (14 * s));
    g.lineTo(c.x, c.y + (14 * s));
  }

  /** For relative animations, outline the path where each assigned token will actually run it. */
  #drawRelativeOutlines(g, anim) {
    const first = firstGeometricStep(anim);
    if ( !first ) return;
    const s = this.#s;
    const color = Number(foundry.utils.Color.from(anim.color));
    const start = stepEndpoints(first).start;
    for ( const id of anim.tokens ) {
      const doc = canvas.scene.tokens.get(id);
      if ( !doc || doc.getFlag(MODULE_ID, FLAG_PLAYBACK) ) continue;
      const p = tokenPivot(doc);
      const dx = doc._source.x + p.x - start.x;
      const dy = doc._source.y + p.y - start.y;
      if ( Math.hypot(dx, dy) < 1 ) continue;
      g.lineStyle({width: 2 * s, color, alpha: 0.3, ...ROUND});
      for ( const step of anim.steps ) {
        if ( (step.enabled === false) || !isGeometric(step) ) continue;
        const lut = buildShape(step.shape).lut;
        if ( lut.count < 2 ) continue;
        g.moveTo(lut.xs[0] + dx, lut.ys[0] + dy);
        for ( let k = 1; k < lut.count; k++ ) g.lineTo(lut.xs[k] + dx, lut.ys[k] + dy);
      }
    }
  }

  /** Ring the tokens assigned to the selected animation (skipping ones that are moving). */
  #drawTokenRings(g, anim) {
    const s = this.#s;
    const color = Number(foundry.utils.Color.from(anim.color));
    const picking = Editor.picking?.mode === "tokens";
    for ( const id of anim.tokens ) {
      const doc = canvas.scene.tokens.get(id);
      const t = doc?.object;
      if ( !t || doc.getFlag(MODULE_ID, FLAG_PLAYBACK) ) continue;
      const c = t.center;
      const r = (Math.max(t.w, t.h) / 2) + (6 * s);
      g.lineStyle({width: (picking ? 4 : 2.5) * s, color, alpha: 0.9});
      g.drawCircle(c.x, c.y, r);
    }
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  #polyline(g, lut) {
    const {xs, ys} = lut;
    g.moveTo(xs[0], ys[0]);
    for ( let i = 1; i < xs.length; i++ ) g.lineTo(xs[i], ys[i]);
  }

  #dashed(g, a, b, dash, gap) {
    const L = dist(a, b);
    if ( L < 1e-6 ) return;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    for ( let d = 0; d < L; d += dash + gap ) {
      const e = Math.min(L, d + dash);
      g.moveTo(a.x + (ux * d), a.y + (uy * d));
      g.lineTo(a.x + (ux * e), a.y + (uy * e));
    }
  }

  #drawConnector(g, a, b, mode, color, alpha) {
    const s = this.#s;
    if ( mode === "teleport" ) {
      g.lineStyle({width: 1.5 * s, color, alpha: alpha * 0.7, ...ROUND});
      this.#dashed(g, a, b, 2 * s, 7 * s);
      g.lineStyle(0);
      g.beginFill(color, alpha);
      g.drawCircle(b.x, b.y, 3 * s);
      g.endFill();
    } else {
      g.lineStyle({width: 2 * s, color, alpha: alpha * 0.85, ...ROUND});
      this.#dashed(g, a, b, 10 * s, 7 * s);
    }
  }

  #drawArrows(g, step, built, color, alpha) {
    const s = this.#s;
    const lut = built.lut;
    const L = lut.length;
    if ( L < 20 * s ) return;
    const spacing = Math.max(70 * s, L / 200);
    const dir = step.reverse ? -1 : 1;
    const startD = built.closed ? (step.startOffset || 0) * L : (step.reverse ? L : 0);
    const size = 6 * s;
    g.lineStyle({width: 2 * s, color: 0xffffff, alpha: alpha * 0.9, ...ROUND});
    for ( let d = spacing / 2; d < L; d += spacing ) {
      const at = startD + (dir * d);
      const p = lut.pointAt(at);
      let a = lut.angleAt(at, 3);
      if ( a === null ) continue;
      if ( dir < 0 ) a += Math.PI;
      const l = {x: p.x - (Math.cos(a - 0.5) * size), y: p.y - (Math.sin(a - 0.5) * size)};
      const r = {x: p.x - (Math.cos(a + 0.5) * size), y: p.y - (Math.sin(a + 0.5) * size)};
      g.moveTo(l.x, l.y);
      g.lineTo(p.x, p.y);
      g.lineTo(r.x, r.y);
    }
  }

  #label(text, x, y, color) {
    const PreciseText = foundry.canvas.containers.PreciseText;
    const style = PreciseText.getTextStyle({fontSize: 13, fill: color, strokeThickness: 3});
    const t = new PreciseText(text, style);
    t.anchor.set(0.5, 0.5);
    t.scale.set(this.#s);
    t.position.set(x, y);
    this.#labels.addChild(t);
  }

  /** Draw every step of an animation, its connectors and loop-back. */
  #drawAnim(g, anim, {selected, alpha}) {
    const s = this.#s;
    const color = Number(foundry.utils.Color.from(anim.color));
    let cursor = null;
    let first = null;
    anim.steps.forEach((step, i) => {
      if ( (step.enabled === false) && !selected ) return;
      const a = alpha * (step.enabled === false ? 0.35 : 1);
      const isSel = selected && (step.id === Editor.stepId);
      if ( !isGeometric(step) ) {
        cursor = this.#drawHomingLeg(g, anim, step, cursor, {color, alpha: a, selected, isSel, num: i + 1});
        first ??= cursor;
        return;
      }
      const {start, end, built} = stepEndpoints(step);
      if ( cursor && (dist(cursor, start) > 0.5) ) this.#drawConnector(g, cursor, start, step.connector, color, a);
      first ??= start;
      if ( (step.shape.type === "point") || (built.lut.length < 0.5) ) {
        const p = built.lut.start;
        g.lineStyle({width: (isSel ? 3 : 2) * s, color: 0x000000, alpha: a * 0.6});
        g.beginFill(color, a);
        g.drawPolygon([p.x, p.y - (9 * s), p.x + (7 * s), p.y, p.x, p.y + (9 * s), p.x - (7 * s), p.y]);
        g.endFill();
      } else {
        const w = (isSel ? 5 : (selected ? 3.2 : 2)) * s;
        if ( selected ) {
          g.lineStyle({width: w + (3 * s), color: 0x000000, alpha: 0.35 * a, ...ROUND});
          this.#polyline(g, built.lut);
        }
        g.lineStyle({width: w, color, alpha: a, ...ROUND});
        this.#polyline(g, built.lut);
        if ( selected ) this.#drawArrows(g, step, built, color, a);
      }
      if ( selected ) {
        g.lineStyle({width: 1.5 * s, color: 0x000000, alpha: a});
        g.beginFill(START_COLOR, a);
        g.drawCircle(start.x, start.y, 4.5 * s);
        g.endFill();
        this.#label(String(i + 1), start.x + (12 * s), start.y - (12 * s), anim.color);
      }
      cursor = end;
    });
    if ( (anim.motion.loop === "loop") && cursor && first && (dist(cursor, first) > 0.5) ) {
      this.#drawConnector(g, cursor, first, anim.motion.loopConnector, color, alpha * 0.55);
    }
    if ( selected && cursor && (anim.motion.loop === "none") ) {
      g.lineStyle({width: 1.5 * s, color: 0x000000, alpha});
      g.beginFill(END_COLOR, alpha);
      g.drawRect(cursor.x - (4.5 * s), cursor.y - (4.5 * s), 9 * s, 9 * s);
      g.endFill();
    }
  }

  /** Where a homing leg would fly to right now in the editor (current targets, the anchor, a token, home). */
  homingPreviewEnd(anim, spec) {
    const center = doc => {
      const p = tokenPivot(doc);
      return {x: doc.x + p.x, y: doc.y + p.y};
    };
    const mover = this.#ghostToken(anim);
    const aimed = [...(game.user.targets ?? [])].map(t => t.document)
      .filter(d => (d?.parent === canvas.scene) && (d.id !== mover?.id));
    const {anchor, strikes: targets} = aimTargets(anim, canvas.scene, aimed);
    switch ( spec.to ) {
      case "target": return targets.length ? center(targets[spec.index % targets.length]) : null;
      case "home": return this.#previewOrigin(anim);
      case "anchor": return anchor ? center(anchor) : null;
      case "token": {
        const d = spec.tokenId ? canvas.scene.tokens.get(spec.tokenId) : null;
        return d ? center(d) : null;
      }
    }
    return null;
  }

  /** Draw a homing leg as a dashed curve to its current destination (or a "needs a target" marker). */
  #drawHomingLeg(g, anim, step, cursor, {color, alpha, selected, isSel, num}) {
    const s = this.#s;
    const from = cursor ?? this.#previewOrigin(anim);
    const to = this.homingPreviewEnd(anim, step.shape);
    if ( !from ) return cursor;
    if ( !to ) {
      g.lineStyle({width: 2 * s, color, alpha});
      g.drawCircle(from.x, from.y, 14 * s);
      g.moveTo(from.x - (18 * s), from.y);
      g.lineTo(from.x + (18 * s), from.y);
      g.moveTo(from.x, from.y - (18 * s));
      g.lineTo(from.x, from.y + (18 * s));
      if ( selected ) this.#label(`${num}: target a token to preview`, from.x, from.y - (26 * s), anim.color);
      return cursor;
    }
    const lut = homingCurve(from, to, step.shape.arc);
    const stop = (step.shape.stop || 0) * canvas.dimensions.size;
    const L = Math.max(0, lut.length - stop);
    g.lineStyle({width: (isSel ? 4 : 2.5) * s, color, alpha: alpha * 0.9, ...ROUND});
    const dash = 12 * s;
    for ( let d = 0; d < L; d += dash * 1.8 ) {
      const p = lut.pointAt(d);
      const q = lut.pointAt(Math.min(L, d + dash));
      g.moveTo(p.x, p.y);
      g.lineTo(q.x, q.y);
    }
    const end = lut.pointAt(L);
    const ang = lut.angleAt(L, 3) ?? 0;
    const size = 9 * s;
    g.beginFill(color, alpha);
    g.drawPolygon([end.x, end.y, end.x - (Math.cos(ang - 0.45) * size), end.y - (Math.sin(ang - 0.45) * size),
      end.x - (Math.cos(ang + 0.45) * size), end.y - (Math.sin(ang + 0.45) * size)]);
    g.endFill();
    if ( selected ) {
      const mid = lut.pointAt(L / 2);
      const label = {target: `target ${step.shape.index + 1}`, home: "home", anchor: "anchor", token: "token"}[step.shape.to];
      this.#label(`${num} → ${label}`, mid.x, mid.y - (14 * s), anim.color);
    }
    return end;
  }

  /* -------------------------------------------- */
  /*  Handles                                     */
  /* -------------------------------------------- */

  /** Compute the editing handles of a step. Order = draw order; hit-testing goes in reverse. */
  #computeHandles(step) {
    if ( !isGeometric(step) ) return [];
    const s = this.#s;
    const sh = step.shape;
    const built = buildShape(sh);
    const H = [];
    const rot = toRad(sh.rotation ?? 0);
    const c = {x: sh.cx, y: sh.cy};
    const R = (lx, ly) => rotateAround({x: sh.cx + lx, y: sh.cy + ly}, c, rot);
    switch ( sh.type ) {
      case "path": {
        const sel = Editor.sel;
        for ( const cv of built.curves ) {
          const m = bez(cv, 0.5);
          H.push({kind: "bend", index: cv.index, x: m.x, y: m.y, glyph: "diamond",
            selected: (sel?.type === "segment") && (sel.index === cv.index)});
        }
        const n = sh.nodes.length;
        sh.nodes.forEach((node, i) => {
          const corner = (node.mode === "auto") && !(node.smooth > 0);
          H.push({kind: "node", index: i, x: node.x, y: node.y, glyph: corner ? "square" : "circle",
            selected: (sel?.type === "node") && (sel.index === i)});
        });
        if ( sel?.type === "node" ) {
          const idx = new Set([sel.index - 1, sel.index, sel.index + 1].map(j => (sh.closed ? (j + n) % n : j))
            .filter(j => (j >= 0) && (j < n)));
          for ( const j of idx ) {
            const node = sh.nodes[j];
            const {hin, hout} = built.handles[j];
            if ( (sh.closed || (j > 0)) && (Math.hypot(hin.x, hin.y) > 0.5) ) {
              H.push({kind: "hin", index: j, x: node.x + hin.x, y: node.y + hin.y, from: node, glyph: "knob"});
            }
            if ( (sh.closed || (j < n - 1)) && (Math.hypot(hout.x, hout.y) > 0.5) ) {
              H.push({kind: "hout", index: j, x: node.x + hout.x, y: node.y + hout.y, from: node, glyph: "knob"});
            }
          }
        }
        break;
      }
      case "ellipse":
        H.push({kind: "center", x: c.x, y: c.y, glyph: "cross"});
        H.push({kind: "ell-rx", ...R(sh.rx, 0), glyph: "square"});
        H.push({kind: "ell-ry", ...R(0, sh.ry), glyph: "square"});
        H.push({kind: "rotate", base: 0, ...R(sh.rx + (26 * s), 0), from: R(sh.rx, 0), glyph: "rotate"});
        break;
      case "rect":
        H.push({kind: "center", x: c.x, y: c.y, glyph: "cross"});
        H.push({kind: "rect-corner", ...R(sh.w / 2, sh.h / 2), glyph: "square"});
        H.push({kind: "rotate", base: -90, ...R(0, -(sh.h / 2) - (26 * s)), from: R(0, -sh.h / 2), glyph: "rotate"});
        break;
      case "polygon": {
        H.push({kind: "center", x: c.x, y: c.y, glyph: "cross"});
        const a = toRad(sh.rotation - 90);
        H.push({kind: "poly-radius", x: c.x + (sh.radius * Math.cos(a)), y: c.y + (sh.radius * Math.sin(a)), glyph: "square"});
        break;
      }
      case "spiral":
        H.push({kind: "center", x: c.x, y: c.y, glyph: "cross"});
        H.push({kind: "spiral-outer", ...built.lut.end, glyph: "square"});
        break;
      case "wave": {
        const a = {x: sh.x0, y: sh.y0};
        const b = {x: sh.x1, y: sh.y1};
        const L = dist(a, b) || 1;
        const ux = (b.x - a.x) / L;
        const uy = (b.y - a.y) / L;
        const q = sh.wavelength / 4;
        H.push({kind: "wave-a", ...a, glyph: "circle"});
        H.push({kind: "wave-b", ...b, glyph: "circle"});
        H.push({kind: "wave-amp", x: a.x + (ux * q) - (uy * sh.amplitude), y: a.y + (uy * q) + (ux * sh.amplitude),
          glyph: "diamond"});
        break;
      }
      case "figure8":
        H.push({kind: "center", x: c.x, y: c.y, glyph: "cross"});
        H.push({kind: "f8-size", ...R(sh.w / 2, sh.h / 2), glyph: "square"});
        H.push({kind: "rotate", base: -90, ...R(0, -(sh.h / 2) - (26 * s)), from: c, glyph: "rotate"});
        break;
      case "point":
        H.push({kind: "point", x: sh.x, y: sh.y, glyph: "circle"});
        break;
    }
    if ( built.closed ) {
      const p = built.lut.pointAt((step.startOffset || 0) * built.lut.length);
      H.push({kind: "start", x: p.x, y: p.y, glyph: "start"});
    }
    return H;
  }

  #drawHandles(g, anim) {
    const step = anim.steps.find(st => st.id === Editor.stepId);
    if ( !step ) return;
    const s = this.#s;
    const color = Number(foundry.utils.Color.from(anim.color));
    this.#handles = this.#computeHandles(step);
    for ( const h of this.#handles ) {
      if ( h.from ) {
        g.lineStyle({width: 1.5 * s, color: 0xffffff, alpha: 0.8});
        g.moveTo(h.from.x, h.from.y);
        g.lineTo(h.x, h.y);
      }
      const fill = h.selected ? color : 0xffffff;
      g.lineStyle({width: 2 * s, color: h.selected ? 0xffffff : color, alpha: 1});
      switch ( h.glyph ) {
        case "circle":
          g.beginFill(fill, 1);
          g.drawCircle(h.x, h.y, 6 * s);
          g.endFill();
          break;
        case "square":
          g.beginFill(fill, 1);
          g.drawRect(h.x - (5.5 * s), h.y - (5.5 * s), 11 * s, 11 * s);
          g.endFill();
          break;
        case "diamond": {
          const r = 5 * s;
          g.beginFill(h.selected ? color : 0x222222, 0.9);
          g.drawPolygon([h.x, h.y - r, h.x + r, h.y, h.x, h.y + r, h.x - r, h.y]);
          g.endFill();
          break;
        }
        case "knob":
          g.lineStyle({width: 1.5 * s, color: 0x000000, alpha: 1});
          g.beginFill(color, 1);
          g.drawCircle(h.x, h.y, 4.5 * s);
          g.endFill();
          break;
        case "cross":
          g.beginFill(0x222222, 0.85);
          g.drawCircle(h.x, h.y, 7 * s);
          g.endFill();
          g.lineStyle({width: 2 * s, color: 0xffffff, alpha: 1});
          g.moveTo(h.x - (5 * s), h.y);
          g.lineTo(h.x + (5 * s), h.y);
          g.moveTo(h.x, h.y - (5 * s));
          g.lineTo(h.x, h.y + (5 * s));
          break;
        case "rotate":
          g.beginFill(0x222222, 0.9);
          g.drawCircle(h.x, h.y, 6 * s);
          g.endFill();
          g.lineStyle({width: 2 * s, color: 0xffffff, alpha: 1});
          g.arc(h.x, h.y, 3 * s, 0, Math.PI * 1.5);
          break;
        case "start":
          g.lineStyle({width: 2 * s, color: 0xffffff, alpha: 1});
          g.beginFill(START_COLOR, 1);
          g.drawCircle(h.x, h.y, 7 * s);
          g.endFill();
          break;
      }
    }
    // Closing hint while dragging a path end onto the other end
    if ( this.#drag?.closeHint ) {
      const p = this.#drag.closeHint;
      g.lineStyle({width: 3 * s, color: START_COLOR, alpha: 0.9});
      g.drawCircle(p.x, p.y, 13 * s);
    }
  }

  #drawDraft(g) {
    const d = this.#draft;
    if ( !d ) return;
    const s = this.#s;
    const color = Editor.anim ? Number(foundry.utils.Color.from(Editor.anim.color)) : 0xffffff;
    if ( d.tool === "kaaPen" ) {
      const shape = {type: "path", nodes: d.nodes, closed: false};
      if ( d.nodes.length >= 2 ) {
        const built = buildShape(shape);
        g.lineStyle({width: 3 * s, color, alpha: 0.95, ...ROUND});
        this.#polyline(g, built.lut);
      }
      const last = d.nodes.at(-1);
      const hover = this.#hover;
      if ( last && hover ) {
        const target = this.#penTarget(hover, null);
        g.lineStyle({width: 2 * s, color: 0xffffff, alpha: 0.7});
        this.#dashed(g, last, target, 8 * s, 6 * s);
        if ( (d.nodes.length >= 2) && (dist(target, d.nodes[0]) <= this.#hitRadius) ) {
          g.lineStyle({width: 3 * s, color: START_COLOR, alpha: 0.95});
          g.drawCircle(d.nodes[0].x, d.nodes[0].y, 13 * s);
        }
      }
      for ( const [i, n] of d.nodes.entries() ) {
        g.lineStyle({width: 2 * s, color, alpha: 1});
        g.beginFill(i === 0 ? START_COLOR : 0xffffff, 1);
        g.drawCircle(n.x, n.y, 5 * s);
        g.endFill();
        if ( n.mode === "manual" ) {
          g.lineStyle({width: 1.5 * s, color: 0xffffff, alpha: 0.8});
          g.moveTo(n.x + n.hin.x, n.y + n.hin.y);
          g.lineTo(n.x + n.hout.x, n.y + n.hout.y);
        }
      }
      return;
    }
    if ( d.tool === "kaaFreehand" ) {
      if ( d.points.length < 2 ) return;
      g.lineStyle({width: 3 * s, color, alpha: 0.9, ...ROUND});
      g.moveTo(d.points[0].x, d.points[0].y);
      for ( const p of d.points ) g.lineTo(p.x, p.y);
      return;
    }
    if ( d.shape ) {
      const built = buildShape(d.shape);
      g.lineStyle({width: 3 * s, color, alpha: 0.9, ...ROUND});
      this.#polyline(g, built.lut);
      if ( built.closed ) g.closePath();
    }
  }

  /* -------------------------------------------- */
  /*  Hit testing & snapping                      */
  /* -------------------------------------------- */

  get #hitRadius() {
    return 10 * this.#s;
  }

  #hitHandle(p) {
    for ( let i = this.#handles.length - 1; i >= 0; i-- ) {
      const h = this.#handles[i];
      if ( dist(p, h) <= this.#hitRadius ) return h;
    }
    return null;
  }

  /** Find which step of an animation passes near p. */
  #hitPath(p, anim) {
    const tol = 8 * this.#s;
    let best = null;
    for ( const step of anim.steps ) {
      if ( !isGeometric(step) ) continue;
      const built = buildShape(step.shape);
      const n = built.lut.nearest(p.x, p.y);
      const dd = (step.shape.type === "point") ? dist(p, built.lut.start) : n.dist;
      if ( (dd <= tol) && (!best || (dd < best.dist)) ) best = {step, dist: dd, built};
    }
    if ( best?.step.shape.type === "path" ) best.segment = this.#nearestCurve(best.built, p)?.index ?? null;
    return best;
  }

  /** Nearest Bézier segment of a built path to p: {index, t, x, y, dist}. */
  #nearestCurve(built, p) {
    let best = null;
    for ( const c of built.curves ?? [] ) {
      for ( let k = 0; k <= 48; k++ ) {
        const t = k / 48;
        const q = bez(c, t);
        const dd = dist(p, q);
        if ( !best || (dd < best.dist) ) best = {index: c.index, t, x: q.x, y: q.y, dist: dd};
      }
    }
    return best;
  }

  #gridSnap(p, event) {
    const ctrl = !!(event?.ctrlKey || event?.metaKey);
    const on = Editor.opts.snap !== ctrl;
    if ( !on || !canvas.grid || canvas.grid.isGridless ) return {x: p.x, y: p.y};
    const M = CONST.GRID_SNAPPING_MODES;
    const q = canvas.grid.getSnappedPoint({x: p.x, y: p.y}, {mode: M.CENTER | M.VERTEX | M.EDGE_MIDPOINT});
    return {x: q.x, y: q.y};
  }

  /** Snap onto nearby existing nodes / step endpoints of the selected animation (magnet). */
  #magnet(p, {exclude}={}) {
    const anim = Editor.anim;
    if ( !anim ) return null;
    const r = this.#hitRadius;
    let best = null;
    const consider = (q, meta) => {
      const dd = dist(p, q);
      if ( (dd <= r) && (!best || (dd < best.dist)) ) best = {x: q.x, y: q.y, dist: dd, ...meta};
    };
    for ( const step of anim.steps ) {
      const sh = step.shape;
      if ( !isGeometric(step) ) continue;
      if ( sh.type === "path" ) {
        sh.nodes.forEach((n, i) => {
          if ( exclude && (exclude.stepId === step.id) && (exclude.index === i) ) return;
          consider(n, {stepId: step.id, index: i});
        });
      } else {
        const {start, end} = stepEndpoints(step);
        consider(start, {stepId: step.id});
        consider(end, {stepId: step.id});
      }
    }
    return best;
  }

  #penTarget(p, event) {
    const d = this.#draft;
    let q = this.#gridSnap(p, event);
    if ( d?.nodes?.length >= 2 && (dist(q, d.nodes[0]) <= this.#hitRadius) ) return {x: d.nodes[0].x, y: d.nodes[0].y};
    const m = this.#magnet(q);
    if ( m ) q = {x: m.x, y: m.y};
    if ( event?.shiftKey && d?.nodes?.length ) {
      const last = d.nodes.at(-1);
      const a = Math.atan2(q.y - last.y, q.x - last.x);
      const step = Math.PI / 12;
      const sa = Math.round(a / step) * step;
      const L = dist(last, q);
      q = {x: last.x + (Math.cos(sa) * L), y: last.y + (Math.sin(sa) * L)};
    }
    return q;
  }

  /* -------------------------------------------- */
  /*  Committing shapes                           */
  /* -------------------------------------------- */

  async #commitShape(shape, extra={}) {
    const step = defaultStep(shape, extra);
    const anim = Editor.anim;
    if ( !anim ) {
      const created = await Store.create({steps: [step]});
      if ( created ) Editor.select(created.id, step.id);
      game.modules.get(MODULE_ID).api.openPanel({focus: false});
      return;
    }
    await Store.mutate(anim.id, a => {
      a.steps.push(step);
    });
    Editor.select(anim.id, step.id);
  }

  /** Finish the pen path being drawn. Returns true if there was one. */
  finishDraft() {
    const d = this.#draft;
    if ( !d || (d.tool !== "kaaPen") ) return false;
    this.#draft = null;
    if ( d.nodes.length >= 2 ) this.#commitShape({type: "path", nodes: d.nodes, closed: !!d.closed});
    this.refresh();
    return true;
  }

  /* -------------------------------------------- */
  /*  Mouse: clicks                               */
  /* -------------------------------------------- */

  /** @override */
  _onClickLeft(event) {
    const p = event.interactionData.origin;
    const tool = game.activeTool;
    if ( Editor.picking ) return this.#pick(event, p);
    if ( tool === "kaaEdit" ) return this.#editClick(event, p);
    if ( tool === "kaaPen" ) return this.#penClick(event, p);
    if ( tool === "kaaPoint" ) {
      const q = this.#magnet(this.#gridSnap(p, event)) ?? this.#gridSnap(p, event);
      this.#commitShape({type: "point", x: q.x, y: q.y}, {wait: Editor.opts.pointWait});
    }
  }

  /** Topmost visible token under a point. */
  #tokenAt(p) {
    const hits = canvas.tokens.placeables.filter(t => t.visible && t.bounds.contains(p.x, p.y));
    hits.sort((a, b) => (a.document.elevation - b.document.elevation) || (a.document.sort - b.document.sort));
    return hits.at(-1) ?? null;
  }

  /** Canvas picking requested by the control panel. */
  #pick(event, p) {
    const pick = Editor.picking;
    const anim = Editor.anim;
    if ( !anim ) return Editor.setPicking(null);
    const facingOf = a => {
      if ( pick.stepId ) {
        const st = a.steps.find(x => x.id === pick.stepId);
        if ( st ) return (st.facing ??= foundry.utils.deepClone(a.facing));
      }
      return a.facing;
    };
    if ( pick.mode === "facePoint" ) {
      const q = this.#gridSnap(p, event);
      Store.mutate(anim.id, a => {
        const f = facingOf(a);
        f.point = {x: q.x, y: q.y};
        f.mode = "point";
      });
      Editor.setPicking(null);
      return;
    }
    if ( (pick.mode === "anchorToken") || (pick.mode === "homingToken") ) {
      const tok = this.#tokenAt(p);
      if ( !tok ) return;
      const stepId = pick.stepId ?? Editor.stepId;
      Store.mutate(anim.id, a => {
        if ( pick.mode === "anchorToken" ) {
          a.motion.anchor = "token";
          a.motion.anchorToken = tok.id;
        } else {
          const st = a.steps.find(x => x.id === stepId);
          if ( st?.shape.type === "homing" ) Object.assign(st.shape, {to: "token", tokenId: tok.id});
        }
      });
      Editor.setPicking(null);
      return;
    }
    if ( pick.mode === "symPoint" ) {
      const q = this.#gridSnap(p, event);
      Store.mutate(anim.id, a => {
        a.symmetry.point = {x: q.x, y: q.y};
        a.symmetry.center = "point";
      });
      Editor.setPicking(null);
      return;
    }
    const token = this.#tokenAt(p);
    if ( !token ) return;
    if ( pick.mode === "targetGroup" ) {
      Store.mutate(anim.id, a => {
        const f = facingOf(a);
        f.mode = "target";
        f.target.group = "custom";
        const list = f.target.tokens;
        f.target.tokens = list.includes(token.id) ? list.filter(id => id !== token.id) : [...list, token.id];
      });
      return;
    }
    if ( pick.mode === "faceToken" ) {
      Store.mutate(anim.id, a => {
        const f = facingOf(a);
        f.tokenId = token.id;
        f.mode = "token";
      });
      Editor.setPicking(null);
      return;
    }
    if ( pick.mode === "tokens" ) {
      Store.mutate(anim.id, a => {
        if ( a.tokens.includes(token.id) ) a.tokens = a.tokens.filter(id => id !== token.id);
        else a.tokens.push(token.id);
      });
    }
  }

  #editClick(event, p) {
    const anim = Editor.anim;
    const h = anim ? this.#hitHandle(p) : null;
    if ( h ) {
      if ( ["node", "hin", "hout"].includes(h.kind) ) Editor.select(anim.id, Editor.stepId, {type: "node", index: h.index});
      else if ( h.kind === "bend" ) Editor.select(anim.id, Editor.stepId, {type: "segment", index: h.index});
      return;
    }
    if ( anim ) {
      const hit = this.#hitPath(p, anim);
      if ( hit ) {
        const sel = (hit.segment !== null) && (hit.segment !== undefined) ? {type: "segment", index: hit.segment} : null;
        Editor.select(anim.id, hit.step.id, sel);
        return;
      }
    }
    if ( Editor.opts.showAll ) {
      for ( const other of Store.all().reverse() ) {
        if ( other.id === Editor.animId ) continue;
        const hit = this.#hitPath(p, other);
        if ( hit ) {
          Editor.select(other.id, hit.step.id, null);
          return;
        }
      }
    }
    if ( Editor.stepId ) Editor.select(Editor.animId, null, null);
  }

  #penClick(event, p) {
    const d = this.#draft;
    if ( !d ) {
      const q = this.#penTarget(p, event);
      this.#draft = {tool: "kaaPen", nodes: [makeNode(q.x, q.y, {smooth: Editor.opts.penSmooth})]};
      this.refresh();
      return;
    }
    const q = this.#penTarget(p, event);
    if ( (d.nodes.length >= 2) && (dist(q, d.nodes[0]) <= 0.01) ) {
      d.closed = true;
      this.finishDraft();
      return;
    }
    if ( dist(q, d.nodes.at(-1)) <= this.#hitRadius * 0.6 ) {
      this.finishDraft();
      return;
    }
    d.nodes.push(makeNode(q.x, q.y, {smooth: Editor.opts.penSmooth}));
    this.refresh();
  }

  /** @override */
  _onClickLeft2(event) {
    const p = event.interactionData.origin;
    const tool = game.activeTool;
    if ( tool === "kaaPen" ) {
      this.finishDraft();
      return;
    }
    if ( tool !== "kaaEdit" ) return;
    const anim = Editor.anim;
    const step = Editor.step;
    if ( !anim || !step || (step.shape.type !== "path") ) return;
    const h = this.#hitHandle(p);
    if ( h?.kind === "node" ) {
      // Toggle a node between a sharp corner and a smooth curve
      Store.mutate(anim.id, a => {
        const n = a.steps.find(st => st.id === step.id).shape.nodes[h.index];
        const smooth = (n.mode === "manual") || (n.smooth > 0);
        n.mode = "auto";
        n.hin = n.hout = null;
        n.smooth = smooth ? 0 : 1;
      });
      return;
    }
    // Insert a node on the curve
    const built = buildShape(step.shape);
    const near = this.#nearestCurve(built, h ?? p);
    if ( !near || (near.dist > 12 * this.#s) ) return;
    Store.mutate(anim.id, a => {
      const sh = a.steps.find(st => st.id === step.id).shape;
      const i = near.index;
      const prev = sh.nodes[i];
      const next = sh.nodes[(i + 1) % sh.nodes.length];
      const smooth = Math.max(prev.smooth || 0, next.smooth || 0, prev.mode === "manual" ? 1 : 0);
      const bend = prev.bend || 0;
      prev.bend = bend / 2;
      sh.nodes.splice(i + 1, 0, makeNode(near.x, near.y, {smooth: bend ? Math.max(smooth, 0.6) : smooth, bend: bend / 2}));
    }).then(() => Editor.select(anim.id, step.id, {type: "node", index: near.index + 1}));
  }

  /** @override */
  _onClickRight(event) {
    const p = event.interactionData.origin;
    const tool = game.activeTool;
    if ( tool === "kaaPen" ) {
      const d = this.#draft;
      if ( !d ) return;
      d.nodes.pop();
      if ( !d.nodes.length ) this.#draft = null;
      this.refresh();
      return;
    }
    if ( tool !== "kaaEdit" ) return;
    const anim = Editor.anim;
    const step = Editor.step;
    const h = anim ? this.#hitHandle(p) : null;
    if ( !h || !step ) return;
    if ( h.kind === "node" ) this.#deleteNode(anim, step, h.index);
    else if ( (h.kind === "hin") || (h.kind === "hout") ) {
      Store.mutate(anim.id, a => {
        const n = a.steps.find(st => st.id === step.id).shape.nodes[h.index];
        n.mode = "auto";
        n.hin = n.hout = null;
        n.smooth = n.smooth || 1;
      });
    } else if ( h.kind === "bend" ) {
      Store.mutate(anim.id, a => {
        a.steps.find(st => st.id === step.id).shape.nodes[h.index].bend = 0;
      });
    }
  }

  #deleteNode(anim, step, index) {
    const sh = step.shape;
    const min = sh.closed ? 3 : 2;
    if ( sh.nodes.length <= min ) {
      if ( sh.closed && (sh.nodes.length === 3) ) {
        // Opening the loop is the gentlest way to lose a node from a triangle
        Store.mutate(anim.id, a => {
          const s2 = a.steps.find(st => st.id === step.id).shape;
          s2.nodes.splice(index, 1);
          s2.closed = false;
        });
      } else ui.notifications.info("KAA.Info.MinNodes", {localize: true});
      return;
    }
    Store.mutate(anim.id, a => {
      a.steps.find(st => st.id === step.id).shape.nodes.splice(index, 1);
    }).then(() => Editor.select(anim.id, step.id, null));
  }

  /* -------------------------------------------- */
  /*  Mouse: drags                                */
  /* -------------------------------------------- */

  /** @override */
  _canDragLeftStart(_user, _event) {
    return true;
  }

  /** @override */
  _onDragLeftStart(event) {
    const tool = game.activeTool;
    const p = event.interactionData.origin;
    if ( tool === "kaaEdit" ) return this.#editDragStart(event, p);
    if ( tool === "kaaPen" ) {
      if ( this.#draft?.nodes?.length ) this.#drag = {type: "pen-handle"};
      return;
    }
    if ( tool === "kaaFreehand" ) {
      const q = this.#magnet(p) ?? p;
      this.#draft = {tool, points: [{x: q.x, y: q.y}]};
      return;
    }
    if ( DRAG_SHAPE_TOOLS.has(tool) ) {
      const q = this.#gridSnap(p, event);
      this.#draft = {tool, a: q, b: q, shape: null};
    }
  }

  #editDragStart(event, p) {
    const anim = Editor.anim;
    if ( !anim ) return;
    const base = foundry.utils.deepClone(anim);
    const h = this.#hitHandle(p);
    if ( h ) {
      this.#drag = {type: "handle", h, base, p0: p, stepId: Editor.stepId};
      return;
    }
    const hit = this.#hitPath(p, anim);
    if ( hit ) {
      Editor.select(anim.id, hit.step.id, hit.step.id === Editor.stepId ? Editor.sel : null);
      this.#drag = {type: "move", base, p0: this.#gridSnap(p, event), stepId: hit.step.id, all: event.altKey};
    }
  }

  /** @override */
  _onDragLeftMove(event) {
    const tool = game.activeTool;
    const dest = event.interactionData.destination;
    const d = this.#draft;
    if ( tool === "kaaPen" && (this.#drag?.type === "pen-handle") && d?.nodes?.length ) {
      const n = d.nodes.at(-1);
      const v = {x: dest.x - n.x, y: dest.y - n.y};
      n.mode = "manual";
      n.hout = v;
      n.hin = {x: -v.x, y: -v.y};
      this.scheduleRefresh();
      return;
    }
    if ( tool === "kaaFreehand" && d?.points ) {
      const last = d.points.at(-1);
      if ( dist(last, dest) >= 3 * this.#s ) d.points.push({x: dest.x, y: dest.y});
      this.scheduleRefresh();
      return;
    }
    if ( DRAG_SHAPE_TOOLS.has(tool) && d?.a ) {
      d.b = this.#gridSnap(dest, event);
      d.shape = this.#draftShape(d, event);
      this.scheduleRefresh();
      return;
    }
    if ( tool === "kaaEdit" && this.#drag ) this.#editDragMove(event, dest);
  }

  /** @override */
  async _onDragLeftDrop(event) {
    const tool = game.activeTool;
    const d = this.#draft;
    if ( tool === "kaaPen" ) {
      this.#drag = null;
      return;
    }
    if ( tool === "kaaFreehand" && d?.points ) {
      this.#draft = null;
      this.#finishFreehand(d.points);
      return;
    }
    if ( DRAG_SHAPE_TOOLS.has(tool) && d?.a ) {
      this.#draft = null;
      const shape = d.shape;
      if ( shape && (dist(d.a, d.b) > 4 * this.#s) ) await this.#commitShape(shape);
      this.refresh();
      return;
    }
    if ( tool === "kaaEdit" && this.#drag ) {
      const drag = this.#drag;
      this.#drag = null;
      const preview = Editor.preview?.anim;
      if ( !preview ) return;
      if ( drag.closeTarget ) this.#applyClose(preview, drag);
      await Store.save(preview);
      Editor.setPreview(null);
    }
  }

  /** @override */
  _onDragLeftCancel(event) {
    if ( this.#drag?.type !== "pen-handle" ) {
      if ( game.activeTool !== "kaaPen" ) this.#draft = null;
    }
    this.#drag = null;
    if ( Editor.preview ) Editor.setPreview(null);
    this.refresh();
  }

  #finishFreehand(points) {
    if ( points.length < 2 ) return this.refresh();
    const eps = Math.max(0.75, 2 * this.#s);
    let simple = simplifyRDP(points, eps);
    let closed = false;
    const span = dist(points[0], points.at(-1));
    if ( (simple.length > 4) && (span <= 18 * this.#s) ) {
      simple = simple.slice(0, -1);
      closed = true;
    }
    if ( simple.length < 2 ) return this.refresh();
    const nodes = simple.map(p => makeNode(p.x, p.y, {smooth: 1}));
    this.#commitShape({type: "path", nodes, closed});
    this.refresh();
  }

  #draftShape(d, event) {
    const a = d.a;
    const b = d.b ?? d.a;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const r = Math.hypot(dx, dy);
    const grid = canvas.dimensions.size;
    const o = Editor.opts;
    switch ( d.tool ) {
      case "kaaEllipse": {
        let rx = Math.abs(dx);
        let ry = Math.abs(dy);
        if ( event.shiftKey ) rx = ry = r;
        return {type: "ellipse", cx: a.x, cy: a.y, rx: Math.max(1, rx), ry: Math.max(1, ry), rotation: 0, sweep: 360};
      }
      case "kaaRect": {
        let w = Math.abs(dx);
        let h = Math.abs(dy);
        if ( event.shiftKey ) w = h = Math.max(w, h);
        if ( event.altKey ) return {type: "rect", cx: a.x, cy: a.y, w: Math.max(1, w * 2), h: Math.max(1, h * 2), rotation: 0, radius: 0};
        const cx = a.x + (Math.sign(dx || 1) * w / 2);
        const cy = a.y + (Math.sign(dy || 1) * h / 2);
        return {type: "rect", cx, cy, w: Math.max(1, w), h: Math.max(1, h), rotation: 0, radius: 0};
      }
      case "kaaPolygon": {
        let rot = toDeg(Math.atan2(dy, dx)) + 90;
        if ( event.shiftKey ) rot = Math.round(rot / 15) * 15;
        return {type: "polygon", cx: a.x, cy: a.y, radius: Math.max(1, r), sides: o.polygonSides, rotation: rot,
          star: o.polygonStar, smooth: 0};
      }
      case "kaaSpiral": {
        const turns = o.spiralTurns;
        const rot = toDeg(Math.atan2(dy, dx)) - (360 * turns);
        return {type: "spiral", cx: a.x, cy: a.y, r0: Math.max(0, r * o.spiralInner), r1: Math.max(1, r), turns, rotation: rot, ccw: false};
      }
      case "kaaWave":
        return {type: "wave", x0: a.x, y0: a.y, x1: b.x, y1: b.y, amplitude: o.waveAmplitude * grid,
          wavelength: Math.max(8, o.waveLength * grid), form: o.waveForm};
      case "kaaFigure8": {
        const w = Math.max(2, Math.abs(dx) * 2);
        const h = event.shiftKey ? w / 2 : Math.max(2, Math.abs(dy) * 2);
        return {type: "figure8", cx: a.x, cy: a.y, w, h, rotation: 0};
      }
    }
    return null;
  }

  /* -------------------------------------------- */
  /*  Edit dragging                               */
  /* -------------------------------------------- */

  #editDragMove(event, dest) {
    const drag = this.#drag;
    const anim = foundry.utils.deepClone(drag.base);
    const step = anim.steps.find(st => st.id === drag.stepId);
    if ( !step ) return;
    const sh = step.shape;
    const q = this.#gridSnap(dest, event);
    drag.closeTarget = null;
    drag.closeHint = null;

    if ( drag.type === "move" ) {
      const dx = q.x - drag.p0.x;
      const dy = q.y - drag.p0.y;
      const targets = drag.all ? anim.steps : [step];
      for ( const st of targets ) st.shape = translateShape(st.shape, dx, dy);
      if ( drag.all && anim.facing.point ) anim.facing.point = {x: anim.facing.point.x + dx, y: anim.facing.point.y + dy};
      Editor.setPreview(anim);
      return;
    }

    const h = drag.h;
    const c = {x: sh.cx, y: sh.cy};
    const rot = toRad(sh.rotation ?? 0);
    const local = () => rotateAround(q, c, -rot);
    switch ( h.kind ) {
      case "node": {
        const m = this.#magnet(q, {exclude: {stepId: step.id, index: h.index}});
        const target = m ?? q;
        const node = sh.nodes[h.index];
        node.x = target.x;
        node.y = target.y;
        // Dropping one end of an open path onto its other end closes the loop
        const n = sh.nodes.length;
        if ( m && !sh.closed && (n >= 3) && (m.stepId === step.id)
          && (((h.index === n - 1) && (m.index === 0)) || ((h.index === 0) && (m.index === n - 1))) ) {
          drag.closeTarget = {stepId: step.id, index: h.index};
          drag.closeHint = {x: m.x, y: m.y};
        }
        break;
      }
      case "hin":
      case "hout": {
        const node = sh.nodes[h.index];
        const baseNodes = drag.base.steps.find(st => st.id === step.id).shape.nodes;
        const auto = nodeHandles(baseNodes, h.index, sh.closed);
        if ( node.mode !== "manual" ) {
          node.hin = {...auto.hin};
          node.hout = {...auto.hout};
          node.mode = "manual";
        }
        node.hin ??= {...auto.hin};
        node.hout ??= {...auto.hout};
        const v = {x: dest.x - node.x, y: dest.y - node.y};
        const other = h.kind === "hin" ? "hout" : "hin";
        node[h.kind] = v;
        if ( !event.altKey ) {
          // Keep the node smooth: mirror direction, preserve the opposite handle's length
          const len = Math.hypot(node[other].x, node[other].y) || Math.hypot(v.x, v.y);
          const vl = Math.hypot(v.x, v.y) || 1;
          node[other] = {x: -v.x / vl * len, y: -v.y / vl * len};
        }
        break;
      }
      case "bend": {
        const i = h.index;
        const nodes = sh.nodes;
        const a = nodes[i];
        const b = nodes[(i + 1) % nodes.length];
        const L = dist(a, b);
        if ( L < 1e-6 ) break;
        const saved = a.bend;
        a.bend = 0;
        const flat = pathCurves(sh).curves.find(cv => cv.index === i);
        const m0 = bez(flat, 0.5);
        const nx = -(b.y - a.y) / L;
        const ny = (b.x - a.x) / L;
        const hgt = ((dest.x - m0.x) * nx) + ((dest.y - m0.y) * ny);
        a.bend = clamp((2 * hgt) / L, -2, 2);
        if ( event.shiftKey ) a.bend = Math.round(a.bend * 10) / 10;
        if ( !Number.isFinite(a.bend) ) a.bend = saved;
        Editor.sel = {type: "segment", index: i};
        break;
      }
      case "center":
        step.shape = translateShape(sh, q.x - c.x, q.y - c.y);
        break;
      case "ell-rx": {
        const l = local();
        sh.rx = Math.max(2, Math.abs(l.x - c.x));
        if ( event.shiftKey ) sh.ry = sh.rx;
        break;
      }
      case "ell-ry": {
        const l = local();
        sh.ry = Math.max(2, Math.abs(l.y - c.y));
        if ( event.shiftKey ) sh.rx = sh.ry;
        break;
      }
      case "rotate": {
        let deg = toDeg(Math.atan2(dest.y - c.y, dest.x - c.x)) - h.base;
        if ( event.shiftKey ) deg = Math.round(deg / 15) * 15;
        sh.rotation = deg;
        break;
      }
      case "rect-corner": {
        const l = local();
        let w = Math.max(2, Math.abs(l.x - c.x) * 2);
        let hh = Math.max(2, Math.abs(l.y - c.y) * 2);
        if ( event.shiftKey ) w = hh = Math.max(w, hh);
        sh.w = w;
        sh.h = hh;
        sh.radius = Math.min(sh.radius, Math.min(w, hh) / 2);
        break;
      }
      case "poly-radius": {
        sh.radius = Math.max(2, dist(c, q));
        let deg = toDeg(Math.atan2(q.y - c.y, q.x - c.x)) + 90;
        if ( event.shiftKey ) deg = Math.round(deg / 15) * 15;
        sh.rotation = deg;
        break;
      }
      case "spiral-outer": {
        sh.r1 = Math.max(2, dist(c, q));
        const dir = sh.ccw ? -1 : 1;
        sh.rotation = toDeg(Math.atan2(q.y - c.y, q.x - c.x)) - (dir * 360 * sh.turns);
        break;
      }
      case "wave-a":
        sh.x0 = q.x;
        sh.y0 = q.y;
        break;
      case "wave-b":
        sh.x1 = q.x;
        sh.y1 = q.y;
        break;
      case "wave-amp": {
        const a = {x: sh.x0, y: sh.y0};
        const b = {x: sh.x1, y: sh.y1};
        const L = dist(a, b) || 1;
        const ux = (b.x - a.x) / L;
        const uy = (b.y - a.y) / L;
        const along = ((dest.x - a.x) * ux) + ((dest.y - a.y) * uy);
        const perp = ((dest.x - a.x) * -uy) + ((dest.y - a.y) * ux);
        sh.amplitude = perp;
        sh.wavelength = Math.max(8, along * 4);
        break;
      }
      case "f8-size": {
        const l = local();
        sh.w = Math.max(4, Math.abs(l.x - c.x) * 2);
        sh.h = event.shiftKey ? sh.w / 2 : Math.max(4, Math.abs(l.y - c.y) * 2);
        break;
      }
      case "point": {
        const m = this.#magnet(q);
        sh.x = m?.x ?? q.x;
        sh.y = m?.y ?? q.y;
        break;
      }
      case "start": {
        const built = buildShape(drag.base.steps.find(st => st.id === step.id).shape);
        const n = built.lut.nearest(dest.x, dest.y);
        let f = built.lut.length > 0 ? n.d / built.lut.length : 0;
        if ( event.shiftKey ) f = Math.round(f * 24) / 24;
        step.startOffset = f >= 1 ? 0 : f;
        break;
      }
    }
    Editor.setPreview(anim);
  }

  /** Merge a dragged path end onto its other end and close the loop. */
  #applyClose(anim, drag) {
    const step = anim.steps.find(st => st.id === drag.closeTarget.stepId);
    if ( !step || (step.shape.type !== "path") ) return;
    const sh = step.shape;
    const n = sh.nodes.length;
    if ( drag.closeTarget.index === n - 1 ) sh.nodes.pop();
    else sh.nodes.shift();
    sh.closed = true;
    ui.notifications.info("KAA.Info.PathClosed", {localize: true});
  }

  /* -------------------------------------------- */
  /*  Keys                                        */
  /* -------------------------------------------- */

  /** @override */
  _onDeleteKey(_event) {
    const anim = Editor.anim;
    const step = Editor.step;
    if ( !anim || !step ) return false;
    if ( (Editor.sel?.type === "node") && (step.shape.type === "path") ) {
      this.#deleteNode(anim, step, Editor.sel.index);
      return true;
    }
    Store.mutate(anim.id, a => {
      a.steps = a.steps.filter(st => st.id !== step.id);
    }).then(() => Editor.select(anim.id, null, null));
    return true;
  }

  /** @override */
  _onUndoKey(_event) {
    const id = Editor.animId;
    if ( !id || !Store.canUndo(id) ) return false;
    Store.undo(id);
    return true;
  }

  /** @override */
  _onDismissKey(_event) {
    if ( Editor.picking ) {
      Editor.setPicking(null);
      return true;
    }
    if ( this.#draft ) {
      this.#draft = null;
      this.refresh();
      return true;
    }
    if ( Editor.sel ) {
      Editor.select(Editor.animId, Editor.stepId, null);
      return true;
    }
    if ( Editor.stepId ) {
      Editor.select(Editor.animId, null, null);
      return true;
    }
    return false;
  }

  /* -------------------------------------------- */
  /*  Preview ghost                               */
  /* -------------------------------------------- */

  #syncGhost() {
    if ( Editor.ghost && this.active && Editor.anim ) this.#startGhost();
    else this.#stopGhost();
  }

  #startGhost() {
    const g = this.#ghost;
    g.tau = 0;
    g.key = null;
    if ( g.running ) return;
    g.running = true;
    canvas.app.ticker.add(this.#ghostTick, this, PIXI.UPDATE_PRIORITY.LOW);
  }

  #stopGhost() {
    const g = this.#ghost;
    if ( g.running ) canvas.app?.ticker?.remove(this.#ghostTick, this);
    g.running = false;
    g.tl = null;
    g.key = null;
    for ( const sp of g.sprites ?? [] ) if ( !sp.destroyed ) sp.destroy({children: true});
    g.sprites = [];
  }

  /** The token the preview ghost imitates: first assigned token, else a selected one. */
  #ghostToken(anim) {
    const ids = anim.tokens.filter(id => canvas.scene.tokens.has(id));
    const doc = canvas.scene.tokens.get(ids[0]) ?? canvas.tokens.controlled[0]?.document ?? null;
    return doc;
  }

  /** Everything the preview ghost needs to imitate a real playback right now. */
  #ghostEnv(anim, origin, originId) {
    const center = id => {
      const t = canvas.scene.tokens.get(id);
      if ( !t ) return null;
      const p = tokenPivot(t);
      return {x: t.x + p.x, y: t.y + p.y};
    };
    const aimed = [...(game.user.targets ?? [])].map(t => t.document)
      .filter(d => (d?.parent === canvas.scene) && (d.id !== originId));
    const {anchor, strikes: targets} = aimTargets(anim, canvas.scene, aimed);
    const snapTargets = targets.map(d => ({id: d.id, ...center(d.id)}));
    let anchorStart = null;
    if ( anchor ) {
      const c = center(anchor.id);
      if ( c ) anchorStart = {id: anchor.id, ...c};
    }
    const points = {};
    for ( const st of anim.steps ) {
      if ( (st.shape.type === "homing") && (st.shape.to === "token") && st.shape.tokenId ) {
        const c = center(st.shape.tokenId);
        if ( c ) points[st.shape.tokenId] = c;
      }
    }
    return {origin, center, targetIds: targets.map(d => d.id), snapTargets, anchorStart, points};
  }

  #ghostTick() {
    const anim = Editor.anim;
    const g = this.#ghost;
    if ( !anim || !Editor.ghost || !this.active || !this.#ghostLayer ) {
      this.#stopGhost();
      return;
    }
    const doc = this.#ghostToken(anim);
    const targetIds = [...(game.user.targets ?? [])].map(t => t.id).join(",");
    const key = `${anim.id}|${anim.rev}|${Editor.previewVersion}|${doc?.id}|${doc?._source.x}|${doc?._source.y}|${targetIds}`;
    if ( key !== g.key ) {
      g.key = key;
      const first = firstGeometricStep(anim);
      const origin = this.#previewOrigin(anim) ?? (first ? stepEndpoints(first).start : {x: 0, y: 0});
      g.originRotation = doc?._source.rotation ?? 0;
      g.env = this.#ghostEnv(anim, origin, doc?.id);
      const env = g.env;
      const snapshot = spec => {
        switch ( spec.to ) {
          case "target": return env.snapTargets.length ? env.snapTargets[spec.index % env.snapTargets.length] : null;
          case "home": return origin;
          case "anchor": return env.anchorStart;
          case "token": return env.points[spec.tokenId] ?? null;
        }
        return null;
      };
      g.tl = compileTimeline(anim, {origin, dims: {size: canvas.dimensions.size, distance: canvas.dimensions.distance || 1},
        resolve: snapshot});
      const c = symmetryCenterFor(anim, origin, g.tl.offset);
      g.syms = [];
      for ( let i = 0; i < anim.symmetry.count; i++ ) {
        g.syms.push({i, n: anim.symmetry.count, mode: anim.symmetry.mode, axis: anim.symmetry.axis, cx: c.x, cy: c.y});
      }
      for ( const sp of g.sprites ?? [] ) if ( !sp.destroyed ) sp.destroy({children: true});
      g.sprites = g.syms.map(() => this.#makeMascot());
      for ( const sp of g.sprites ) this.#ghostLayer.addChild(sp);
    }
    const tl = g.tl;

    // The ghost runs on its own clock, scaled by the panel's Rate slider (so rate changes never make it jump)
    const dt = Math.min(100, canvas.app.ticker.deltaMS || 16);
    g.tau = (g.tau ?? 0) + (dt * Math.max(0, Editor.rate ?? 1));
    if ( !tl.infinite && (g.tau > tl.duration + 900) ) g.tau = 0;
    const tau = tl.infinite ? g.tau : Math.min(g.tau, tl.duration + 1);
    const size = canvas.dimensions.size;
    const fx = anim.height;
    const wall = performance.now() / 1000;
    g.syms.forEach((sym, i) => {
      const pose = composePose(tl, anim, tau, {
        ...g.env, sym, originRotation: g.originRotation, grid: size,
        targetCenter: (f, pos) => this.#ghostTarget(f, pos)
      });
      const sp = g.sprites[i];
      const [shadow, body] = sp.children;
      sp.position.set(pose.x, pose.y);
      body.position.set(0, -pose.z * size * fx.rise);
      body.scale.set(1 + (pose.z * fx.scale));
      if ( pose.rotation !== undefined ) body.angle = pose.rotation;
      // Flutter
      const wings = body.wings;
      if ( wings ) {
        const f = 1 + (0.25 * Math.sin((wall * 14) + i));
        wings[0].scale.y = f;
        wings[1].scale.y = f;
      }
      shadow.visible = fx.shadow && (pose.z > 0);
      if ( shadow.visible ) {
        const fade = 1 / (1 + (pose.z * 0.6));
        shadow.scale.set(fade);
        shadow.alpha = fade;
      }
    });
  }

  /** Nearest matching token for the ghost's "smart target" facing (editor preview only). */
  #ghostTarget(facing, pos) {
    let best = null;
    let bestD = Infinity;
    for ( const t of canvas.scene.tokens ) {
      if ( t.hidden ) continue;
      if ( (facing.target.group === "custom") && !facing.target.tokens.includes(t.id) ) continue;
      const p = tokenPivot(t);
      const c = {x: t.x + p.x, y: t.y + p.y};
      const d = Math.hypot(c.x - pos.x, c.y - pos.y);
      if ( d < 1 ) continue;
      const score = facing.target.rule === "farthest" ? -d : d;
      if ( score < bestD ) {
        bestD = score;
        best = c;
      }
    }
    return best;
  }

  /**
   * The module's mascot, "Flit": a little winged comet that stands in for any token in previews.
   * Drawn facing down (rotation 0), the same convention Foundry uses for token art.
   */
  #makeMascot() {
    const size = canvas.dimensions.size;
    const r = size * 0.3;
    const c = new PIXI.Container();
    c.alpha = 0.92;

    const shadow = newGraphics();
    shadow.beginFill(0x000000, 0.35);
    shadow.drawEllipse(0, r * 0.55, r * 0.95, r * 0.45);
    shadow.endFill();
    shadow.visible = false;
    c.addChild(shadow);

    const body = new PIXI.Container();
    const g = newGraphics();
    // Glow
    for ( const [k, a] of [[2.1, 0.06], [1.75, 0.09], [1.45, 0.13]] ) {
      g.beginFill(0xffb347, a);
      g.drawCircle(0, 0, r * k);
      g.endFill();
    }
    // Comet tail streaming behind (up, since it faces down)
    for ( const [w, len, color, a] of [[1, 2.9, 0xff7a3d, 0.35], [0.72, 2.4, 0xffb347, 0.5], [0.42, 1.9, 0xfff1c9, 0.65]] ) {
      g.beginFill(color, a);
      g.drawPolygon([-r * w, -r * 0.1, 0, -r * len, r * w, -r * 0.1]);
      g.endFill();
    }
    body.addChild(g);

    // Wings (flutter in the ticker)
    const wing = side => {
      const w = newGraphics();
      w.beginFill(0xffffff, 0.85);
      w.lineStyle({width: Math.max(1, r * 0.06), color: 0x2a1a10, alpha: 0.6});
      w.drawEllipse(side * r * 0.95, -r * 0.15, r * 0.55, r * 0.28);
      w.endFill();
      w.pivot.set(side * r * 0.5, -r * 0.15);
      w.position.set(side * r * 0.5, -r * 0.15);
      body.addChild(w);
      return w;
    };
    body.wings = [wing(-1), wing(1)];

    const f = newGraphics();
    // Body with a highlight
    f.lineStyle({width: Math.max(1.5, r * 0.08), color: 0x2a1a10, alpha: 0.9});
    f.beginFill(0xff7a3d, 1);
    f.drawCircle(0, 0, r);
    f.endFill();
    f.lineStyle(0);
    f.beginFill(0xffd29a, 0.4);
    f.drawEllipse(-r * 0.38, -r * 0.42, r * 0.26, r * 0.17);
    f.endFill();
    f.beginFill(0xffffff, 0.8);
    f.drawCircle(-r * 0.46, -r * 0.48, r * 0.08);
    f.endFill();
    // Eyes looking where it is going (down)
    for ( const side of [-1, 1] ) {
      f.beginFill(0xffffff, 1);
      f.drawEllipse(side * r * 0.36, r * 0.18, r * 0.22, r * 0.27);
      f.endFill();
      f.beginFill(0x1b0f06, 1);
      f.drawCircle(side * r * 0.33, r * 0.28, r * 0.12);
      f.endFill();
      f.beginFill(0xffffff, 1);
      f.drawCircle(side * r * 0.29, r * 0.23, r * 0.04);
      f.endFill();
    }
    // Smile
    f.lineStyle({width: Math.max(1, r * 0.07), color: 0x1b0f06, alpha: 0.9});
    f.arc(0, r * 0.5, r * 0.18, 0.25 * Math.PI, 0.75 * Math.PI);
    // Heading chevron
    f.lineStyle(0);
    f.beginFill(0xffffff, 0.95);
    f.drawPolygon([0, r * 1.45, -r * 0.22, r * 1.12, r * 0.22, r * 1.12]);
    f.endFill();
    body.addChild(f);
    c.addChild(body);
    return c;
  }
}
