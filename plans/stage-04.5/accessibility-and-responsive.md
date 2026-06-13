# Stage 4.5: Accessibility and Responsive Baseline

Status: implemented. The baseline landed inline with the foundation and page migrations and the sweep is done: focus is visible globally, status never relies on color alone, the replay transport is fully keyboard operable, motion respects `prefers-reduced-motion`, the transport touch targets clear 44px, the pages stack at the documented breakpoints, and the Flappy Bird canvas's inline styles moved into `flappy.css` (keeping the `flappy-canvas` class).

Part of [Stage 4.5](../stage-04.5-ui-restructure.md). Accessibility is a rule in this codebase, not an aspiration: the items here are requirements that hold for every page and every primitive, and the design principles document states them as such.

## Accessibility baseline

Focus is visible everywhere. `base.css` defines one global `:focus-visible` style on the `--color-focus-ring` token, and no component removes an outline without replacing it. Primitives ship with their focus states; this is part of their styleguide definition of done.

Color is never the sole indicator. Status presentation pairs the colored dot with a text label (`UiStatusBadge`), badges carry text, and the pin marker is a labeled badge rather than a bare glyph. The error and success colors always accompany text that says what happened.

Interactive controls are labeled. Form fields get automatic label and `aria-describedby` wiring through `UiField`. Icon-only buttons, if any survive the redesign, carry `aria-label` or visually hidden text. The dialog (start form) traps focus, closes on escape, and restores focus to its trigger, which Reka UI Dialog provides.

The replay transport is fully keyboard operable: space toggles play and pause, the arrow keys step, Home and End jump to the start and end, and the scrubber exposes its position (`aria-valuenow` against the tick count) so assistive tech can announce it. The keyboard handler lives in `useReplayTransport` and is unit tested.

Motion respects `prefers-reduced-motion`: the global block in `base.css` zeroes the motion token durations, so any component animating with the tokens calms down automatically. Components must not hardcode durations, which the no-raw-values rule already covers.

The renderer canvas itself is exempt from these rules (it is the game, and renderers own their identity), but the chrome around it is not: the session and replay pages must be fully operable without a pointer, except for playing a game that itself demands one.

## Responsive pass

Breakpoints are 480px, 768px, and 1024px, documented in `docs/contributors/design.md` and used as plain values in scoped media queries (CSS custom properties cannot parameterize media queries). The design is desktop-first in origin but must remain usable, not merely unbroken, at narrow widths.

Per page: the home gallery's card grid already flows with `auto-fill`; it keeps that behavior with tokens for the gaps. The environment hub's section column stacks naturally; the thumbnail drops below the description on narrow screens. The session and replay stages cap the canvas at the viewport width with the stage centered; the status strip and transport bar wrap rather than overflow, and touch targets on the transport controls meet a 44px minimum. The top bar keeps all three zones, with the placeholder entries collapsing first when space runs out.

## The audit

This sweep closes the build-order step: walk every page at the three breakpoints and with keyboard only, against the checklist above. The Flappy Bird renderer's inline canvas styles (set from JavaScript at mount) move into CSS in the same sweep, keeping the `flappy-canvas` class name the end-to-end suite locates. Whether an automated axe scan joins the Playwright suite is recorded as an open question in the parent file, not assumed.
