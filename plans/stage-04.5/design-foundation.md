# Stage 4.5: Design Foundation

Status: implemented. The tokens, the three-file global stylesheet, the Reka UI adoption, the `components/ui/` primitives with their suites, and the dev-only styleguide route are all built; the production build confirms the styleguide chunk's absence and that Reka contributes only the imported Dialog and Slider. The token values below are as implemented; they may still move during checkpoint-two iteration.

Part of [Stage 4.5](../stage-04.5-ui-restructure.md). This document covers the layer everything else builds on: the design tokens, the reorganized global stylesheets, the Reka UI adoption, the `components/ui/` primitives, and the dev-only styleguide route. None of this depends on the IA approval; it proceeds in parallel and is reviewed at checkpoint two (styleguide plus redesigned Home).

## Tokens

`frontend/src/styles/tokens.css` defines all design values as CSS custom properties on `:root`, in two tiers.

The raw palette tier (`--palette-*`) holds the literal color values and is private: nothing outside `tokens.css` references a `--palette-*` variable. This is what keeps a future light theme a remap of the semantic tier rather than a rewrite of component CSS. Only the dark theme is defined now.

The semantic tier is the public vocabulary components consume:

- Color: `--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-border`, `--color-border-strong`, `--color-text`, `--color-text-muted`, `--color-accent`, `--color-on-accent`, `--color-danger`, `--color-success`, `--color-warning`, `--color-focus-ring`. These absorb the Stage 4 tokens (`--bg`, `--surface`, `--surface-2`, `--text`, `--muted`, `--accent`) and the colors that were hardcoded around them (the error red, the on-accent ink, the overlay scrim).
- Spacing: `--space-1` through `--space-8` on a 4px base (4, 8, 12, 16, 24, 32, 48, 64). Component CSS uses these for padding, gaps, and margins; arbitrary rem values disappear.
- Type: `--text-xs` through `--text-2xl` for the size scale, and `--font-body` (the Lato stack), `--font-heading` (the EB Garamond stack), `--font-mono` (ui-monospace) for the families. The fonts themselves are unchanged from Stage 4 by decision.
- Radii: `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-full` (999px).
- Motion: `--motion-fast` (about 120ms), `--motion-base` (about 200ms), and `--ease-out`. A global `prefers-reduced-motion: reduce` block zeroes the durations, which satisfies the calm-motion principle mechanically for every component at once.

The visual direction for the palette: dark only, modern-minimal base with slightly playful accents, a compromise between playfulness and usefulness. Concretely, the background and surface ramp stays a quiet blue-charcoal family close to Stage 4's, while the accent family gets livelier (the mint accent brightens, warning amber and danger coral join it as real tokens instead of hardcoded hex). The exact values are expected to move during the checkpoint-two iteration on the styleguide; this file records them as implemented once the checkpoint passes.

Breakpoints (480px, 768px, 1024px) cannot be custom properties because CSS variables do not work inside media queries. They are documented constants in `docs/contributors/design.md` and used as plain values in scoped media queries.

The consumption rule: component CSS uses `var(--...)` only, no raw hex colors or spacing literals outside `tokens.css`. Renderer modules are exempt, because renderers own their visual identity per the game-stage spotlight principle. Biome excludes `.vue` files, so this rule is not lint-enforced; it is enforced by review, stated in `design.md` and agents.md, and backed by a grep check over component sources.

## Global stylesheet reorganization

The single `src/styles.css` is replaced by three files under `src/styles/`, imported in order by `main.ts`:

- `tokens.css`: the tokens above, nothing else.
- `base.css`: the reset and element defaults (box sizing, body background and text, heading font family, link behavior, the global focus-visible style, the reduced-motion block).
- `app.css`: the app shell layout only (the top bar zones, the main column and its max width).

During the transition the legacy component classes from `styles.css` survive in a fourth file, re-expressed over the new semantic tokens so the existing pages keep working unchanged while they wait their turn to migrate. As each page migrates to primitives and scoped styles, its classes leave the legacy file; the file is deleted at the end of the stage.

## Reka UI

The frontend adopts `reka-ui` (the headless Vue component library, formerly Radix Vue), pinned to the 2.x line. It is the frontend's first third-party UI dependency beyond Vue and the router, and the adoption rule keeps it narrow: Reka UI is used only where focus management and ARIA are genuinely hard to get right by hand. Everything else is hand-rolled on the tokens.

Used now: Dialog (the start form modal: focus trap, escape handling, aria-modal, the overlay) and Slider (the replay scrubber: keyboard operation and value announcement). VisuallyHidden is available for icon-only affordances. Tooltip found no use and is not adopted. The slider escape hatch (a styled native range input) is resolved in favor of keeping Reka Slider: `UiSlider` wraps it, the `slider` role survives for the unit and end-to-end locators (the e2e drives it by keyboard rather than `fill()`), and its keyboard operation and value announcement come for free.

At adoption, verify the tree-shaken production bundle grows only by the components imported, the same kind of check Stage 4 ran to keep Ajv out of the bundle.

## Primitives

The primitives live in `frontend/src/components/ui/`, PascalCase with a `Ui` prefix, one component per file, scoped styles, typed props and emits via `defineProps` and `defineEmits` generics like the rest of the codebase. Every variant and state of every primitive appears on the styleguide route; that is the definition of done for a primitive.

- `UiButton`: replaces the global `button` styles, `button.secondary`, and `.button-link`. Renders a `button` or a `RouterLink` from a `to` prop. Variants primary, secondary, ghost, danger; sizes md and lg; disabled and loading states; visible focus.
- `UiBadge`: replaces `.badge`, `.badge-human`, and the replay list's pin marker (which currently uses an emoji; badges are always text-bearing so color is never the sole signal).
- `UiCard`: replaces `.card`, `.end-card`, and the `.start-form` surface; a surface with border, radius, and padding slots rather than a layout component.
- `UiField` with `UiInput`: replaces `.field` and `.hint`; wires the label, the input id, and `aria-describedby` for hint and error text so association is automatic.
- `UiDialog`: wraps Reka UI Dialog; the start form renders inside it as a feature component.
- `UiSlider`: wraps Reka UI Slider for the replay scrubber, keeping the `slider` role the end-to-end suite locates.
- `UiStatusBadge`: replaces `.status-dot` plus its adjacent text; the dot keeps its color, the label carries the meaning.
- `UiEmptyState`: replaces the ad hoc `.status` loading and empty paragraphs with one consistent presentation.

`RunMetadata`, `StartForm`, `AppShell`, and the other feature components stay in `components/` and are restyled on the primitives; they are not primitives themselves.

## The styleguide route

`/styleguide` renders the token swatches (color, spacing, type scale) and every primitive in every variant and state. It is the working surface for checkpoint two and the permanent home for design review afterward: a new variant is not done until it appears here.

The route is registered in `main.ts` only when `import.meta.env.DEV` is true, and the page component is loaded with a dynamic import, so production builds neither register the route nor carry the code. The build verification greps the production bundle for the styleguide chunk's absence.
