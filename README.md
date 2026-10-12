# Kostis's Actual Animator

[![Latest release](https://img.shields.io/github/v/release/kostis-vtt/kostis-actual-animator?label=release)](https://github.com/kostis-vtt/kostis-actual-animator/releases/latest) ![Foundry v14](https://img.shields.io/badge/Foundry-v14-orange) [![Downloads](https://img.shields.io/github/downloads/kostis-vtt/kostis-actual-animator/total)](https://github.com/kostis-vtt/kostis-actual-animator/releases) [![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/xgpro)

Draw motion paths on the map and send tokens along them, exactly on the line, at the speed you set.

Built for Foundry VTT v14.

## Installation

In Foundry, go to *Add-on Modules → Install Module*, paste this manifest URL and press *Install*:

`https://github.com/kostis-vtt/kostis-actual-animator/releases/latest/download/module.json`

It works on its own; with *Kostis's Flying Paths* installed it also joins the family's launcher and controls.

## Quick start

The panel can be resized down to a small window (drag its bottom-right corner; the tabs become icons) and opens
where and as big as you left it. While you pick a point or a token on the map (*Pick on map*), it tucks itself away
to its title bar and comes back as soon as you have picked (Escape cancels).

1. Enable the module (Game Settings → Manage Modules).
2. Click the **route** icon (Kostis's Actual Animator) in the left scene controls, or press its button in the Token HUD.
3. Press **New animation**. The pen tool activates.
4. Draw: click to place nodes, drag while clicking to pull curves, click the first node to close a loop, or press **Enter** / double-click to finish.
5. Select tokens on the map and press **Play** in the bottom bar.

## Drawing tools

| Tool | How |
|---|---|
| Select & edit | Drag nodes, handles, shapes. Alt-drag a path to move the whole animation. |
| Curve / line pen | Click = node, click-drag = node with curve handles, click the first node = closed loop, Enter / double-click = finish, right-click = remove last node, Shift = 15° angles. |
| Freehand | Drag to draw; simplified into a smooth editable curve. Ending near the start closes the loop. |
| Circle / ellipse | Drag from the centre (Shift: circle). |
| Square / rectangle | Drag corner to corner (Shift: square, Alt: from centre). |
| Polygon / star | Drag from the centre; sides and star depth in *Drawing options*. |
| Spiral | Drag from the centre; turns and inner radius in *Drawing options*. |
| Wave / zig-zag | Drag from start to end. |
| Figure eight | Drag from the centre. |
| Waypoint | Click to add a stop (with an optional wait). |
| Homing leg | Adds a leg that flies to a targeted token, re-aiming every frame if it moves. |
| Return home | Adds a leg that flies back to where the token started. |

The toolbar also has **Grid snap** (hold Ctrl to invert while drawing) and **Show all paths** toggles. Points never snap unless you ask: motion is completely grid-free.

### Editing curves

- **Node curvature**: select a node and use the *Curvature* slider (0% = sharp corner, 100% = fully smooth), or choose *Sharp*, *Smooth* or *Free handles*. Double-click a node to toggle sharp/smooth.
- **Bézier handles**: drag the round knobs next to a selected node. Handles stay mirrored; hold **Alt** to break them.
- **Segment bend**: drag the ◆ in the middle of any segment to bow it into an arc (or use the *Bend* slider).
- Double-click the line to insert a node. Right-click a node to delete it. **Delete** removes the selected node or step. **Ctrl+Z** undoes.
- Drag one end of an open path onto the other end to join them into a loop (or tick *Closed loop*).
- Closed shapes have a green start marker: drag it to choose where on the loop tokens begin.
- *Make editable curve* converts any shape (circle, square, star, spiral…) into free nodes.

## Steps

Every shape is a **step**. Tokens run the steps in order, linked automatically. Per step you can set:

- **Laps** (closed shapes, fractions allowed) or **passes** (open paths; each extra pass goes back the other way)
- **Reverse direction**, **start point**
- **Speed ×**, a multiplier on the animation speed
- **Wait after**, a pause in seconds
- **Arrive by**: travel or teleport from the previous step
- Its own **facing** override

## Homing legs and following a token

A **homing leg** has no fixed geometry. It is aimed when you press Play and re-aimed on every frame:

- **Flies to**: a token you have targeted (T; *Target number* picks the 1st, 2nd, 3rd… target), back to its start, to the anchor token, or to one specific token (*Pick the token on the map*).
- **Curve %** bows the flight to one side (negative values bow to the other side), and **Stop short** halts that many squares before the destination (a melee lunge).
- Chain legs to ricochet from target to target. Symmetry copies spread across your targets and fan out to alternating sides, so the copies in a volley don't overlap.

**Start → Follow a token** makes the whole drawing travel with a token: orbits stay centred on it when it moves. Choose *the first token I target* or a specific token (*Pick on map*). When an animation both follows the first target and has homing legs, the legs strike your *other* targets, so you can target the ally to circle first and then the enemies.

## Motion

- **Speed** in squares/s, scene units/s or pixels/s. Movement along curves is arc-length exact.
- **Easing**: smooth acceleration from every stop and deceleration into every stop (start, waits, teleports, end).
- **Looping**: once, loop or back-and-forth; any number of cycles (0 = forever); optional pause between cycles. If the end isn't joined to the start, choose travel or teleport back.
- **Start**: *on the drawn path* (travel or teleport to its start), or *relative to each token*, where the path's shape is carried along so it starts wherever each token stands.
- **Finish**: stay at the end, travel back, or teleport back.
- **Several tokens**: together, one after another (delay), or *spread evenly* (exact equal spacing around a loop).
- **Rate** slider (bottom bar): live speed multiplier for running tokens, applied without any jump.

## Height & bounce

Any step can add vertical motion: **Arc** (one thrown arc), **Hops** (equal jumps), **Drop & bounce** (falls, then bounces lower and lower until it settles), **Skip** (stone skipping: each hop shorter and lower), or **Hover** (gentle bobbing). On a waypoint, the effect plays out during its wait, so an item can drop and bounce in place.

Height is shown by growing the token, lifting it up the screen and drawing a shadow on the ground. The elevation readout shows the live height. All of this is adjustable under *Motion → Height effects*.

## Symmetry (kaleidoscope)

The **Symmetry** tab copies the whole animation up to ×50 around the token, the path's centre or a chosen point:
- **Radial** spaces copies evenly: ×2 is the opposite side, ×3 is every 120°.
- **Kaleidoscope** mirrors every other copy.

The map shows the pattern live as you drag the slider.

Copies are **real tokens**, created when the animation plays, so each can be targeted, damaged and tracked on its own. Independent copies have their own hit points. They follow the same motion, facing and height effects. Pause and stop act on the whole group. Changing the copy count while playing adds or removes copies instantly. Copies are removed when the animation stops, unless *Keep copies after stopping* is ticked. Creating copies needs permission to create tokens (normally the GM).

## Facing

- **Static**: keeps the facing it started with.
- **Follow path**: faces the travel direction, with adjustable turn smoothing.
- **Turn with path**: keeps the starting facing but turns exactly as much as the path turns. Circling slowly spins the token the same way.
- **Spin**: rotates at a fixed speed in °/s.
- **Fixed angle**.
- **Face centre**: faces the current shape's centre.
- **Face point**.
- **Face token**: tracked live.
- **Smart target**: always looks at the nearest, farthest, most wounded or least wounded token among enemies, allies, player characters, anyone, or your own picked group, with an optional range.

Set which way your token art faces, an angle offset, a max turn speed (heads swing smoothly to new targets), a reverse flag and an optional sway. Any step can override the animation's facing.

Tokens with *Lock Rotation* enabled in their token settings won't visibly turn. The panel warns you.

## Playing

- **Play** uses the assigned tokens, or the selected tokens if none are assigned. **Selected** plays on the selection only.
- **Stop** has three modes: stop here, stop and return to the start, or stop and jump to the end. **Restart** starts over.
- **Preview** runs the module's mascot, a small winged comet, along the animation on the map without moving any token. It looks the same whichever token is selected, runs at the panel's **Rate**, flies homing legs at your current targets and shows one mascot per symmetry copy.
- **Token HUD**: the route button opens a palette with play, pause and stop for that token's animations. Right-click it to open the panel focused on that token.
- **Who can play it** (Tokens tab): as the world setting *Players can play animations* says (the default), anyone who owns the token, only chosen players, or only the GM. Players always play on tokens they own, from the token's HUD, at whatever they have targeted. The GM can play everything.
- Dragging a playing token by hand stops its animation. You can turn this off in the module settings.

## Templates

The **template gallery** (the shapes icon in the panel, or *Templates* in the Token HUD) holds ready-made animations: movement, loops and orbits, bounces and height, kaleidoscope patterns, behaviours such as a sentry that watches the nearest enemy, and **attacks**. Each card shows a live thumbnail of the real path.

**Attacks**: orbiting orbs, blade storm, spinning shields, orbit & strike, homing hammer, hammer barrage, boomerang, magic missiles, arrow volley, ricochet chain, lobbed fireball, meteor strike, dash strike, pounce and shockwave ring. Select the token(s) that do the moving (the orb, the hammer, the creature), target (T) the token(s) they fly at, then press **Apply**. Orbits circle the first token you target and follow it around.
- **Apply** adds the template, assigns the selected tokens and plays it in one click.
- **Add** places it on the scene to edit first.

Save any animation as **your own template** (book icon in the panel header). Templates are stored in grid squares, so they fit any scene, and they appear under *My templates*.

- **Edit** (your templates) places the template on the scene and opens it in the editor with its path visible. A bar at the top lets you **Save to template** once you're happy.
- **Customize** (built-ins) gives you an editable copy you can save as your own.
- Relative animations show faint outlines where each assigned token will actually run them, and **Move path to token** brings the drawn path to the token.

## Transform

The *Transform* row in the Path tab rotates (±15°, 90°) or scales (±10%) the selected step, or the whole animation when no step is selected.

## Import and export

Export and import animations as JSON.

## Macro API

```js
// Play by name or id on the selected tokens at double speed
KAA.play("Patrol", canvas.tokens.controlled, {rate: 2});

// Pause / resume / stop ("here" | "origin" | "end")
KAA.togglePause(canvas.tokens.controlled);
KAA.stop(canvas.tokens.controlled, {mode: "origin"});
KAA.stopAll();

// Change speed live, query status
KAA.setRate(token, 0.5);
KAA.status(token);   // {playing, paused, progress, cycles, ...}

// Manage animations
KAA.animations();                     // all animations on the viewed scene
const lap = await KAA.createAnimation({name: "Lap", steps: [{shape: {type: "ellipse", cx: 1000, cy: 800, rx: 300}}],
  motion: {loop: "loop", speed: 2}});
await KAA.updateAnimation(lap.id, {motion: {speed: 3}});
KAA.assign("Patrol", canvas.tokens.controlled);
KAA.openPanel();

// Templates
KAA.applyTemplate("Drop & bounce", canvas.tokens.controlled);
KAA.applyTemplate("Homing hammer", [hammerToken]);   // flies at the tokens you have targeted
KAA.applyTemplate("Homing hammer", [hammerToken], {targets: [goblin.id]});   // or at explicit targets
KAA.templates();                      // built-in + your own
KAA.openTemplates();
KAA.editTemplate("Orbit & strike", {tokens: canvas.tokens.controlled});   // put it on the map to edit by hand

// Paths for other effects to follow
KAA.track("Lap");                     // the drawn path as polylines, in travel order: [{points, closed, length, stepId}]
KAA.draw(lap.id, "freehand");         // start drawing on an animation with a tool (pen, freehand, rect, ellipse…, edit)
KAA.setSmooth(lap.id, 0);             // every point a sharp corner (1: all round); shapes become editable paths
```

`KAA.play(anim, tokens, {targets})` also accepts explicit targets (a GM acting for a player, a macro).

The same object is available as `game.modules.get("kostis-actual-animator").api`.

## Kostis's Flying Paths

The animator is part of the **Kostis's Flying Paths** family. With the *Kostis's Flying Paths* hub enabled it appears in the family launcher, and the other members build on it: *Kostis's Particle Effects* flies its orbs and missiles along animator templates and paints its effect walls along animator paths, and *Kostis's Auto-Patrol System* turns its generated patrol routes into animator animations. The animator works fine on its own as well. Hooks `kostis-actual-animator.started` and `kostis-actual-animator.stopped` fire on play and stop.

## How the precision works

The token's database position is not updated while it moves. Each playback is stored once on the token as a start time (in server time) and a speed. Every client then computes the identical, exact position from that each frame and draws the token there directly, at sub-pixel accuracy, the same way Foundry's own token animation renders. Paths are traced to within 0.05 px, and constant speed is guaranteed by arc length.

What this means in practice:

- Movement is perfectly smooth and in sync for everyone, with no network traffic while tokens move. Players who join or reload mid-animation see it in the right place.
- Grid, snapping, walls and movement costs never affect the path. Vision and lights follow the token.
- When a run ends or you stop it, the final position is saved once. The database stores whole pixels, so that is within 0.5 px of the exact end point.
- Region behaviours that trigger on movement (for example "on enter") only see the start and end positions, not the path in between.
- Height is visual: the stored elevation and scale never change, so nothing is left lifted after a stop.
- The module's own bookkeeping (starting, pausing, stopping, spawning and removing copies) is kept out of Ctrl+Z, so undo only reverts your own token moves. In the animator tools, Ctrl+Z undoes path edits.
- Copies deleted on purpose (for example, destroyed in combat) never come back. Any copy that ends up without a running original is cleaned up by the GM automatically.

## Support

Found a bug? [Report it](https://github.com/kostis-vtt/kostis-actual-animator/issues/new/choose). For questions, ideas, or to show what you made with it, head to [Discussions](https://github.com/kostis-vtt/kostis-actual-animator/discussions).

These modules are free. If you enjoy them, you can support their development on [Ko-fi](https://ko-fi.com/xgpro).

## Licence

MIT: see [LICENSE](LICENSE).

## Development

The tests run with plain Node, with Foundry mocked: run each file in `tests/` with `node` (for example
`node tests/integration.test.mjs`). Some load Handlebars and PIXI from a local Foundry install: set `FOUNDRY_APP` to its `resources/app`
folder if Foundry isn't installed in `C:/Program Files/Foundry Virtual Tabletop`. The family's other modules are
expected in folders next to this one.

To release a version: set it in `module.json`, add a `## <version>` section to `CHANGELOG.md`, commit, and push a tag
`v<version>`. GitHub Actions builds `module.zip` and publishes the release. The manifest URL of the latest version is
`https://github.com/kostis-vtt/kostis-actual-animator/releases/latest/download/module.json`.
