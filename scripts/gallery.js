// Template gallery: built-in and user templates, one click to apply to tokens.

import {LAYER_NAME, MODULE_ID} from "./const.js";
import {Editor} from "./editor.js";
import {Store, aimTargets, needsTargets} from "./model.js";
import {Playback, resolveTokens, tokenPivot} from "./playback.js";
import {BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES} from "./templates.js";
import {animationSVG} from "./thumbs.js";
import {rememberPosition, savePosition, savedPosition} from "./window-ui.js";

const {ApplicationV2, HandlebarsApplicationMixin, DialogV2} = foundry.applications.api;

/**
 * Tokens the user has targeted on a scene, in targeting order, leaving out the given movers.
 * @param {Scene} scene
 * @param {TokenDocument[]} [movers]
 * @param {Array<string|Token|TokenDocument>} [targets]   Explicit targets instead of the user's
 */
function aimedTokens(scene, movers=[], targets) {
  const ids = new Set(movers.map(d => d.id));
  const list = targets ? resolveTokens(targets, scene) : [...(game.user.targets ?? [])].map(t => t.document);
  return list.filter(d => (d?.parent === scene) && !ids.has(d.id));
}

/**
 * Put a template on a scene for some tokens: around the token it follows, otherwise starting at the first token
 * (or the middle of the view).
 * @param {object} tpl
 * @param {TokenDocument[]} tokens
 * @param {object} [options]
 * @param {Scene} [options.scene]
 * @param {boolean} [options.link]              Keep it linked to the template (Save to template)
 * @param {boolean} [options.requireTargets]    Refuse (with a warning) if it flies at targets and none are targeted
 * @param {Array} [options.targets]             Explicit targets instead of the current user's
 * @returns {Promise<object|null>}
 */
export async function placeTemplate(tpl, tokens, {scene, link=false, requireTargets=true, targets}={}) {
  scene = Store.scene(scene);
  if ( requireTargets && needsTargets(tpl) && !aimedTokens(scene, tokens, targets).length ) {
    ui.notifications.warn("KAA.Warn.NeedsTarget", {localize: true});
    return null;
  }
  const at = placementPoint(tpl, tokens, scene, targets);
  return Store.insert(tpl, {scene, at, tokens: tokens.map(t => t.id), link});
}

/**
 * Put a template on the scene and open it in the editor, its path shown and its first shape selected.
 * @param {object} tpl
 * @param {TokenDocument[]} tokens   Where it goes (and the tokens it is for)
 * @param {object} [options]
 * @param {boolean} [options.link]   Stay linked to the template, so changes can be saved back into it
 */
export async function openTemplateInEditor(tpl, tokens, {link=false}={}) {
  const at = placementPoint(tpl, tokens);
  const anim = await placeTemplate(tpl, tokens, {link, requireTargets: false});
  if ( !anim ) return null;
  canvas[LAYER_NAME]?.activate({tool: "kaaEdit"});
  game.modules.get(MODULE_ID).api.openPanel({animId: anim.id, tab: "path"});
  Editor.select(anim.id, anim.steps[0]?.id ?? null);
  canvas.animatePan?.({x: at.x, y: at.y, duration: 300});
  return anim;
}

/** Where a template goes: the centre of the token it follows, else of the first token, else the middle of the view. */
export function placementPoint(tpl, tokens, scene=canvas.scene, targets) {
  const center = d => {
    const p = tokenPivot(d);
    return {x: d._source.x + p.x, y: d._source.y + p.y};
  };
  if ( tpl.motion?.anchor === "token" ) {
    const {anchor} = aimTargets(tpl, scene, aimedTokens(scene, tokens, targets));
    if ( anchor ) return center(anchor);
  }
  return tokens.length ? center(tokens[0]) : {x: canvas.stage.pivot.x, y: canvas.stage.pivot.y};
}

