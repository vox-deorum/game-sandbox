# The design system

This is the design system's home, for contributors and agents. The frontend is built from two layers: semantic CSS custom properties (the tokens) and a small library of Vue primitives under `frontend/src/components/ui/`. A new page is assembled from documented primitives and tokens, not new ad hoc CSS. Read this page before any visual work; [AGENTS.md](../../AGENTS.md) carries the short version of the rules.

It covers the principles, the token system, type and color, the primitives, layout and responsiveness, and the accessibility baseline. For the renderer contract (how a game draws itself) see the [interaction spec](../../specs/interaction.md); for package mechanics see [frontend.md](frontend.md).

## Design principles

- **Clarity for data-dense views.** Sessions, replays, and the leaderboards to come are tables and counters first. Favor legibility — a clear type scale, monospace for identifiers and numbers, restrained color — over decoration.
- **Accessibility is a rule, not an aspiration.** The baseline below holds for every page and every primitive. It is not a backlog item; a change that regresses it is incomplete.
- **The game-stage spotlight.** On the session and replay pages the renderer canvas is the star and the chrome around it stays quiet. Renderers own their own visual identity (they are exempt from the token rule); the host owns the calm frame around them.
- **Calm motion.** Motion is purposeful and short, expressed through the motion tokens so `prefers-reduced-motion` stills all of it at once. Nothing animates to draw attention to itself.
- **Be considerate about what to show.** Show the facts that matter and highlight the one that matters most; do not surface everything because it is available.
- **For agents: confirm before assuming on design decisions.** Inventing a visual pattern or resolving an open design question is the owner's call. Ask.

## The token system

`frontend/src/styles/tokens.css` is the single source of design values, defined as CSS custom properties on `:root` in two tiers.

- The **raw palette** tier (`--palette-*`) holds the literal values and is private: nothing outside `tokens.css` references a `--palette-*` variable. This is what keeps a future light theme a remap of the semantic tier rather than a rewrite of component CSS.
- The **semantic** tier is the public vocabulary components consume: `--color-*`, `--space-*`, `--text-*`, the font families, `--radius-*`, and the motion tokens.

**The no-raw-values rule:** component CSS uses `var(--…)` only — no raw hex colors, and no arbitrary rem/px for padding, gaps, or margins (use the `--space-*` scale). Layout dimensions that are not on the spacing scale (a column width, a `max-width`, the breakpoints) are plain values. Renderer modules under `src/renderers/` are exempt, because a renderer owns its game's visual identity. Biome excludes `.vue` files, so this rule is enforced by review and a grep over component sources, not by lint.

The scales:

- **Spacing** `--space-1`…`--space-8` on a 4px base: 4, 8, 12, 16, 24, 32, 48, 64.
- **Type size** `--text-xs`…`--text-2xl`: 0.75, 0.875, 1, 1.125, 1.375, 1.75 rem.
- **Radii** `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-full` (pill).
- **Motion** `--motion-fast` (~120ms), `--motion-base` (~200ms), `--ease-out`. A global `prefers-reduced-motion: reduce` block in `base.css` zeroes the durations, so any component animating with the tokens calms down automatically.

The global stylesheet is three files imported in order by `main.ts`: `tokens.css` (the tokens), `base.css` (the reset, element defaults, the one global `:focus-visible` style, the reduced-motion block), and `app.css` (the app shell layout only). Everything else is scoped component CSS on the tokens.

## Type and color

The fonts: **EB Garamond** for headings (`--font-heading`), **Lato** for body (`--font-body`), and a monospace stack (`--font-mono`) for identifiers, ticks, scores, and other counters. The theme is **dark only**; the semantic names are light-ready (a light theme would remap the palette tier) but none is built.

The palette is a modern-minimal base with slightly playful accents. The background and surface ramp is a quiet blue-charcoal family (`--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-border`, `--color-border-strong`); text is `--color-text` and `--color-text-muted`. The accent is a bright mint (`--color-accent` on `--color-on-accent`); status colors are `--color-success`, `--color-warning` (amber), and `--color-danger` (coral). `--color-focus-ring` is the focus sky blue, `--color-scrim` the dialog overlay, and `--color-stage-backdrop` the true black behind a renderer canvas. Status is **never** carried by color alone — see the baseline.

## Component primitives

The primitives live in `frontend/src/components/ui/`, PascalCase with a `Ui` prefix, one per file, scoped styles, typed props and emits. The inventory:

