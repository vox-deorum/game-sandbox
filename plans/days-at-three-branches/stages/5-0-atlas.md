# Step 5.0: Atlas pipeline

Status: complete. Consuming art stages expand the declared pages through this shared pipeline.

Part of [the plan](../README.md). This stage provides shared, config-driven source-art compilation for the base renderer and organizes the committed Three Branches art around it. It precedes the other parts of build-order step 5, and [step 5.1](5-1-art-style.md) iterates its art through this pipeline.

## Configured source art is the editable truth

`renderer/assets/presentation.json` is the authority for atlas pages, ordered cells, source paths, and raster transforms. Each named cell explicitly identifies one source image and may define operations such as cropping, resizing, alpha normalization, visible-bounds fitting, anchoring, or output cleanup. A page may leave a row-major trailing suffix unnamed; the compiler fills those cells transparently.

Source art is canonical. Compiled atlas pages are committed runtime outputs. Runtime loading uses only pages with shipped consumers. Current page membership, dimensions, transforms, and source paths belong in the catalog and its validation, not in this plan.

## The compiler

The generic base-renderer compiler is split into three focused modules:

- `frontend/src/renderers/base/atlas/atlas.ts` owns the build-page contract, validation, source transforms, and RGBA composition and comparison.
- `frontend/src/renderers/base/atlas/atlas-io.ts` reads and writes PNGs and exposes the freshness helper used by environment tests.
- `frontend/src/renderers/base/atlas/cli.ts` dispatches the command-line operations.

The CLI imports the environment catalog through `renderer/assets.ts`. Runtime asset loading reads the same catalog without importing compiler modules, so the compiler remains outside the runtime bundle.

The commands are:

- `build` compiles selected configured pages from their source cells, fills unnamed trailing cells transparently, and preserves an existing page when its decoded pixels already match.
- `check` compiles selected pages in memory and compares decoded pixels with the committed outputs, reporting the first differing named or unused cell.

Freshness is pixel-defined rather than byte-defined. Equivalent PNG encoding choices must not cause a failure.

## Runtime loading and migration

The catalog remains the single source for runtime asset metadata. `source-art/` contains the canonical inputs it references, while generated pages are retained only when they have shipped consumers. The runtime renderer owns presentation and registration contracts; the compiler only produces validated image outputs. Later approved visual units may add pages through the same catalog and compiler.

Migration declares the source cells and transforms needed by the consuming art units, then commits canonical source art, catalog changes, compiled pages, and focused tests together. The compiler must reject missing or unsafe sources, invalid dimensions or crops, invalid transforms, duplicate cells, and unsupported output data.

## Tests

Pure compiler tests cover representative exact-copy and transformed cells, alpha handling, visible-bounds fitting, validation failures, deterministic output, and grid arithmetic. Environment freshness tests compile every declared page from its configured source cells and compare the resulting pixels with the committed page. Catalog tests verify that declared consumers, source paths, and page metadata are complete.

All tests use the existing Vitest inclusion and CI paths.

## Done when

Every declared source cell compiles into its committed page, freshness and catalog tests pass, runtime loading includes only shipped consumers, canonical source art remains available for every configured cell, and the plan and consuming stages reference this pipeline without duplicating catalog facts.
