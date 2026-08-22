# Step 5.0: Atlas pipeline

Status: complete. Consuming art stages expand declared pages under this shared pipeline.

Part of [the plan](../README.md). This stage is independent infrastructure: it adds a shared, config-driven source-art compiler to the base renderer and organizes the committed Three Branches art around it. It precedes the other parts of build-order step 5, and [step 5.1](5-1-art-style.md) iterates its art through this pipeline.

## Configured source art is the editable truth

`renderer/assets/presentation.json` is the single authority for atlas pages, ordered cells, source paths, and raster transforms. A named cell declares one source image and may declare a crop, resize, alpha normalization, visible-bounds fit, anchor, or output cleanup. The compiler is generic and reads these values from the config. A page may leave a row-major trailing suffix unnamed, and the compiler fills those cells transparently. Source art is canonical; compiled atlas pages are committed runtime outputs. The bundle loads only pages with shipped consumers.

| Page | Configured source roots | Named cells |
| --- | --- | --- |
| `terrain-atlas.png` | `assets/source-art/frames/terrain/` | 68 |
| `buildings-home-atlas.png` | `assets/source-art/frames/buildings/` | 1 (`home`) |
| `buildings-inn-atlas.png` | `assets/source-art/frames/buildings/` | 1 (`inn`) |
| `buildings-shed-atlas.png` | `assets/source-art/frames/buildings/` | 1 (`shed`) |
| `props-atlas.png` | `assets/source-art/stall/` and `assets/source-art/frames/props/` | 17 |
| `lantern-atlas.png` | `assets/source-art/frames/lantern/` | 2 |
| `monuments-atlas.png` | `assets/source-art/frames/monuments/` | 2 |
| `bell-atlas.png` | `assets/source-art/frames/bell/` | 3 |
| `scenery-atlas.png` | `assets/source-art/frames/scenery/` | 7 |
| `characters-<layer>-atlas.png` (4 pages) | `assets/source-art/frames/characters/{body,clothing,arms,details}/` | 4 each |
| `effects-atlas.png` | `assets/source-art/frames/effects/` | 40 |

The Named cells column counts configured cells, not frame pixels. Each page's current frame dimensions, count, names, source paths, and transforms live in `renderer/assets/presentation.json` and change only with the consuming art unit, its source art, compiled page, plan facts, and tests in the same change set.

The nine JSON atlas declarations resolve to fourteen compiled pages. The `buildings` declaration is one layered, full-color group with three mipmapped one-frame pages: `buildings-home-atlas.png` is 1024 by 896, `buildings-inn-atlas.png` is 1536 by 1280, and `buildings-shed-atlas.png` is 1024 by 1024. Each page is authored at 128 px per semantic cell for the home's 8 by 7, inn's 12 by 10, and shed's 8 by 8 extent. This replaces the previous single buildings page with three pages, a net increase of two.

A cell name is declared explicitly in `presentation.json`; it is not inferred from a directory or filename. Exact-copy cells must match the configured frame size. Transformed cells use the configured crop and raster operation.

The terrain page is an 8 by 9 grid of 128 px frames on a 1024 by 1152 runtime page. Its 68 named frames leave the final four cells transparent.

The props cell names in `presentation.json` remain ordered by ordinary catalog tokens and states. Slots 0 through 5 contain `stallAOpen`, `stallAClosed`, `stallBOpen`, `stallBClosed`, `stallCOpen`, and `stallCClosed`. Slots 6 through 16 contain the remaining complete prop states in catalog order, from `benchOccupied` through `repairBenchIdle`. Slots 17 through 35 are an unnamed trailing suffix that the compiler fills transparently. The six stall cells use their 1536 by 1024 masters with the configured area resize to 384 by 256. The fixed-north board keeps a 512 by 512 canonical source. A configured visible-bounds fit uses the full safe 252 px cell height, preserves the source proportions, and centers the resulting 251 by 252 silhouette at `(192, 128)` in its shared props cell. The two garden cells are exact-copy 384 by 256 sources with a common centered 376 by 188 visible rectangle. The runtime page remains 2304 by 1536.

The lantern page is a 2 by 1 grid of 384 by 512 frames on a 768 by 512 runtime page. It names `lanternLit` and `lanternUnlit` from the source paths declared in `presentation.json`.

The monument page is the sole authority for the fixed-north pump. Its row-major 3 by 2 grid names `pumpFlowing` and `pumpIdle` from the configured source paths. Each tightly authored runtime frame is 768 by 512 on a 2304 by 1024 page. The renderer divides the configured pump scale by 4 and anchors each sprite at its configured source pixel so its collision registration and world bounds remain unchanged. The four unnamed trailing cells are transparent.

The bell page is a 3 by 1 grid of 1536 by 1024 frames on a 4608 by 1024 page. It names `bellFoundation`, `bellGantry`, and `bellMoving` from exact canonical source cells. The renderer divides the configured bell scale by 16 and places each role's source-pixel anchor at the collision centre. The canonical cells preserve the prior registered world bounds and let the circular bell move independently of the fixed gantry.

