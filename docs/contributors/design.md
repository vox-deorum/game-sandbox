# The design system

The frontend design system has two layers:

```text
semantic CSS tokens → Vue UI primitives → feature components → pages
```

Read this page before visual work. Use [Frontend](frontend.md) for package mechanics and [Rendering](rendering.md) for game visuals.

## Working rules

1. Use semantic tokens, not raw color or spacing values.
2. Build from `src/components/ui/` primitives.
3. Add every primitive variant to `/styleguide`.
4. Preserve the accessibility baseline.
5. Confirm a new visual pattern or open design decision with the owner.
6. Update jsdom and Playwright coverage for every UI change.

## Design principles

- **Clarity for data-dense views.** Sessions, replays, and leaderboards are tables and counters first. Favor legibility through a clear type scale, monospace identifiers and numbers, and restrained color.
- **Accessibility is a rule, not an aspiration.** The baseline below holds for every page and every primitive. It is not a backlog item; a change that regresses it is incomplete.
- **The game-stage spotlight.** On the session and replay pages the renderer canvas is the star and the chrome around it stays quiet. Renderers own their own visual identity (they are exempt from the token rule); the host owns the calm frame around them.
- **Calm motion.** Motion is purposeful and short, expressed through the motion tokens so `prefers-reduced-motion` stills all of it at once. Nothing animates to draw attention to itself.
- **Be considerate about what to show.** Show the facts that matter and highlight the one that matters most; do not surface everything because it is available.
- **For agents: confirm before assuming on design decisions.** Inventing a visual pattern or resolving an open design question is the owner's call. Ask.

## The token system

`frontend/src/styles/tokens.css` is the single source of design values, defined as CSS custom properties on `:root` in two tiers.

- The **raw palette** tier (`--palette-*`) holds the literal values and is private: nothing outside `tokens.css` references a `--palette-*` variable. This is what keeps a future light theme a remap of the semantic tier rather than a rewrite of component CSS.
- The **semantic** tier is the public vocabulary components consume: `--color-*`, `--space-*`, `--text-*`, the font families, `--radius-*`, and the motion tokens.

Component CSS uses semantic variables: no raw hex colors and no arbitrary spacing values. Layout dimensions such as column width, maximum width, and breakpoints may use plain values. Renderer modules are exempt because each game owns its visual identity.

The scales:

- **Spacing** `--space-1`…`--space-8` on a 4px base: 4, 8, 12, 16, 24, 32, 48, 64.
- **Type size** `--text-xs`…`--text-2xl`: 0.75, 0.875, 1, 1.125, 1.375, 1.75 rem.
- **Radii** `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-full` (pill).
- **Motion** `--motion-fast` (~120ms), `--motion-base` (~200ms), `--ease-out`. A global `prefers-reduced-motion: reduce` block in `base.css` zeroes the durations, so any component animating with the tokens calms down automatically.

The global stylesheet is four files imported in order by `main.ts`: `tokens.css` (the tokens), `base.css` (the reset, element defaults, the one global `:focus-visible` style, the reduced-motion block), `app.css` (the app shell layout only), and `season-rows.css` (the compact row, status stripe, date, and visually hidden utilities shared by My Agents and agent profiles). Everything else is scoped component CSS on the tokens.

## Type and color

The fonts: **EB Garamond** for headings (`--font-heading`), **Lato** for body (`--font-body`), and a monospace stack (`--font-mono`) for identifiers, ticks, scores, and other counters. The theme is **dark only**; the semantic names are light-ready (a light theme would remap the palette tier) but none is built.

The palette is a modern-minimal base with slightly playful accents. The background and surface ramp is a quiet blue-charcoal family (`--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-border`, `--color-border-strong`); text is `--color-text` and `--color-text-muted`. The accent is a bright mint (`--color-accent` on `--color-on-accent`); status colors are `--color-success`, `--color-warning` (amber), and `--color-danger` (coral). `--color-current` is the sky blue used to distinguish a current Season from successful historical rows. `--color-focus-ring` is the focus sky blue, `--color-scrim` the dialog overlay, and `--color-stage-backdrop` the true black behind a renderer canvas. Status is **never** carried by color alone: see the baseline.

## Component primitives

The primitives live in `frontend/src/components/ui/`, PascalCase with a `Ui` prefix, one per file, scoped styles, typed props and emits. The inventory:

| Primitive | Replaces / role |
| --- | --- |
| `UiButton` | All buttons and button-styled links (renders a `<button>` or a `RouterLink` via `to`). Variants primary/secondary/ghost/danger, sizes tight/md/lg, disabled and loading states. |
| `UiBadge` | Small text-bearing tags. Always text, never a bare glyph or color-only dot. |
| `UiStatusBadge` | Live status: a colored dot **paired with a text label** that carries the meaning. |
| `UiCard` | A bordered surface (optional padding, optional interactive hover). Layout inside is the caller's. |
| `UiField` + `UiInput` | A labelled field with automatic `id`/`aria-describedby` wiring for hint and error text. |
| `UiDialog` | The modal dialog (focus trap, escape, focus restore, `aria-modal`), wrapping Reka UI Dialog. |
| `UiSlider` | The replay scrubber (keyboard operation and value announcement), wrapping Reka UI Slider. |
| `UiEmptyState` | The loading / empty / error message line, muted or danger. |

Simple primitives are local Vue components. Use Reka UI only where focus management and ARIA are difficult to implement safely, currently dialog and slider.

To add a variant, update the typed prop, scoped styles, tests, and `/styleguide`. A variant absent from the styleguide does not exist.

Feature components (`AppShell`, `AppSidebar`, `AccountMenu`, `ExperimentTabs`, `StartForm`, `RunMetadata`, `DecisionLog`) live in `src/components/`, not `components/ui/`; they are built on the primitives but are not primitives themselves.

## Layout and responsiveness

The **app shell** is a two-tier navigation frame:

- A collapsible left sidebar contains Games, Seasons, Documentation, My Agents, and the account block.
- Environment routes add a contextual tab strip for Overview, Leaderboards, My Submissions, and the operator-only Manage page.
- The sidebar becomes an icon rail on desktop and an off-canvas drawer on narrow screens.
- The main content column is centered and width-limited.
- Pages use a one-line context label such as `Games / Flappy Bird / …` instead of a breadcrumb component.

See the [frontend contributor guide](frontend.md#navigation).

The breakpoints are 480px, 768px, and 1024px. They are plain values because CSS custom properties cannot parameterize media queries.

The design began desktop-first but must remain usable at narrow widths:

- The home grid flows with `auto-fill`.
- The environment thumbnail moves below its description.
- Session and replay pages stack the canvas and decision log and cap the canvas at the viewport width.
- The sidebar becomes a drawer behind a mobile bar.

The session and replay pages place the decision log beside a portrait canvas (a column is always left free), and beside a landscape one (Hearts) only once the viewport is wide enough to hold both the canvas at a good size and the log column, stacking it below otherwise. The renderer's declared `aspectRatio` chooses the orientation; a viewport-width media query (`useStageLayout`) decides whether a landscape canvas earns the second column. A landscape canvas grows to fill its column, capped so its height never exceeds the fold while preserving its aspect ratio.

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

- [specs/interaction.md](../specs/interaction.md): the renderer contract and the chrome split this system frames.
- [frontend.md](frontend.md): the package, the source layout, and the page-by-page mechanics.
