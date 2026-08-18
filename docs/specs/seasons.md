# Seasons

A **season** is one competition for one environment. It may be a class assignment, a workshop, or a round of an open competition. A new season starts both [boards](leaderboard.md) from scratch. Previously released seasons remain available as history.

## Public gates

A season has three independent public gates:

- The **submission window** controls whether participants can submit.
- The **play window** controls whether signed-in users with `normal` or `admin` status can start public watch or play sessions and write ratings.
- The **release status** controls whether ordinary users can see the boards and history.

The gates may point to different seasons:

- The submit form targets the submission-open season.
- Watch, play, and feedback target the play-open season.
- The boards target the current released season.

```text
Season A: submissions closed | play open  | released
Season B: submissions open   | play closed | unreleased
```

For each environment, only one season may have submissions open and only one may have play open, which keeps each default target unambiguous. Releasing results is independent of both windows. Operators can preview unreleased boards and rerun a season before publishing replacement results.

## What a fresh deployment starts with

The backend seeds a new deployment with one **Playground** season per environment: submission-open and play-open so local play works immediately, unreleased so results stay operator-only, and unconfigured. An environment whose metadata declares presets also receives one hidden season per preset, in declaration order, each submission-closed, play-closed, and unreleased, labelled with the preset's title, configured exactly as the preset (parameter overrides, plus LLM enablement when the preset declares it), and described in language a student can read, since the description becomes public the moment a gate opens. The Playground season's own description names the arc's opening settings when a preset describes those defaults.

Seeding runs at every startup but is idempotent, and it stays out of an environment that has been configured at all: template seasons appear only while the environment's sole season is the Playground row the seed just ensured. Environments that declare no presets keep exactly their one Playground season.

## Per-season configuration

Each season defines:

- Match design: one controller entry per resolved seat, each set to `submission` or `builtin:<name>`, plus seeds and matches per configuration. Each builtin name must be declared by the environment, and a restricted seat must name its designated builtin.
- Template dependency version.
- Optional gameplay parameter overrides, including `players` for player-bounds environments or `seat_plan` for environments with declared plans. Every match's seat count must equal the number of seats in the resolved layout.
- Optional step and episode limit overrides.
- Optional messaging overrides.
- Optional overrides for the deployment's LLM model aliases, token prices, official limits, and student development limits. Limits set the weighted token budget and request rate per minute. See [LLM API](llm.md#budgets-and-limits).
- Optional season-wide rating prompt.
- An optional **Season description**: display-only Markdown metadata that operators may save, replace, or clear at any time. The [frontend](frontend.md) defines its format and visibility.
- An optional template repository URL. A season-specific URL is cloned from its default branch. When the URL is absent, the season uses the deployment's published template repository on the `templates/<environment>` branch.

Every override applies to the season's automated matches and live sessions alike. Gameplay parameters are additionally the middle parameter layer: players may tweak them for one live session, while automated matches use the season values exactly, or the run refuses to start. See [Environments](environment.md#configurable-gameplay-parameters) for the full layering and drift rules. Student development LLM limits use a separate meter for each season and neither consume nor contribute to official limits or telemetry. See [LLM API](llm.md#budgets-and-limits).

Operators manage seasons through the website's admin console and an operator-only HTTP API. They can declare, configure, describe, open, close, run, rerun, cancel, preview, and release seasons. They may also permanently delete a closed, unreleased season with no submissions, sessions, runs, ratings, prompts, or development keys. The admin console requires explicit confirmation. The API refuses deletion rather than removing related historical activity. The backend runs these workflows and streams logs to the console.

The template repository URL and Season description remain editable after runs or submissions exist. They are display and setup metadata, not part of the configuration captured by an official run.
