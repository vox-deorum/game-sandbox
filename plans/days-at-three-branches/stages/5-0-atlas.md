# Step 5.0: Atlas pipeline

Status: complete.

Part of [the plan](../README.md). This stage is independent infrastructure: it adds a shared split and merge pipeline for atlas art to the base renderer and reorganizes the committed Three Branches art around it, without changing any runtime behavior. It precedes the other parts of build-order step 5, and [step 5.1](5-1-art-style.md) iterates its art through this pipeline.

## Loose frames are the editable truth

Every atlas frame lives as one loose PNG beside the compiled page. The compiled atlas pages remain the runtime files the bundle loads. The pipeline converts between the two forms, and both are committed.

| Page | Frames directory | Frames |
| --- | --- | --- |
| `terrain-atlas.png` | `assets/terrain/` | 64 |
| `buildings-atlas.png` | `assets/buildings/` | 16 |
| `props-atlas.png` | `assets/props/<type>/<state>.png` | 36 |
| `scenery-atlas.png` | `assets/scenery/` | 4 |
| `characters-<layer>-atlas.png` (4 pages) | `assets/characters/{body,clothing,arms,details}/` | 4 each |
| `effects-atlas.png` | `assets/effects/` | 16 |

A frame's name is the camel case of its path under the frames directory: `terrain/washA.png` is `washA`, `props/repair_bench/busy.png` is `repairBenchBusy`, and `characters/body/rest.png` is `rest` in the body layer. Frame files must be exactly the page's declared frame size.

The props frame names in `assets.ts` change to derive from catalog tokens, so the loose files already on disk map without a hand-maintained table: `noticeBoardBase` becomes `boardBase`, `noticePosted` becomes `boardPosted`, `gardenPlotBase` becomes `plotBase`, `gardenTended` becomes `plotTended`, `gardenOvergrown` becomes `plotOvergrown`, and `gardenFence` becomes `plotFence`. Nothing outside `assets.ts` and `assets.test.ts` references these names.

## The pipeline

The tooling is generic base-renderer infrastructure in TypeScript:

- `frontend/src/renderers/base/atlas/atlas.ts` holds the pure logic: the `AtlasPageSpec` contract, spec validation, frame-name derivation, and RGBA slice, compose, and compare.
- `frontend/src/renderers/base/atlas/atlas-io.ts` reads and writes PNGs with `pngjs` and `node:fs`, and exposes an `expectAtlasesFresh` helper for environment tests.
- `frontend/src/renderers/base/atlas/cli.ts` is a thin command dispatcher.

An environment opts in by exporting an `ATLAS_PAGES` spec from its `renderer/assets.ts`; the CLI loads that module for the named environment. Nothing at runtime imports the atlas modules, so the bundle never includes them. New frontend dev dependencies: `pngjs`, `@types/pngjs`, and `vite-node`, with one npm script so the commands run as `npm run atlas --workspace @game-sandbox/frontend -- <command> <env> [group]`.

The commands:

- `split` cuts each committed page into loose frames, row major in declared name order, and fails if a frames directory contains a PNG outside the declared set.
- `pack` recomposes pages from loose frames. It fails with a list of missing, stray, and mis-sized files. For a `grayscale-alpha` page it also fails on any pixel whose red, green, and blue values differ, which enforces the tintable-mask contract mechanically. When the committed page already matches pixel for pixel, it leaves the file untouched so diffs never churn on encoder bytes.
- `check` packs in memory and compares decoded RGBA pixels against the committed page, reporting the first differing frame by name.

Freshness is pixel defined, never byte defined: checks decode both sides and compare pixels, so zlib encoder variance across platforms cannot fail CI.

## Runtime contract unchanged

`assets.ts` keeps the six-group catalog, page paths, grids, dimensions, and load functions. The only manifest changes are the six props renames and the added `ATLAS_PAGES` export. The runtime glob `import.meta.glob('./assets/*.png')` is not recursive, so loose frames never enter the bundle. `source-art/` keeps the high-resolution originals as untouched provenance. Skirmish at Crane Reach ships loose ungridded files and needs nothing from this stage.

## Migration

Split `terrain`, `buildings`, `scenery`, `effects`, and the four `characters` layer pages into 116 loose frames. Pack `props` from the 36 loose files already on disk, which restores the missing `assets/props-atlas.png` and makes the declared six-atlas contract true again. Commit loose frames and compiled pages together.

## Tests

- Pure packer tests in `frontend/test/atlas.test.ts` run on small synthetic images: name derivation for flat, nested, and underscored paths, a split-then-pack pixel round trip, and one failure case each for a missing frame, a stray PNG, a mis-sized frame, a non-gray pixel on a grayscale-alpha page, and bad grid arithmetic.
- `assets.test.ts` gains coverage that `ATLAS_PAGES` matches the six-group catalog one to one and that every declared file derives to its declared frame name.
- A freshness test in `environments/three_branches/renderer/atlas.test.ts` packs every page from its committed loose frames and compares pixels against the committed page, and checks each page's PNG header against its declared dimensions.

All three ride the existing vitest include globs, so `scripts/ci.py` needs no change.

## Done when

All nine pages have complete committed loose frame sets, `assets/props-atlas.png` is restored and matches the 36 loose props under the renamed frames, `npm run atlas -- check three_branches` passes, the packer and freshness tests are green in CI, the bundle's runtime loading is unaffected, `source-art/` is unchanged, and the plan README and step 5.1 reference this pipeline.
