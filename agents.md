# Agents Guide

This file is for AI coding agents working on the Game Sandbox repository. It captures the writing style we want and gives a quick orientation to the project. Humans are welcome to read it too.

## About this repo

Game Sandbox is a classwise playground for Game AI. Participants submit agents through GitHub, and everyone can watch those agents, play with or against them, rate them, and see them ranked on per-environment leaderboards. The system is built on PettingZoo, with Shimmy wrapping single-agent games so the rest of the codebase only sees a PettingZoo interface. Web users authenticate with GitHub OAuth, submissions are repo links pinned to a commit and tagged with a season, and there are two leaderboards per environment per season (automated and human feedback). Unity ML-Agents support is planned for later but not in scope today.

The full specification lives under [docs/specs/](docs/specs/README.md). Read it before changing anything substantive. The implementation plan lives under [plans/](plans/README.md); implementation work must stay connected to it, so when code diverges from a stage file, revise the stage file in the same change set (see the plan README for the rules).

Public documentation under `docs/` also follows [docs/AGENTS.md](docs/AGENTS.md), including its audience, linking, and beginner-accessibility conventions.

## Writing style

When you write documentation, specs, responses, or any prose in this repo, follow these rules:

- Write naturally, the way a thoughtful human would write a spec. No marketing voice.
- State assumptions, prerequisites, and specialized terms instead of relying on context that only an existing maintainer would know. When revising prose, preserve constraints, exceptions, and rationale that a new reader still needs.
- Do not use em-dashes. Use commas, periods, parentheses, or rewording instead.
- Specs describe what the system is. They do not include implementation details, build plans, or code scaffolding unless the task explicitly asks for those.
- Organize clearly with sections and short paragraphs. Avoid bullet soup, which is a wall of single-sentence bullets that could have been a paragraph.
- Do not hard-wrap prose to a fixed column. Write one line per paragraph and let the editor soft-wrap it. This applies to every Markdown file in the repo, docs and READMEs included, not just specs and plans. Markdown reflows when rendered, so a column limit only adds noisy diffs and tempts link workarounds. The exceptions that may exceed any width are things that cannot be wrapped: URLs, link reference definitions, and table rows.
- No emoji.
- Code comments should exist by default, either written with the code or added during review. They should explain intent, invariants, or non-obvious behavior. Keep them succinct, and do not add comments that only restate what the next line of code already says.

## Working on this repo

A few defaults that will save back-and-forth:

- Read the relevant files under [docs/specs/](docs/specs/README.md) before proposing changes that touch the design. Start with [docs/specs/overview.md](docs/specs/overview.md).
- Ask before expanding scope. If a request implies new features beyond what is in the spec, raise it rather than quietly adding them.
- Prefer editing existing files over creating new ones.
- Keep specification documents under [docs/specs/](docs/specs/README.md). Each file should have a single clear topic and cross-link to the others rather than duplicating content.

### UI consistency

The frontend has a design system; new UI joins it rather than reinventing CSS. Before any visual work, read [docs/contributors/design.md](docs/contributors/design.md), then:

- Use the semantic tokens. No raw color or spacing literals live outside `frontend/src/styles/tokens.css` (renderer modules are the only exemption, since a renderer owns its game's visual identity).
- Build UI from the `frontend/src/components/ui/` primitives (`UiButton`, `UiCard`, `UiField`, `UiDialog`, …) instead of new ad hoc markup and CSS. Reach for a third-party UI library only where focus and ARIA are genuinely hard (the project uses Reka UI for the dialog and slider, nothing more).
- Put every new primitive variant on the dev-only `/styleguide` route; a variant that is not shown there does not exist.
- Confirm with the owner before inventing a new visual pattern or settling an open design question. Design decisions are the owner's to make.
- Whenever you author a UI change, update the UI tests in the same change set. A renamed label, moved control, restructured markup, or altered flow means the jsdom unit tests (`frontend/test/`) and the Playwright journeys (`frontend/e2e/`) that assert on it must be revised to match, not left to rot. Treat a UI change with no corresponding test change as incomplete, and add coverage when the change introduces behavior no test exercises yet.
- After completing a piece of UI work, run the browser end-to-end suite with `uv run python scripts/ci.py frontend-e2e` (it needs a running Docker daemon). The default `check` and `test` loop only lints, typechecks, and runs the jsdom unit tests, none of which exercise the live DOM or its locators, so a renamed class or restructured markup can pass everything local and still break the Playwright journeys that CI runs. The e2e suite is the only thing that catches that before CI does.
