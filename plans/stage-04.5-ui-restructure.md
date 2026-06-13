# Stage 4.5: UI Restructure

Status: implementation complete; awaiting owner sign-off on checkpoint two (the styleguide plus the redesigned Home). Checkpoint one (the IA) is approved. All four pages run on the tokens and `components/ui/` primitives with scoped styles, the global stylesheet is tokens + reset + app-shell only, the decision log ships on the session and replay stages, the accessibility and responsive baselines hold, the unit suites and type check pass, the production build carries no styleguide chunk and only the imported Reka components, and the design docs are written.

## Goal

The frontend that Stage 4 delivered works, but it was built page by page without a design system: one global stylesheet with ad hoc colors and spacing, no reusable component primitives, large pages with duplicated logic, and no stated design principles. Stages 5 through 9 multiply the UI surface (submissions, profiles, leaderboards, telemetry, multi-agent), so this stage restructures the UI first: a token-based design system, a small set of Vue component primitives, a rethought information architecture with room for the later stages, written design principles, and a refactor of the existing pages onto all of it. After this stage, a new page is assembled from documented primitives and tokens instead of new ad hoc CSS, and an agent or human contributor can find the rules in one place.

## Plan documents

The detailed design lives under [stage-04.5/](stage-04.5/), in build order:

- [information-architecture.md](stage-04.5/information-architecture.md): the sitemap, page purposes, the navigation model with visible placeholders for the sections stages 5 through 9 add, and text wireframes. This document is the approval artifact for the IA: pages are not rebuilt until the owner approves it.
- [design-foundation.md](stage-04.5/design-foundation.md): the design tokens, the shrink of the global stylesheet to tokens plus reset plus app layout, the Reka UI adoption decision, the `components/ui/` primitives, and the dev-only styleguide route.
- [page-restructure.md](stage-04.5/page-restructure.md): folder and naming conventions, the composables extracted from the big pages, the app shell and navigation rebuild, and the page by page migration with Home as the reference page.
- [accessibility-and-responsive.md](stage-04.5/accessibility-and-responsive.md): the accessibility baseline (focus, ARIA, keyboard replay transport, color never the sole indicator, reduced motion) and the responsive pass (breakpoints and narrow-screen behavior).
- [testing-and-docs.md](stage-04.5/testing-and-docs.md): how the existing suites survive the refactor, the shared test utilities, the new primitive and composable suites, end-to-end updates, and the documentation deliverables (`docs/contributors/design.md`, the agents.md consistency section, the frontend.md update).

## Scope

Adopt a design system built from two layers: semantic CSS custom properties (the tokens) and a small library of Vue primitives under `components/ui/`. Simple primitives (button, badge, card, field) are hand-rolled; components where focus management and ARIA are genuinely hard (dialog, slider) wrap Reka UI, the headless Vue component library. Reka UI is the frontend's first third-party UI dependency, adopted deliberately and recorded in [design-foundation.md](stage-04.5/design-foundation.md).

Component styles move from the global stylesheet into scoped CSS in each component, consuming tokens only. The global stylesheet shrinks to the token definitions, a reset, and the app shell layout. The visual design is reworked in the same pass: the existing fonts stay (EB Garamond for headings, Lato for body), the theme stays dark only, and the palette becomes slightly playful colors on a modern-minimal base. Token names are semantic so a light theme stays possible later, but none is built now.

The information architecture is rethought, not just reskinned. Navigation gains the sections later stages will fill (agents, leaderboards), shown as visible coming-soon placeholders rather than dead links, so the product's shape is legible before the stages land. This deliberately supersedes the Stage 4 decision in [stage-04/frontend-infrastructure.md](stage-04/frontend-infrastructure.md) that pages render without placeholders; that decision predates the IA rethink and is reversed at the navigation level here.

The existing pages are decomposed as they migrate: shared page logic moves into composables (`composables/`), shared formatting into `lib/`, file naming becomes consistent (PascalCase pages with a `Page` suffix), and the largest pages split into presentational children where extraction alone is not enough. The session and replay stages also gain a per-tick decision log — a shared feature component fed the agent actions already carried in the state stream — and the renderer contract gains a targeted-canvas-size field so the host can place that log beside or below the canvas; this is a now-feature, distinct from the Stage 7 LLM call metadata it is sometimes confused with, which is queried by request, not streamed. An accessibility baseline and a responsive pass with documented breakpoints apply to every page. A dev-only `/styleguide` route renders every primitive in every variant and stays out of the production bundle.

