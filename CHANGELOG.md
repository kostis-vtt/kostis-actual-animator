# Changelog

The module got its own repository at version 1.4.0; the entries before it are summaries.

## 1.5.0

- `KAA.editTemplate` opens a template on the map for editing (Kostis's Particle Effects uses it to shape an effect's
  motion by hand), and `KAA.setSmooth` turns every point of a path into sharp corners or round curves.
- A plain rectangle keeps its exact corners when it becomes a path.
- The panel: choosing a facing or start-and-finish tile no longer makes it jump to the first tile; it no longer
  redraws under an open dropdown; it steps aside while you pick a point or token on the map (back as soon as you have,
  or with Escape); it can be made much smaller (icon tabs, a narrower list) and opens where and as big as you left it.

## 1.4.0

- Who can play an animation (Tokens tab): the world setting, anyone who owns the token, chosen players, or only the GM.
  Players play from the HUD of tokens they own.

## 1.3.0

- Other modules can read an animation's drawn path (`KAA.track`) and start a drawing tool on it (`KAA.draw`): effect
  walls in Kostis's Particle Effects are drawn along animation paths.
- Facing smoothing is measured in pixels; undo keeps the 50 most recently changed animations.

## 1.2.0

- Homing legs that strike targets, following a token, the Attacks templates and the preview ghost.

## 1.1.0

- Symmetry copies are real tokens, height (lift), and moving a token by hand while it animates.
