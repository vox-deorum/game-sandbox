# The design system

The frontend design system has two layers:

```text
semantic CSS tokens → Vue UI primitives → feature components → pages
```

Read this page before changing the interface. See [Frontend](development.md) for package mechanics and [Rendering](../environments/rendering.md) for game visuals.

## Working rules

1. Use semantic tokens, not raw color or spacing values.
2. Build from `src/components/ui/` primitives.
3. Add every primitive variant to `/styleguide`.
4. Preserve the accessibility baseline.
5. Confirm a new visual pattern or open design decision with the owner.
6. Update jsdom and Playwright coverage for every UI change.

## Design principles

- **Clarity for data-dense views.** Sessions, replays, and leaderboards primarily present tables and counters. Keep them legible with a clear type scale, monospace identifiers and numbers, and restrained color.
- **Accessibility is a rule, not an aspiration.** The baseline below holds for every page and every primitive. It is not a backlog item; a change that regresses it is incomplete.
- **The game stage is the focus.** On session and replay pages, the renderer canvas is the main visual element and the surrounding controls stay quiet. Renderers own their visual identity and are exempt from the token rule. The host owns the calm frame around them.
- **Calm motion.** Motion is purposeful and short, expressed through the motion tokens so `prefers-reduced-motion` stills all of it at once. Nothing animates to draw attention to itself.
- **Be considerate about what to show.** Show the facts that matter and highlight the one that matters most; do not surface everything because it is available.
- **Ask about new design decisions.** The owner decides new visual patterns and open design questions.

## The token system

`frontend/src/styles/tokens.css` is the single source of design values, defined as CSS custom properties on `:root` in two tiers.

- The private **raw palette** tier (`--palette-*`) holds literal values. Nothing outside `tokens.css` may reference a `--palette-*` variable. This boundary would let a future light theme remap the semantic tier without rewriting component CSS.
- The public **semantic** tier is the vocabulary used by components: `--color-*`, `--space-*`, `--text-*`, font families, `--radius-*`, and motion tokens.

Component CSS uses semantic variables: no raw hex colors and no arbitrary spacing values. Layout dimensions such as column width, maximum width, and breakpoints may use plain values. Renderer modules are exempt because each game owns its visual identity.

The scales:

- **Spacing** `--space-1`…`--space-8` on a 4px base: 4, 8, 12, 16, 24, 32, 48, 64.
- **Type size** `--text-xs`…`--text-2xl`: 0.75, 0.875, 1, 1.125, 1.375, 1.75 rem.
- **Radii** `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-full` (pill).
- **Motion** `--motion-fast` (~120ms), `--motion-base` (~200ms), `--ease-out`. A global `prefers-reduced-motion: reduce` block in `base.css` zeroes the durations, so any component animating with the tokens calms down automatically.

`main.ts` imports four global stylesheets in order:

1. `tokens.css` defines the tokens.
2. `base.css` provides the reset, element defaults, global `:focus-visible` style, and reduced-motion block.
3. `app.css` contains only the application shell layout.
4. `season-rows.css` provides the compact row, status stripe, date, and visually hidden utilities shared by My Agents and agent profiles.

All other styles are component-scoped CSS that uses the tokens.

## Type and color

The interface uses **EB Garamond** for headings (`--font-heading`), **Lato** for body text (`--font-body`), and a monospace stack (`--font-mono`) for identifiers, ticks, scores, and other counters. Only a dark theme exists. The semantic names could support a light theme by remapping the palette tier, but no light theme is implemented.

The palette uses a quiet blue-charcoal family for backgrounds, surfaces, and borders (`--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-border`, `--color-border-strong`). Text uses `--color-text` and `--color-text-muted`. The accent is bright mint (`--color-accent` on `--color-on-accent`), while statuses use `--color-success`, amber `--color-warning`, and coral `--color-danger`. Sky blue `--color-current` distinguishes the current Season from successful historical rows, and `--color-focus-ring` provides the focus color. `--color-scrim` is the dialog overlay, and `--color-stage-backdrop` is the black behind a renderer canvas. Color never carries status by itself; follow the accessibility baseline below.

## Component primitives