The work lands incrementally on main. Two explicit owner checkpoints gate the flow: the IA proposal must be approved before any page is rebuilt, and the styleguide plus the redesigned Home page must be approved before the remaining pages migrate. Every step leaves the app working and the test suites green; old CSS is deleted only when nothing references it.

## Spec references

[frontend.md](../specs/frontend.md) (pages and flows, including the future pages the IA must anticipate), [interaction.md](../specs/interaction.md) (the renderer chrome split that the game-stage spotlight principle formalizes), [recording.md](../specs/recording.md) (the replay viewer this stage restyles).

## Depends on

Stage 4 (the frontend this stage restructures).

## Deferred work

A light theme: the token architecture keeps one possible (semantic names over a private raw palette) but only the dark theme is designed, built, and tested. GitHub OAuth remains deferred exactly as Stage 4 left it; the new app shell keeps the same identity seam. Visual regression tooling (screenshots of the styleguide) is noted as an open question, not a commitment.

## Done when

The owner has approved the IA document and the styleguide plus redesigned Home checkpoint. All four pages run on tokens and `components/ui/` primitives with scoped styles, navigation shows the coming-soon placeholders, and the global stylesheet contains only tokens, reset, and app layout. The session and replay stages show the per-tick decision log built from the agent actions in the state stream, placed beside or below the canvas per the renderer's targeted canvas size. Every primitive variant appears on the dev-only styleguide route, which is absent from the production bundle. The keyboard operates the replay transport, focus is visible everywhere, no status is conveyed by color alone, and the pages are usable at the documented breakpoints. The unit suites, the type check, and the Playwright journey pass. `docs/contributors/design.md` exists, agents.md carries the UI consistency rules, `docs/contributors/frontend.md` reflects the new layout, and no raw color or spacing literals remain outside the token file (renderers exempt).

## Build order

1. Author this file and the five plan documents.
2. The IA proposal in [information-architecture.md](stage-04.5/information-architecture.md). Owner approval of that document is checkpoint one; iterate on the document until approved. Steps 3 and 4 do not depend on it and proceed in parallel.
3. The token files (`src/styles/`) with the existing global classes re-expressed over the new tokens, so the current pages keep working unchanged.
4. The `reka-ui` dependency, the `components/ui/` primitives with their unit tests, and the dev-only styleguide route. Nothing else uses the primitives yet.
5. After checkpoint one and step 4: rebuild the app shell and navigation per the approved IA, and redesign Home on the tokens and primitives as the reference page. Owner review of the styleguide and Home is checkpoint two; iterate until approved.
6. Migrate the remaining pages one step each: Environment (start form becomes a dialog), then Session (extracting the session composables, adding the per-tick decision log built from the agent actions already in the state stream, and the targeted-canvas-size renderer metadata that places the log beside or below the canvas), then Replay (transport composable, keyboard support, slider scrubber, and the same decision log replayed from the recorded states). Session before Replay because they share composables and the decision log component.
7. The accessibility and responsive audit sweep across all pages, including moving the Flappy Bird renderer's inline canvas styles into CSS.
8. Delete dead CSS, finish renames, write `docs/contributors/design.md` and the agents.md section, update `docs/contributors/frontend.md`, and sync all stage files. The stage closes here.

## Open questions

- ~~Reka UI bundle impact.~~ Resolved: the production build was grepped — the bundle carries the imported Dialog and Slider components and none of Reka's others.
- ~~Reka Slider versus a styled native range input for the replay scrubber.~~ Resolved: Reka Slider is kept (`UiSlider`). Its keyboard operation and value announcement come for free, and the `slider` role survives for the unit and e2e locators; the e2e drives it by keyboard rather than `fill()`.
- ~~Whether the start form opens as a dialog or stays inline on the Environment page.~~ Resolved (IA): it opens as a `UiDialog`.
- Whether Playwright screenshots of the styleguide are worth maintaining as visual regression coverage. Still open, deferred — no screenshot coverage was added.
- ~~The placeholder copy and the placement of the signed-in readout in the new navigation.~~ Resolved (IA): `Agents` / `Leaderboards` with a `soon` tag on the left; the signed-in readout on the right.
- Each of stages 5 through 9 must retire its navigation placeholder when it lands; those stage files get a one-line note when this stage closes (i.e. after checkpoint-two sign-off).