The full-color scenery page is a 4 by 2 grid of 512 px frames on a 2048 by 1024 page. Its first seven row-major cells contain `pineA` through `pineF`, then `marketCrate`; the eighth cell is transparent. The crate uses its accepted runtime cell as exact canonical source art. The renderer divides every scenery sprite scale by 8, then applies a box's catalog footprint or a pine's recorded scale so art and collision keep the same extent.

The effects page is a 10 by 4 grid of 40 exact canonical source cells on a 1920 by 512 runtime page.

## The compiler

The tooling is generic base-renderer infrastructure in TypeScript:

- `frontend/src/renderers/base/atlas/atlas.ts` holds the pure logic: the `AtlasBuildPageSpec` contract, config validation, source transforms, and RGBA compose and compare.
- `frontend/src/renderers/base/atlas/atlas-io.ts` reads and writes PNGs with `pngjs` and `node:fs`, and exposes an `expectAtlasesFresh` helper for environment tests.
- `frontend/src/renderers/base/atlas/cli.ts` is a thin command dispatcher.

The CLI imports the environment's `renderer/assets.ts`, which validates `renderer/assets/presentation.json` and exports its configured build pages. Runtime asset loading reads the same catalog, but does not import compiler modules. Nothing at runtime imports the atlas compiler, so the bundle never includes it. New frontend dev dependencies: `pngjs`, `@types/pngjs`, and `vite-node`, with one npm script so the commands run as `npm run atlas --workspace @game-sandbox/frontend -- <command> <env> [group-or-page]`.

The commands:

- `build` compiles the selected configured pages from their source cells, fills unnamed trailing cells transparently, and leaves an existing atlas untouched when decoded RGBA pixels already match.
- `check` compiles in memory and compares decoded RGBA pixels against the committed page, reporting the first differing named cell or unused cell.

Freshness is pixel defined, never byte defined: checks decode both sides and compare pixels, so zlib encoder variance across platforms cannot fail CI.

## Incremental runtime loading

`assets/presentation.json` keeps the catalog, page paths, grids, dimensions, sampling flags, ordered cell names, source paths, and source transforms. `assets.ts` validates that catalog and loads its fourteen shipped pages: terrain, props, lantern, monuments, bell, the three buildings pages, scenery, the four character layers, and effects. Later approved visual units add pages when their consumers land. `source-art/` contains the canonical inputs referenced by the catalog. Unreferenced intermediate sheets and superseded masters are not retained. Skirmish at Crane Reach ships loose ungridded files and needs nothing from this stage.

The four configured road cells share an even base so deterministic frame selection cannot create tonal blocks. The four configured path cells retain the accepted worn-stone variations. Configured source cells remain the editable input; runtime atlases are generated outputs.

## Migration

Declare terrain, scenery, effects, and character cells, then declare props, lantern, monuments, bell, and the layered buildings group with its one full-color frame per building page. Declare each transformed cell's complete raster recipe. Keep cells 17 through 35 of props and the four unused monument cells transparent, and retain all three high-resolution bell cells. Commit canonical source art, config, and compiled runtime pages together. The compiler rejects missing sources, unsafe paths, invalid dimensions, invalid crops, bad transforms, duplicate cells, and non-grayscale output.

## Tests

- Pure compiler tests in `frontend/test/atlas.test.ts` run on small synthetic images: exact-copy and area-resize cells, alpha normalization and cleanup, visible-bounds fitting, shared bounds, deterministic rounding, crop validation, source containment, duplicate and missing cells, grayscale-alpha validation, and bad grid arithmetic.
- `assets.test.ts` checks catalog completeness, the nontrivial nested prop paths, the dedicated lantern and bell paths, the three mipmapped buildings pages, and the exact fourteen-page runtime set for terrain, props, lantern, monuments, bell, buildings, scenery, the four character layers, and effects.
- A freshness test in `environments/three_branches/renderer/atlas.test.ts` compiles every page from its configured source cells and compares pixels against the committed page, and checks each page's PNG header against its declared dimensions.

All three ride the existing vitest include globs, so `scripts/ci.py` needs no change.

## Done when

All fourteen compiled pages from nine declarations have complete configured source cells, each compiled page matches its current config, the terrain page matches its 68 cells with four transparent trailing cells, `assets/props-atlas.png` has transparent cells 17 through 35, its board cell is fitted from the 512 by 512 canonical source without aspect distortion, `assets/lantern-atlas.png` matches its two tall state cells, `assets/monuments-atlas.png` matches its two pump cells with four transparent trailing cells, `assets/bell-atlas.png` matches its three double-density bell roles, the three mipmapped buildings pages each match one full-color frame at their declared dimensions, and `assets/scenery-atlas.png` matches its seven full-color scenery cells with a transparent eighth cell. `npm run atlas --workspace @game-sandbox/frontend -- check three_branches` passes, compiler and freshness tests are green in CI, the runtime bundle loads only pages with shipped consumers, every configured cell retains its canonical source art, and the plan README and consuming stages reference this compiler.
