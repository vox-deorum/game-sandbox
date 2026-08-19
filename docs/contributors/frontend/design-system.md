# The design system

The frontend design system owns two layers, tokens and primitives. Feature components and pages consume them:

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
6. Update jsdom and Playwright coverage for every UI change, as [Testing](../testing/index.md#browser-end-to-end) requires.

## Design principles

- **Clarity for data-dense views.** Sessions, replays, and leaderboards primarily present tables and counters. Keep them legible with a clear type scale, monospace identifiers and numbers, and restrained color.
- **Accessibility is a rule, not an aspiration.** The baseline below holds for every page and every primitive.
- **The game stage is the focus.** On session and replay pages, the renderer canvas is the main visual element and the surrounding controls stay quiet. The host owns the calm frame around them.
- **Calm motion.** Motion is purposeful, short, and expressed through the motion tokens. Nothing animates to draw attention to itself. Game renderers do not honor `prefers-reduced-motion`.
- **Be considerate about what to show.** Show the facts that matter and highlight the most important one. Do not surface everything just because it is available.

## The token system

`frontend/src/styles/tokens.css` is the single source of design values, defined as CSS custom properties on `:root` in two tiers.

- The private **raw palette** tier (`--palette-*`) holds literal values, and nothing outside `tokens.css` may reference one. That boundary would let a future light theme remap the semantic tier without rewriting component CSS.
- The public **semantic** tier is the vocabulary used by components: `--color-*`, `--space-*`, `--text-*`, font families, `--radius-*`, and motion tokens.

Component CSS uses semantic variables: no raw hex colors and no arbitrary spacing values. Layout dimensions such as column width, maximum width, and breakpoints may use plain values. Renderer modules are exempt because each game owns its visual identity.

The scales:

- **Spacing** `--space-1`…`--space-8` on a 4px base: 4, 8, 12, 16, 24, 32, 48, 64.
- **Type size** `--text-xs`…`--text-2xl`: 0.75, 0.875, 1, 1.125, 1.375, 1.75 rem.
- **Radii** `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-full` (pill).
- **Motion** `--motion-fast` (~120ms), `--motion-base` (~200ms), `--motion-spinner` (~800ms), `--ease-out`. Components animate with these only, so one change here retimes the whole product.

`main.ts` imports five global stylesheets in order:

1. `tokens.css` defines the tokens.
2. `base.css` provides the reset, element defaults, and the global `:focus-visible` style.
3. `app.css` contains only the application shell layout.
4. `season-rows.css` provides the compact row, status stripe, and date styles shared by My Agents and agent profiles. Global accessibility utilities, including visually hidden text, live in `base.css`.
5. Highlight.js's `github-dark.css` colors syntax tokens in the in-app documentation's code blocks.

All other styles are component-scoped CSS that uses the tokens.

## Type and color

The interface uses **EB Garamond** for headings (`--font-heading`), **Lato** for body text (`--font-body`), and a monospace stack (`--font-mono`) for identifiers, ticks, scores, and other counters. Only a dark theme exists, though the semantic names could support a light one by remapping the semantic tier.

The palette uses a quiet blue-charcoal family for backgrounds, surfaces, and borders (`--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-border`, `--color-border-strong`). Text uses `--color-text` and `--color-text-muted`. The accent is bright mint (`--color-accent` on `--color-on-accent`), while statuses use `--color-success`, amber `--color-warning`, and coral `--color-danger`. Sky blue `--color-current` distinguishes the current Season from successful historical rows, and `--color-focus-ring` is the focus color. `--color-scrim` is the dialog overlay, and `--color-stage-backdrop` is the black behind a renderer canvas. Color never carries status by itself; follow the accessibility baseline below.

## Component primitives

The primitives live in `frontend/src/components/ui/`, PascalCase with a `Ui` prefix, one per file, scoped styles, typed props and emits. The inventory:

| Primitive | Replaces / role |
| --- | --- |
| `UiButton` | All buttons and button-styled links (renders a `<button>`, a `RouterLink` via `to`, or a native link via `href`). Variants primary/secondary/ghost/danger, sizes tight/md/lg, disabled and loading states. |
| `UiAvatar` | A compact or profile-sized user image with an accessible initial-letter fallback. |
| `UiBadge` | Small text-bearing tags. Always text, never a bare glyph or color-only dot. |
| `UiStatusBadge` | Live status: a colored dot **paired with a text label** that carries the meaning. |
| `UiCard` | A bordered surface (optional padding, optional interactive hover). The `info` variant gives short guidance and summaries a stronger border and background. Layout inside is the caller's. |
| `UiField` + `UiInput` + `UiTextarea` | Labelled single-line and multiline fields with automatic `id`/`aria-describedby` wiring for hint and error text. |
| `UiSelect` | A native `<select>` styled to match `UiInput`, paired with `UiField` for label wiring. Options render through the default slot. |
| `UiDialog` | The modal dialog (focus trap, escape, focus restore, `aria-modal`), wrapping Reka UI Dialog. Its header line always carries an `X` close button (`aria-label="Close"`) at the far right, so a dialog needs no separate close control unless the control also does something else, such as a `Back` or `Cancel` action. |
| `UiDialogActions` | The shared right-aligned, wrapping footer for dialog actions. Use it for confirmations, with the consequential action first and a ghost Cancel control second. |
| `UiSlider` | The replay scrubber (keyboard operation and value announcement), wrapping Reka UI Slider. |
| `UiTabs` | A single-select tab strip for filters and section switches that are not routes, following the WAI-ARIA roving-tabindex pattern. |
| `UiMeter` | Read-only progress with a required visible text value. First used for LLM development budgets. |
| `UiCheckboxGroup` | A labelled fieldset for selecting zero or more string options, with options emitted in their declared order. |
| `UiTooltip` | A quiet underlined trigger with a detail bubble on hover, focus, or click. The bubble teleports to the body, so it escapes a table cell or a scrolling log, and mounts nothing while closed. `inspectable` turns the trigger into an `inspect` emit for a caller that opens a fuller view instead. |
| `UiEmptyState` | The loading / empty / error message line, muted or danger. |

Simple primitives are local Vue components; the dialog and slider instead wrap Reka UI (a headless Vue component library, used only where accessible focus and keyboard handling are hard to hand-roll).

Confirmation dialogs state the consequence in `UiDialog` and put their actions in `UiDialogActions`. Keep the action text specific, make irreversible actions `danger`, leave cancellation as a ghost button, and preserve any loading or error state in the feature component. Every dialog header already carries the universal `X` close button, so do not add a top-right text `Close`; a `Cancel` button stays only where it reads as the paired "no" to a consequential action.

### Add a variant

1. Update the typed prop.
2. Update the scoped styles.
3. Update the tests.
4. Add the variant to `/styleguide`.

A variant absent from the styleguide does not exist.

Feature components (`AppShell`, `AppSidebar`, `AccountMenu`, `ExperimentTabs`, `StartForm`, `RunMetadata`, `DecisionLog`) live in `src/components/`, not `components/ui/`; they are built on the primitives but are not primitives themselves.

## Layout and responsiveness

The application shell has two levels of navigation: a collapsible left sidebar, and on environment routes, a contextual tab strip that adds the Manage page, visible only to operators (the signed-in admin role). See [specs/frontend.md#navigation](../../specs/frontend.md#navigation) for the canonical list of items and [development.md#navigation](development.md#navigation) for where the code lives.

- The sidebar becomes an icon rail on desktop and an off-canvas drawer on narrow screens.
- The main content column is centered and width-limited.
- Pages use a one-line context label such as `Games / Flappy Bird / …` instead of a breadcrumb component.

The breakpoints are 480px, 768px, and 1200px. The 1200px threshold lets a landscape game stage place its decision log beside the canvas. The breakpoints are plain values because CSS custom properties cannot parameterize media queries.

The layout must stay usable from narrow phone widths through wide desktops:

- The home grid flows with `auto-fill`.
- The environment thumbnail moves below its description.
- Session and replay pages stack the canvas and decision log and cap the canvas at the viewport width.
- The sidebar becomes a drawer behind a mobile bar.

Session, replay, and local-play pages always leave room to place the decision log beside a portrait canvas. For a landscape canvas such as Hearts, they use two columns only when the viewport can show the canvas at a useful size next to the log; otherwise the log moves below. The renderer's `aspectRatio` determines its orientation, and the `useStageLayout` media query decides whether a landscape canvas gets a second column. The canvas fills that column while preserving its aspect ratio and staying short enough to fit above the fold. Local play reuses the shared session frame and controls.

## The accessibility baseline

This is the checklist the responsive-and-accessibility audit walks for every page and primitive.

- **Focus is visible everywhere.** `base.css` defines one global `:focus-visible` outline on `--color-focus-ring`; no component removes an outline without replacing it.
- **Color is never the sole indicator.** Status pairs a dot with a text label (`UiStatusBadge`); badges carry text; the pin marker is a labelled badge, not a glyph; error and success colors always accompany words.
- **Interactive controls are labelled.** Form fields get automatic label and `aria-describedby` wiring through `UiField`; icon-only affordances carry an `aria-label` or visually hidden text. The dialog traps focus, closes on escape or its header `X`, and restores focus to its trigger.
- **The replay transport is fully keyboard operable.** Space toggles play, the arrows step, Home and End jump, and the scrubber announces its position (`aria-valuenow` against the tick count). The keyboard map lives in `useReplayTransport` and is tested.
- **Touch targets** on the replay transport controls clear a 44px minimum.

The renderer canvas itself is exempt (it is the game, and renderers own their identity), but the chrome around it is not: the session and replay pages must be fully operable without a pointer, except for playing a game that itself demands one.

## See also

- [specs/interaction.md](../../specs/interaction.md): the renderer contract and the chrome split this system frames.
- [development.md](development.md): the package, the source layout, and the page-by-page mechanics.
