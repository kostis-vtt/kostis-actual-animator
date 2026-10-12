// Token HUD integration: a quick palette to play, pause and stop a token's animations.

import {FLAG_PLAYBACK, MODULE_ID, MODULE_TITLE} from "./const.js";
import {Store, canPlay} from "./model.js";
import {Playback} from "./playback.js";

/** Remember whether the palette was open so it survives HUD re-renders. */
let paletteOpenFor = null;

export function onRenderTokenHUD(hud, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const token = hud.object;
  if ( !root || !token ) return;
  const doc = token.document;
  // Players see the palette for tokens they own that have something they may play (or something running to stop)
  if ( !game.user.isGM ) {
    if ( !doc.isOwner ) return;
    const running = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
    if ( !running && !Store.all(doc.parent).some(a => a.tokens.includes(doc.id) && canPlay(a, doc)) ) return;
  }
  const col = root.querySelector(".col.right") ?? root.querySelector(".col.left");
  if ( !col || col.querySelector(".kaa-hud-btn") ) return;

  const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
  const wrap = document.createElement("div");
  wrap.style.position = "relative";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `control-icon kaa-hud-btn${pb ? " active" : ""}`;
  btn.dataset.tooltip = MODULE_TITLE;
  btn.setAttribute("aria-label", MODULE_TITLE);
  btn.innerHTML = '<i class="fa-solid fa-route" inert></i>';

  const palette = document.createElement("div");
  palette.className = "kaa-hud-palette";
  if ( paletteOpenFor === doc.id ) palette.classList.add("active");
  palette.innerHTML = paletteHTML(doc);

  btn.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const open = !palette.classList.contains("active");
    palette.classList.toggle("active", open);
    paletteOpenFor = open ? doc.id : null;
  });
  btn.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    if ( game.user.isGM ) game.modules.get(MODULE_ID).api.openPanel({tokenId: doc.id});
  });

  palette.addEventListener("click", async event => {
    const el = event.target.closest("[data-kaa]");
    if ( !el ) return;
    event.preventDefault();
    event.stopPropagation();
    const animId = el.closest("[data-anim-id]")?.dataset.animId;
    switch ( el.dataset.kaa ) {
      case "play":
        await Playback.play(animId, [doc], {stagger: "none"});
        break;
      case "pause":
        await Playback.togglePause([doc]);
        break;
      case "stop":
        await Playback.stop([doc], {mode: el.dataset.mode ?? "here"});
        break;
      case "open":
        game.modules.get(MODULE_ID).api.openPanel({tokenId: doc.id});
        break;
      case "templates":
        game.modules.get(MODULE_ID).api.openTemplates({tokenIds: [doc.id]});
        break;
    }
  });

  wrap.append(btn, palette);
  col.appendChild(wrap);
}

function esc(s) {
  return foundry.utils.escapeHTML(String(s ?? ""));
}

function paletteHTML(doc) {
  const pb = doc.getFlag(MODULE_ID, FLAG_PLAYBACK);
  const anims = Store.all(doc.parent);
  // Players only see the animations they may play (plus whatever is running, to pause or stop it)
  const assigned = anims.filter(a => a.tokens.includes(doc.id) && canPlay(a, doc));
  const current = pb ? anims.find(a => a.id === pb.anim) : null;
  const list = current && !assigned.includes(current) ? [current, ...assigned] : assigned;
  const rows = list.map(a => {
    const live = pb?.anim === a.id;
    const state = live ? (pb.paused ? "paused" : "moving") : "";
    return `<div class="kaa-hud-row" data-anim-id="${a.id}">
      <span class="kaa-hud-swatch" style="background:${a.color}"></span>
      <span class="kaa-hud-name" title="${esc(a.name)}">${esc(a.name)}${state ? ` <span class="kaa-hud-live">· ${state}</span>` : ""}</span>
      ${canPlay(a, doc) ? '<button type="button" data-kaa="play" title="Play"><i class="fa-solid fa-play" inert></i></button>' : ""}
      ${live ? `<button type="button" data-kaa="pause" title="Pause / resume"><i class="fa-solid ${pb.paused ? "fa-play" : "fa-pause"}" inert></i></button>
      <button type="button" data-kaa="stop" title="Stop here"><i class="fa-solid fa-stop" inert></i></button>
      <button type="button" data-kaa="stop" data-mode="origin" title="Stop and return to start"><i class="fa-solid fa-rotate-left" inert></i></button>` : ""}
    </div>`;
  }).join("");
  return `<div class="kaa-hud-title"><i class="fa-solid fa-route" inert></i> Animations</div>
    ${rows || '<div class="kaa-hud-empty">No animation assigned to this token.</div>'}
    ${game.user.isGM ? `<div class="kaa-hud-actions">
      <button type="button" class="kaa-hud-open" data-kaa="templates"><i class="fa-solid fa-shapes" inert></i> Templates</button>
      <button type="button" class="kaa-hud-open" data-kaa="open"><i class="fa-solid fa-sliders" inert></i> Animator</button>
    </div>` : ""}`;
}
