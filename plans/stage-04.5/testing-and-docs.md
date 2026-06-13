# Stage 4.5: Testing and Documentation

Status: implemented. The existing suites survived the refactor (role- and text-based queries are mostly blind to the primitive swap; the touched copy and the e2e scrubber drive updated in the same change), the primitive, decision-log, and composable behaviors are covered, and the three documentation deliverables are written: `docs/contributors/design.md`, the agents.md UI-consistency section, and the `docs/contributors/frontend.md` update. The shared `test/helpers/` extraction is the one deferred item — the suites still carry their own fixtures and render wrappers; consolidating them is left as low-risk follow-up.

Part of [Stage 4.5](../stage-04.5-ui-restructure.md). This document covers how the existing suites survive the refactor, what new coverage the design system gets, and the three documentation deliverables: `docs/contributors/design.md`, the agents.md consistency section, and the `docs/contributors/frontend.md` update.

## Surviving the refactor

The unit suites query by role and visible text through Testing Library, so swapping CSS classes for primitives is mostly invisible to them. Where the redesign changes visible copy (the pin button's label, status text), the page test and the Playwright journey update in the same commit as the copy. The end-to-end suite's class-based locators are the watch list: the end card, the overlay banner, and the `flappy-canvas` canvas class, which the renderer keeps. The scrubber is located by its `slider` role, which Reka UI Slider also exposes, so that locator survives either scrubber decision.

The session and replay page suites stay page-level integration tests. As logic moves into composables, the fine-grained cases (pin error handling, transport stepping, socket status transitions) move into composable suites and the page suites keep the wiring-level assertions.

## Shared test utilities

`frontend/test/helpers/` deduplicates the patterns currently copied between files: `fixtures.ts` for the environment metadata literal that appears in six suites and the recording fixtures, `render.ts` for a `renderWithMe()` that wraps a component in the `MeProvider` and a memory-history router (currently hand-rolled in three suites), and `fetchStub.ts` for the fetch stubbing pattern. Existing suites adopt the helpers as their features migrate, not in a big sweep.

## New coverage

Each primitive gets a focused suite as it is built: button variants and the link-versus-button rendering, dialog open, close, escape, and focus trap, slider keyboard operation and value exposure, field label and description association, status badge text presence. Composables get suites against stubs: `usePinning` against a stubbed client, `useSessionSocket` against a fake socket, `useReplayTransport`'s keyboard map. The styleguide page gets a smoke test that it renders every registered primitive without error. The replay page gains a keyboard transport test at the page level. The decision log gets a focused suite: it renders a row per tick from the agent actions in a state sequence, formats an action value, and stays pinned to the latest tick — the same component asserted once and reused by both the session and replay page suites.

The verification gates for every step of the stage: the Vitest suites, `vue-tsc`, and the Playwright journey stay green, and the production build is checked once per foundation change for the styleguide chunk's absence and for Reka UI contributing only the imported components.

## docs/contributors/design.md

The design system's home, written for contributors and agents. Its sections:

1. Design principles: clarity for data-dense views; accessibility as a rule, not an aspiration; the game-stage spotlight (the renderer canvas is the star, the chrome stays quiet, renderers own their visual identity); calm motion (purposeful, reduced-motion respected); be considerate about what data to show and highlight; and for agents, confirm before assuming on design decisions.
2. The token system: the two tiers, the naming scheme, the scales, the no-raw-values rule and its renderer exemption, how scoped component CSS consumes tokens.
3. Type and color: the font roles (EB Garamond headings, Lato body, monospace for identifiers and counters), the palette and its semantic roles, dark-only today with light-ready naming.
4. Component primitives: the inventory, the hand-rolled versus Reka UI policy, how to add a variant, and the rule that every variant appears on the styleguide route.
5. Layout and responsiveness: the app shell, the breakpoints, page width conventions.
6. The accessibility baseline as a concrete checklist (the one the audit in [accessibility-and-responsive.md](accessibility-and-responsive.md) walks).
7. Cross-links to [specs/interaction.md](../../specs/interaction.md) for the renderer contract and to `frontend.md` for package mechanics, rather than duplicating either.

## agents.md

A short UI consistency subsection joins "Working on this repo": use the semantic tokens (no raw colors or spacing outside `tokens.css`), build UI from the `components/ui/` primitives instead of new ad hoc CSS, put every new variant on the styleguide page, read `docs/contributors/design.md` before visual work, and confirm with the owner before inventing new visual patterns or settling open design questions.

## docs/contributors/frontend.md

Updated for the new source layout (`styles/`, `components/ui/`, `composables/`, `lib/`, the page naming), the styleguide route and its dev-only mechanics, and a pointer to `design.md` as the design authority. The stage files themselves are kept in sync with implementation choices as they are confirmed, per the plan rules.
