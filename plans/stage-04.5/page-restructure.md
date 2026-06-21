# Stage 4.5: Page Restructure

Status: implemented. The folder and naming conventions are in place (PascalCase `*Page.vue` route components, `components/ui/` primitives, `components/` feature components, `composables/`, `lib/`). The composables are extracted, the app shell and navigation are rebuilt to the approved IA, and all four pages plus the start form and recent-replays list run on the design foundation, with the decision log on the session and replay stages.

Part of [Stage 4.5](../stage-04.5-ui-restructure.md). This document covers the code-structure half of the stage: folder and naming conventions, the composables extracted from the large pages, the app shell and navigation rebuild per the approved [information architecture](information-architecture.md), and the page by page migration onto the [design foundation](design-foundation.md).

## Folder and naming conventions

The target layout under `frontend/src/`:

```
styles/          tokens.css, base.css, app.css (design foundation; legacy file until the end of the stage)
components/ui/   the primitives, Ui prefix (UiButton.vue, UiCard.vue, ...)
components/      feature components: AppShell.vue, AppNav.vue (new), StartForm.vue,
                 RunMetadata.vue, DecisionLog.vue (new), RecentReplays.vue (moved from
                 pages/, it is not a route; since removed: Stage 6 replaced the
                 overview's recent-replays list with the routed ReplaysPage tab)
composables/     useSessionSocket.ts, useRendererMount.ts, usePinning.ts,
                 useEnvironmentMeta.ts, useReplayTransport.ts
lib/             format.ts (formatDate and friends, deduplicated from the pages)
pages/           HomePage.vue, EnvironmentPage.vue, SessionPage.vue, ReplayPage.vue,
                 StyleguidePage.vue (dev only); ReplaysPage.vue added later for the
                 environment's Replays tab
api/, renderers/, replay/, identity.ts, me.ts    unchanged locations
```

The rules this encodes:

- Route components live in `pages/`, named PascalCase with a `Page` suffix. This ends the Stage 4 mix of lowercase pages and PascalCase components.
- Anything that is not a route lives in `components/` (feature components) or `components/ui/` (primitives).
- Page-level logic that more than one page needs is a composable in `composables/`, named `useX`.
- Pure functions with no reactivity go in `lib/`.
- `me.ts` and `identity.ts` stay where they are. Moving `me.ts` to `composables/` is possible later but is churn without payoff now.

Renames that only change case go through `git mv` in dedicated commits, because the working tree sits on a case-insensitive filesystem on Windows. (`home.vue` to `HomePage.vue` changes more than case, but the rule matters for any future case-only rename.)

## Composables

Extracted from the pages, each wrapping the existing plain classes rather than replacing them. The Stage 4 decision that the socket and transport are small explicit classes still stands.

- `useSessionSocket(sessionId, handlers)`: absorbs from the session page the socket construction and teardown, the connection, status, paused, end-reason, and final-result state, and the pause and stop actions. It also replaces the page's polling loop on `me.loading` with an awaitable `whenSettled()` exposed from `me.ts`, which removes a latent race instead of relocating it.
- `useRendererMount(host, meta, controlledSlots, sendAction?)`: absorbs the renderer mount, destroy, and missing-renderer handling duplicated between the session and replay pages.
- `useReplayTransport(states, paceIntervalMs)`: wraps the replay transport class, exposing the transport state and controls plus the keyboard handler the accessibility baseline adds (space toggles play, arrows step, Home and End jump).
- `usePinning(recordingId, owned)`: the pin toggle with its busy and error state, currently duplicated verbatim between the session end card and the replay page.
- `useEnvironmentMeta(envId)`: the fetch-environments-and-find pattern that appears on four pages.

After extraction the session and replay pages should read as composition plus template. If the session page is still heavy, presentational children split out into `components/` (a status strip, the end-of-session card, the replay transport bar), but only if the size warrants it. Extraction is not a goal in itself.

## App shell and navigation

`AppShell.vue` is rebuilt to the approved navigation model: the three-zone top bar with the site name, the primary sections with the coming-soon placeholders for Agents and Leaderboards, and the signed-in readout. The placeholder entries are real elements styled as inert: greyed and not focusable. They need no `aria-hidden`, since they are plain text with a `soon` tag, not links. A new `AppNav.vue` holds the section list so the shell stays small. The identity seam is untouched: the readout still comes from the `me.ts` provider.

Pages gain the context line from the IA (the `Environments / Flappy Bird / ...` link path) as part of their migration; it is plain markup in each page, not a breadcrumb framework.

## Migration order

Home migrates first, with the shell, as the checkpoint-two reference page. After approval the rest follow, one PR-sized step each, with tests updated in the same change:

1. Environment hub: the section-column layout, the start form moved into `UiDialog`, `RecentReplays` moved to `components/` and restyled, and the trailing coming-soon sentence.
2. Session page: the composables extracted (`useSessionSocket`, `useRendererMount`, `usePinning`), the status strip on `UiStatusBadge` and `UiButton`, the end card on `UiCard`, and the decision log (`DecisionLog.vue` in `components/`) fed the per-tick agent actions from the state stream (`StepState.agents[slot].action`, with `timing.decision_ms` available for the timing column later). The renderer mount gains a targeted-canvas-size field on `RendererModule` (`renderers/types.ts`), populated by the Flappy Bird module. So `useRendererMount` lays the canvas at or under that target, and the page places the log beside the canvas when a column is free and below it, collapsed, when the canvas claims the width.
3. Replay page: `useReplayTransport` with keyboard support, the scrubber on `UiSlider`, tight transport buttons with compact arrow step controls, trailing pinning, and metadata and `DecisionLog` sharing the session page's pieces. The log replays from the recorded states the transport already walks, so it stays in sync with the scrubber.

Each page that migrates takes its legacy classes out of the transitional stylesheet. The stage-end cleanup deletes the file once it is empty.