export class TemplateGallery extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "kaa-gallery",
    classes: ["kaa-panel", "kaa-gallery"],
    window: {title: "Animation templates", icon: "fa-solid fa-shapes", resizable: true},
    position: {width: 940, height: 680},
    actions: {
      pickCategory: TemplateGallery.#onCategory,
      applyTemplate: TemplateGallery.#onApply,
      addTemplate: TemplateGallery.#onAdd,
      editTemplate: TemplateGallery.#onEdit,
      deleteTemplate: TemplateGallery.#onDelete
    }
  };

  static PARTS = {
    main: {template: `modules/${MODULE_ID}/templates/gallery.hbs`, scrollable: [".kaa-gallery-grid"]}
  };

  static #instance = null;

  /**
   * Open the gallery.
   * @param {object} [options]
   * @param {string} [options.category]     "all" | a category key
   * @param {string[]} [options.tokenIds]   Apply to these tokens instead of the selection
   */
  static open({category, tokenIds}={}) {
    const app = this.#instance ??= new this({position: savedPosition(this.DEFAULT_OPTIONS.id)});
    if ( category ) app.#category = category;
    app.#tokenIds = tokenIds ?? null;
    app.render({force: true});
    if ( app.rendered ) app.bringToFront();
    return app;
  }

  #category = "all";

  #search = "";

  #tokenIds = null;

  /** @override */
  setPosition(position) {
    const out = super.setPosition(position);
    rememberPosition(this);
    return out;
  }

  /** @override */
  async _prepareContext(_options) {
    const mine = Store.library().map(t => ({...t, mine: true}));
    const all = [...BUILTIN_TEMPLATES.map(t => ({...t, mine: false})), ...mine];
    const q = this.#search.trim().toLowerCase();
    const inCategory = t => (this.#category === "all") || (this.#category === "mine" ? t.mine : t.category === this.#category);
    const cards = all.filter(inCategory).map(t => {
      const sym = t.symmetry?.count ?? 1;
      const lifted = (t.steps ?? []).some(s => s.lift && (s.lift.mode !== "none"));
      const loop = t.motion?.loop && (t.motion.loop !== "none");
      return {
        id: t.id, name: t.name, description: t.description || "", mine: t.mine, builtin: !t.mine,
        category: TEMPLATE_CATEGORIES[t.category]?.label ?? "My templates",
        svg: animationSVG(t, {width: 200, height: 120}),
        badges: [
          sym > 1 ? {icon: "fa-solid fa-snowflake", label: `×${sym}`} : null,
          lifted ? {icon: "fa-solid fa-basketball", label: "height"} : null,
          loop ? {icon: "fa-solid fa-repeat", label: t.motion.loopCount ? `×${t.motion.loopCount}` : "∞"} : null,
          t.motion?.anchor === "relative" ? {icon: "fa-solid fa-user", label: "on token"} : null,
          t.motion?.anchor === "token" ? {icon: "fa-solid fa-link", label: "follows target"} : null,
          (t.steps ?? []).some(s => s.shape?.type === "homing") ? {icon: "fa-solid fa-crosshairs", label: "homing"} : null
        ].filter(Boolean),
        search: `${t.name} ${t.description ?? ""}`.toLowerCase(),
        hidden: !!q && !`${t.name} ${t.description ?? ""}`.toLowerCase().includes(q)
      };
    });
    const count = key => all.filter(t => (key === "all") || (key === "mine" ? t.mine : t.category === key)).length;
    const categories = [{key: "all", label: "All templates", icon: "fa-solid fa-shapes"},
      ...Object.entries(TEMPLATE_CATEGORIES).map(([key, c]) => ({key, ...c}))]
      .map(c => ({...c, count: count(c.key), active: c.key === this.#category}));
    const targets = this.#targets();
    const aimed = canvas.scene ? aimedTokens(canvas.scene, targets) : [];
    const names = list => list.slice(0, 3).map(t => t.name).join(", ") + (list.length > 3 ? "…" : "");
    return {
      cards, categories, search: this.#search,
      targets: targets.length, targetNames: names(targets),
      aimed: aimed.length, aimedNames: names(aimed),
      canEdit: Store.canEdit(),
      empty: !cards.length
    };
  }

  /** @inheritDoc */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element.addEventListener("input", event => {
      if ( event.target.name !== "search" ) return;
      this.#search = event.target.value;
      const q = this.#search.trim().toLowerCase();
      for ( const card of this.element.querySelectorAll(".kaa-card-tpl") ) {
        card.hidden = !!q && !card.dataset.search.includes(q);
      }
    });
    this.#refresh = () => this.render();
    Hooks.on("controlToken", this.#refresh);
  }

  #refresh = null;

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    savePosition(this);
    if ( this.#refresh ) Hooks.off("controlToken", this.#refresh);
    TemplateGallery.#instance = null;
  }

  /** Tokens a template will be applied to. */
  #targets() {
    if ( !canvas.scene ) return [];
    if ( this.#tokenIds?.length ) return this.#tokenIds.map(id => canvas.scene.tokens.get(id)).filter(Boolean);
    return canvas.tokens.controlled.map(t => t.document);
  }

  #find(id) {
    return BUILTIN_TEMPLATES.find(t => t.id === id) ?? Store.library().find(t => t.id === id) ?? null;
  }

  /* -------------------------------------------- */

  static #onCategory(_event, target) {
    this.#category = target.dataset.category;
    this.render();
  }

  /** Create the animation from a template and play it on the target tokens right away. */
  static async #onApply(_event, target) {
    const tpl = this.#find(target.closest("[data-template-id]").dataset.templateId);
    const tokens = this.#targets();
    if ( !tpl ) return;
    if ( !tokens.length ) return ui.notifications.warn("KAA.Warn.SelectTokens", {localize: true});
    const anim = await placeTemplate(tpl, tokens);
    if ( !anim ) return;
    Editor.select(anim.id);
    await Playback.play(anim, tokens);
    ui.notifications.info(game.i18n.format("KAA.Info.TemplateApplied", {name: tpl.name, count: tokens.length}));
  }

  /** Add the template to the scene for editing (at the selected token, or the centre of the view). */
  static async #onAdd(_event, target) {
    const tpl = this.#find(target.closest("[data-template-id]").dataset.templateId);
    if ( tpl ) await this.#openInEditor(tpl, {link: false});
  }

  /**
   * Edit a template: your own templates stay linked so changes can be saved back; built-in ones become an
   * editable copy that can be saved as your own template.
   */
  static async #onEdit(_event, target) {
    const tpl = this.#find(target.closest("[data-template-id]").dataset.templateId);
    if ( tpl ) await this.#openInEditor(tpl, {link: !tpl.builtin});
  }

  /** Put a template on the scene and open it in the editor with its path visible and its first shape selected. */
  async #openInEditor(tpl, {link}) {
    return openTemplateInEditor(tpl, this.#targets(), {link});
  }

  static async #onDelete(_event, target) {
    const tpl = this.#find(target.closest("[data-template-id]").dataset.templateId);
    if ( !tpl ) return;
    const ok = await DialogV2.confirm({
      window: {title: "Delete template"},
      content: `<p>Delete the template <strong>${foundry.utils.escapeHTML(tpl.name)}</strong>?</p>`
    });
    if ( !ok ) return;
    await Store.deleteFromLibrary(tpl.id);
    this.render();
  }
}
