# Board theme survey (THM-001)

## Sources checked

- Installed `chessground` package: **9.2.1** (`node_modules/chessground/package.json`, dependency `^9.2.1` in `apps/web/package.json`). The package exposes no built-in theme API or theme CSS custom properties.
- `node_modules/chessground/assets/chessground.base.css`: board is `cg-board`; board CSS background covers it. Individual `<square>` elements are created for transient square classes (move destinations, selection, last move, check), not for all 64 base squares.
- `node_modules/chessground/assets/chessground.brown.css`: bundled theme uses `cg-board` background-color plus an embedded SVG background image. It separately styles destinations, last move, selected/check/premove overlays, and coordinate colors. Thus replacing only `cg-board` background image/color keeps those other concerns separate.
- Lichess board preference reference from the task: profile menu → “Board theme”; piece sets are a separate preference. The current Lila source list at https://github.com/lichess-org/lila/blob/master/ui/lib/css/theme/board/_boards.scss confirms 2D families including `blue`, `blue2`, `blue-marble`, `wood`/`wood2`–`wood4`, `green`, `brown`, and `marble`, among others. It also lists separate 3D themes. This is a category-level inspiration/model only; no Lichess CSS or imagery was adapted. Lichess source overview: https://lichess.org/source.
- Alternative online theme galleries/custom user styles were considered only as visual inspiration; no external stylesheet or asset was incorporated.

## Selected palettes

Five clean-room, flat CSS square-color pairs (light / dark):

| Picker name | Colors | Inspiration |
| --- | --- | --- |
| Green | `#eeeed2` / `#769656` | familiar classic green |
| Blue | `#dee3e6` / `#8ca2ad` | muted blue |
| Wood | `#f0d9b5` / `#b58863` | warm brown/wood |
| Slate | `#d7dce2` / `#687789` | cool slate, stronger contrast |
| Classic | `#f0d9b5` / `#b7c0a0` | restrained traditional neutral-green |

The values are authored for ChessReps; no Lichess CSS, SVG, raster image, or piece artwork is copied. Overrides apply only to the Chessground board background. Pieces, highlights, coordinates, sizing, and mobile layout are unchanged.

## Licensing

No third-party theme assets were considered for bundling. Lichess's source theme table declares raster/vector file types for many textured themes; none of those assets were retrieved or used. Square-color pairs are original CSS declarations; there are no image/art provenance or license obligations introduced by this task. Chessground itself remains the existing GPL-3.0-or-later dependency; its license is recorded in `apps/web/THIRD-PARTY-NOTICE.md`.

## Application

The display-only preference uses `localStorage['chessreps.boardTheme']`, validates against the five known IDs, and falls back to Green for unknown/missing values. Boot applies the validated body class immediately before router startup, before the first Train render. The Settings picker updates that same class and key without remounting the board.