| Primitive | Replaces / role |
| --- | --- |
| `UiButton` | All buttons and button-styled links (renders a `<button>` or a `RouterLink` via `to`). Variants primary/secondary/ghost/danger, sizes md/lg, disabled and loading states. |
| `UiBadge` | Small text-bearing tags. Always text, never a bare glyph or color-only dot. |
| `UiStatusBadge` | Live status: a colored dot **paired with a text label** that carries the meaning. |
| `UiCard` | A bordered surface (optional padding, optional interactive hover). Layout inside is the caller's. |
| `UiField` + `UiInput` | A labelled field with automatic `id`/`aria-describedby` wiring for hint and error text. |
| `UiDialog` | The modal dialog (focus trap, escape, focus restore, `aria-modal`), wrapping Reka UI Dialog. |
| `UiSlider` | The replay scrubber (keyboard operation and value announcement), wrapping Reka UI Slider. |
| `UiEmptyState` | The loading / empty / error message line, muted or danger. |

**Hand-rolled versus Reka UI:** simple primitives are hand-rolled on the tokens. A third-party library (Reka UI, the headless Vue library) is used **only** where focus management and ARIA are genuinely hard to get right by hand — today the dialog and the slider, nothing else. At adoption the production bundle was verified to grow only by the components actually imported.

**Adding a variant:** add the prop value and its scoped styles, then add it to the `/styleguide` route. Every variant and state of every primitive appears there; a variant that is not on the styleguide does not exist. The route is registered only in dev builds (`import.meta.env.DEV`) and loaded by dynamic import, so production carries neither the route nor the code.

Feature components (`AppShell`, `AppNav`, `StartForm`, `RunMetadata`, `RecentReplays`, `DecisionLog`) live in `src/components/`, not `components/ui/`; they are built on the primitives but are not primitives themselves.

## Layout and responsiveness

The **app shell** is a single persistent three-zone top bar: the site name (home link) and the primary section nav on the left, the signed-in readout on the right. `Environments` is live; `Agents` and `Leaderboards` are inert coming-soon placeholders (greyed, not links, not focusable, with a `soon` tag) so the product's shape is legible before those stages land. The main content column is centered with a max width. Pages carry their own one-line context line (`Environments / Flappy Bird / …`) rather than a breadcrumb component, because the hierarchy is one level deep.

**Breakpoints** are documented constants — **480px, 768px, 1024px** — used as plain values in scoped media queries (CSS custom properties cannot parameterize media queries). The design is desktop-first in origin but must stay usable, not merely unbroken, at narrow widths: the home grid flows with `auto-fill`; the environment hub's thumbnail drops below its description; the session and replay stages stack the canvas and decision log and cap the canvas at the viewport width; the top bar drops the placeholder entries first. The session and replay stages place the decision log **beside** a portrait canvas (which leaves a column free) and **below** a landscape one, driven by the renderer's declared `targetCanvasSize` rather than measured pixels.

## The accessibility baseline

This is the checklist the responsive-and-accessibility audit walks for every page and primitive.

- **Focus is visible everywhere.** `base.css` defines one global `:focus-visible` outline on `--color-focus-ring`; no component removes an outline without replacing it.
- **Color is never the sole indicator.** Status pairs a dot with a text label (`UiStatusBadge`); badges carry text; the pin marker is a labelled badge, not a glyph; error and success colors always accompany words.
- **Interactive controls are labelled.** Form fields get automatic label and `aria-describedby` wiring through `UiField`; icon-only affordances carry an `aria-label` or visually hidden text. The dialog traps focus, closes on escape, and restores focus to its trigger.
- **The replay transport is fully keyboard operable.** Space toggles play, the arrows step, Home and End jump, and the scrubber announces its position (`aria-valuenow` against the tick count). The keyboard map lives in `useReplayTransport` and is tested.
- **Motion respects `prefers-reduced-motion`.** The global block zeroes the motion-token durations; components must animate with the tokens, which the no-raw-values rule already requires.
- **Touch targets** on the replay transport controls clear a 44px minimum.

The renderer canvas itself is exempt (it is the game, and renderers own their identity), but the chrome around it is not: the session and replay pages must be fully operable without a pointer, except for playing a game that itself demands one.

## See also

- [specs/interaction.md](../../specs/interaction.md) — the renderer contract and the chrome split this system frames.
- [frontend.md](frontend.md) — the package, the source layout, and the page-by-page mechanics.
