# Step 5.0: Atlas pipeline

Status: complete. Consuming art stages expand declared pages under this shared pipeline.

Part of [the plan](../README.md). This stage is independent infrastructure: it adds a shared split and merge pipeline for atlas art to the base renderer and reorganizes the committed Three Branches art around it. It precedes the other parts of build-order step 5, and [step 5.1](5-1-art-style.md) iterates its art through this pipeline.

## Loose frames are the editable truth

Every named atlas frame lives as one loose PNG beside the compiled page. A page may leave a row-major trailing suffix unnamed, and the packer fills those cells transparently. The bundle loads only pages with shipped consumers. The pipeline converts between the two forms, and both are committed. Consuming stages update this inventory when their assets land.

| Page | Frames directory | Frames |
| --- | --- | --- |
| `terrain-atlas.png` | `assets/terrain/` | 64 |
| `buildings-atlas.png` | `assets/buildings/` | 16 |
| `props-atlas.png` | `assets/props/<type>/<state>.png` plus `assets/props/bell/foundation.png` | 20 |
| `scenery-atlas.png` | `assets/scenery/` | 4 |
| `characters-<layer>-atlas.png` (4 pages) | `assets/characters/{body,clothing,arms,details}/` | 4 each |
| `effects-atlas.png` | `assets/effects/` | 28 |

The Frames column counts loose files, not frame pixels. Each page's current frame dimensions, count, and names live in `renderer/assets.ts` and change only with the consuming art unit, its loose files, compiled page, source-art metadata, plan facts, and tests in the same change set.

A frame's name is the camel case of its path under the frames directory: `terrain/washA.png` is `washA`, `props/repair_bench/busy.png` is `repairBenchBusy`, and `characters/body/rest.png` is `rest` in the body layer. Frame files must be exactly the page's declared frame size.

The props frame names in `assets.ts` derive from catalog tokens and states, followed by the fixed bell foundation. Slots 0 through 18 name complete prop states in catalog order, from `stallOpen` through `bellSilent`; slot 19 is `bellFoundation` from `props/bell/foundation.png`. The remaining 16 cells are an unnamed trailing suffix that the packer fills transparently. The runtime page is 2304 by 1536, with 384 by 256 runtime frames and no downsampling.

The effects page is a 7 by 4 grid of 28 runtime frames on a 1344 by 512 page. Its 384 by 256 source cells live on a 2688 by 1024 source page.

## The pipeline

The tooling is generic base-renderer infrastructure in TypeScript:

- `frontend/src/renderers/base/atlas/atlas.ts` holds the pure logic: the `AtlasPageSpec` contract, spec validation, frame-name derivation, and RGBA slice, compose, and compare.
- `frontend/src/renderers/base/atlas/atlas-io.ts` reads and writes PNGs with `pngjs` and `node:fs`, and exposes an `expectAtlasesFresh` helper for environment tests.
- `frontend/src/renderers/base/atlas/cli.ts` is a thin command dispatcher.

An environment opts in by exporting an `ATLAS_PAGES` spec from its `renderer/assets.ts`; the CLI loads that module for the named environment. Nothing at runtime imports the atlas modules, so the bundle never includes them. New frontend dev dependencies: `pngjs`, `@types/pngjs`, and `vite-node`, with one npm script so the commands run as `npm run atlas --workspace @game-sandbox/frontend -- <command> <env> [group]`.

The commands:

- `split` cuts each named frame into loose files, row major in declared name order, and fails if a frames directory contains a PNG outside the declared set.
- `pack` recomposes pages from loose frames and fills any unnamed trailing cells transparently. It fails with a list of missing, stray, and mis-sized files. For a `grayscale-alpha` page it also fails on any pixel whose red, green, and blue values differ, which enforces the tintable-mask contract mechanically. When the committed page already matches pixel for pixel, it leaves the file untouched so diffs never churn on encoder bytes.
- `check` packs in memory and compares decoded RGBA pixels against the committed page, reporting the first differing named frame or unused cell.

Freshness is pixel defined, never byte defined: checks decode both sides and compare pixels, so zlib encoder variance across platforms cannot fail CI.

## Incremental runtime loading

`assets.ts` keeps the six-group catalog, page paths, grids, dimensions, and runtime load function. The runtime glob names only pages with shipped consumers: terrain, props, scenery, the four character layers, and effects. Buildings and loose frames stay outside the bundle until their visual units land. `source-art/` keeps the high-resolution provenance for every authored page and grows with approved art. Skirmish at Crane Reach ships loose ungridded files and needs nothing from this stage.

The road pilot retains its four native 1254 by 1254 colour sources in `renderer/source-art/road-material-source.png`, ordered `roadA roadB / roadC roadD`. The terrain source page keeps grayscale 192 by 128 previews of those sources in slots 4 through 7; loose runtime frames remain the packer's editable input.

## Migration

Split `terrain`, `buildings`, `scenery`, `effects`, and the four `characters` layer pages into 116 loose frames. Pack `props` from its 19 loose state files, leaving the remaining trailing cells transparent. Commit loose frames and compiled pages together.

## Tests

- Pure packer tests in `frontend/test/atlas.test.ts` run on small synthetic images: name derivation for flat, nested, and underscored paths, a split-then-pack pixel round trip, and one failure case each for a missing frame, a stray PNG, a mis-sized frame, a non-gray pixel on a grayscale-alpha page, and bad grid arithmetic.
- `assets.test.ts` checks catalog completeness, the nontrivial nested props paths, and the exact runtime page set for terrain, the four character layers, and effects.
- A freshness test in `environments/three_branches/renderer/atlas.test.ts` packs every page from its committed loose frames and compares pixels against the committed page, and checks each page's PNG header against its declared dimensions.

All three ride the existing vitest include globs, so `scripts/ci.py` needs no change.

## Done when

All nine declared pages have complete committed loose frame sets, each compiled page matches its current manifest, `assets/props-atlas.png` matches its 20 loose prop frames with transparent unnamed trailing cells, `npm run atlas -- check three_branches` passes, the packer and freshness tests are green in CI, the runtime bundle loads only pages with shipped consumers, every authored page retains its source-art provenance, and the plan README and consuming stages reference this pipeline.