The primitives live in `frontend/src/components/ui/`, PascalCase with a `Ui` prefix, one per file, scoped styles, typed props and emits. The inventory:

| Primitive | Replaces / role |
| --- | --- |
| `UiButton` | All buttons and button-styled links (renders a `<button>` or a `RouterLink` via `to`). Variants primary/secondary/ghost/danger, sizes tight/md/lg, disabled and loading states. |
| `UiAvatar` | A compact or profile-sized user image with an accessible initial-letter fallback. |
| `UiBadge` | Small text-bearing tags. Always text, never a bare glyph or color-only dot. |
| `UiStatusBadge` | Live status: a colored dot **paired with a text label** that carries the meaning. |
| `UiCard` | A bordered surface (optional padding, optional interactive hover). Layout inside is the caller's. |
| `UiField` + `UiInput` + `UiTextarea` | Labelled single-line and multiline fields with automatic `id`/`aria-describedby` wiring for hint and error text. |
| `UiDialog` | The modal dialog (focus trap, escape, focus restore, `aria-modal`), wrapping Reka UI Dialog. |
| `UiDialogActions` | The shared right-aligned, wrapping footer for dialog actions. Use it for confirmations, with the consequential action first and a ghost Cancel control second. |
| `UiSlider` | The replay scrubber (keyboard operation and value announcement), wrapping Reka UI Slider. |
| `UiMeter` | Read-only progress with a required visible text value. First used for LLM development budgets. |
| `UiCheckboxGroup` | A labelled fieldset for selecting zero or more string options, with options emitted in their declared order. |
| `UiTooltip` | A quiet underlined trigger with a detail bubble on hover, focus, or click. The bubble teleports to the body, so it escapes a table cell or a scrolling log, and mounts nothing while closed. `inspectable` turns the trigger into an `inspect` emit for a caller that opens a fuller view instead. |
| `UiEmptyState` | The loading / empty / error message line, muted or danger. |

Simple primitives are local Vue components. Use Reka UI only where safe focus management and ARIA behavior are difficult to implement. Currently, only the dialog and slider use it.

Confirmation dialogs use `UiDialog` for the consequence and `UiDialogActions` for their footer. Keep the action text specific, make irreversible actions `danger`, keep cancellation as a ghost button, and preserve any loading or error state in the feature component.

To add a variant, update the typed prop, scoped styles, tests, and `/styleguide`. A variant absent from the styleguide does not exist.

Feature components (`AppShell`, `AppSidebar`, `AccountMenu`, `ExperimentTabs`, `StartForm`, `RunMetadata`, `DecisionLog`) live in `src/components/`, not `components/ui/`; they are built on the primitives but are not primitives themselves.

## Layout and responsiveness

The **application shell** has two levels of navigation:

- A collapsible left sidebar contains Games, Seasons, Documentation, My Agents, and the account block.
- Environment routes add a contextual tab strip for Overview, Leaderboards, My Submissions, and the operator-only Manage page.
- The sidebar becomes an icon rail on desktop and an off-canvas drawer on narrow screens.
- The main content column is centered and width-limited.
- Pages use a one-line context label such as `Games / Flappy Bird / …` instead of a breadcrumb component.

See the [frontend contributor guide](development.md#navigation).

The breakpoints are 480px, 768px, and 1024px. They are plain values because CSS custom properties cannot parameterize media queries.

The design began desktop-first but must remain usable at narrow widths:

- The home grid flows with `auto-fill`.
- The environment thumbnail moves below its description.
- Session and replay pages stack the canvas and decision log and cap the canvas at the viewport width.
- The sidebar becomes a drawer behind a mobile bar.

Session, replay, and local-play pages always leave room to place the decision log beside a portrait canvas. For a landscape canvas such as Hearts, they use two columns only when the viewport can show both the canvas at a useful size and the log; otherwise, the log moves below. The renderer's `aspectRatio` determines its orientation, and the `useStageLayout` media query decides whether a landscape canvas gets a second column. The canvas fills that column while preserving its aspect ratio and staying short enough to fit above the fold. Local play reuses the shared session frame and controls.

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

- [specs/interaction.md](../../specs/interaction.md): the renderer contract and the chrome split this system frames.
- [development.md](development.md): the package, the source layout, and the page-by-page mechanics.
