// What the animator's windows share: they remember their size and place, and they never redraw under an open
// dropdown (the redraw would snap it shut).

const STORE = "kostis-windows";

function stored() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORE) ?? "{}") ?? {};
  } catch(err) {
    return {};
  }
}

/** Where a window was left last time in this browser ({left, top, width, height}), to open it there again. */
export function savedPosition(id) {
  const p = stored()[id];
  const out = {};
  for ( const k of ["left", "top", "width", "height"] ) if ( Number.isFinite(p?.[k]) ) out[k] = p[k];
  return out;
}

/** Remember where a window is now. */
export function savePosition(app) {
  const {left, top, width, height} = app?.position ?? {};
  if ( !app?.id || ![left, top, width, height].every(Number.isFinite) ) return;
  try {
    const all = stored();
    all[app.id] = {left, top, width, height};
    globalThis.localStorage?.setItem(STORE, JSON.stringify(all));
  } catch(err) {
    // (Storage can be unavailable, e.g. in a private window: the window just opens where it always did)
  }
}

const timers = new WeakMap();

/** Remember where a window is once it has stopped moving. */
export function rememberPosition(app) {
  clearTimeout(timers.get(app));
  timers.set(app, setTimeout(() => savePosition(app), 400));
}

/**
 * Keeps a window from redrawing while one of its dropdowns is open: the redraw waits until a choice is made or the
 * dropdown is left.
 */
export class ChoiceGuard {
  #open = false;

  #waiting = false;

  /** @param {() => void} redraw   How the window redraws when it may again */
  constructor(redraw) {
    this.redraw = redraw;
  }

  /** Watch a window's element (once, after its first render). */
  watch(element) {
    element.addEventListener("pointerdown", event => {
      if ( event.target?.closest?.("select") ) this.#open = true;
    }, true);
    element.addEventListener("change", event => {
      if ( event.target?.tagName === "SELECT" ) this.#open = false;
    }, true);
    element.addEventListener("focusout", event => {
      if ( event.target?.tagName !== "SELECT" ) return;
      this.#open = false;
      if ( !this.#waiting ) return;
      this.#waiting = false;
      this.redraw();
    }, true);
  }

  /** Should a redraw wait? (It happens once the dropdown is closed.) */
  hold() {
    if ( !this.#open ) return false;
    this.#waiting = true;
    return true;
  }
}
