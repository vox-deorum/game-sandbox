# Leaderboards

There are two leaderboards per environment per season: an automated board and a human-feedback board. They are kept separate and are never combined into a single number.

## Season: one competition

A season is one competition. For a single environment, the operator declares a season, accepts submissions for that season (see [submission.md](submission.md)), runs the automated workflow, and collects human feedback through the website. When the next competition starts, a new season begins, both boards reset, and the previous season remains viewable as a historical board. A season can map to a class assignment, a workshop, or a round of an open competition; the unit is always the same (see [overview.md](overview.md)).

A season has three independent public gates. A **submission window** (open or closed) controls whether participants can submit to that season. A **play window** (open or closed) controls whether ordinary signed-in, allowlisted users can start public watch or play sessions for that season and write or update ratings for it. A **release status** (released or unreleased) controls whether the season's results, its boards and history, are shown to ordinary users. Operators can list unreleased seasons and preview their boards through operator-gated reads on the Leaderboards page and in the admin console. The three gates are independent, and an ordinary user can see a season whenever any one of them is in effect: an open submission window, an open play window, or released results each make the season visible.

Those gates intentionally answer different questions. An operator can open submissions for an unreleased season so participants can submit without exposing its boards. The operator can also keep a released season viewable as history after closing its play window, which leaves its boards readable but stops new public sessions and rating writes for that season. The operator can even open the play window on a season whose results are still unreleased, so users can watch and play it while its boards stay hidden until release. The public environment page may therefore point at different seasons at once: the open submission season for the submit form, the play-open season for watch, play, and feedback, and the current released season for the boards. If no season is play-open, public watch and play controls are disabled while released history remains readable.

Only one season per environment may have an open submission window at a time, and only one season per environment may have an open play window at a time. This keeps the default public submit target and the default public play target unambiguous, while still allowing the operator to accept the next round's submissions after closing the previous round's submission window. The operator can re-run the workflow on a season, which recomputes its boards in place; releasing results and play-window changes are separate, explicit steps, so a re-run can be verified before it affects what the public can see or play.

## Per-season configuration

Each season carries its own configuration, set by the operator when the season is declared:

- The match design the automated workflow will run: each match configuration's slot composition (which seats are built-in baseline agents and which are submissions, plus opponents for multi-slot environments), its seeds, and a per-configuration game count. The workflow expands this design over the season's submissions into a balanced run schedule (see the automated board below).
- The template dependency-set version every submission in the season is built and run against. It defaults to the latest template release when the season is declared (see [submission.md](submission.md)).
- Optional overrides of the environment's default per-step and per-episode time limits. If the season does not override, the environment's defaults (see [environment.md](environment.md)) are used.
- Optional overrides of the environment's messaging settings: the message length cap, or disabling messaging for the season (see [communication.md](communication.md)).
- Optional overrides of the LLM model allowlist and the token, call, and rate budgets (see [llm.md](llm.md)).
- An optional **rating prompt** for the season: a short question or rubric the operator wants every human rater to consider when rating any agent in this season (for example, "Rate how human-like this agent felt"). It guides the human-feedback rating and is shown at rating time alongside any prompt the agent's own author set (see the human-feedback board below and [frontend.md](frontend.md)).

Seasons are declared, configured, opened and closed for submissions, opened and closed for public play, run, re-run, and released through an **operator admin console** on the website, backed by an operator-only admin HTTP API. The backend runs the workflow (it already holds the execution driver that launches the match containers), so the console can trigger runs and stream their container logs live. Operator access is gated by an operator allowlist in the deployment configuration, checked against the same GitHub identity used everywhere else (a mock operator identity in local development until OAuth lands). The admin HTTP API is the stable contract, so the same operations are scriptable for headless deployments without a separate configuration-file format.

## Automated board

The automated board ranks agents by mean episode score across the season's runs, and shows mean wall-clock agent compute time per decision as a separate column. That compute figure is a per-decision proxy that includes the agent's optional `learn` and `chat` hooks and any time spent waiting on LLM calls, not just the bare action call (see the timing measurement below). Episode score is the environment's leaderboard score, normalized so higher is better. If an environment has a native lower-is-better display score, such as penalty points, it reports a transformed leaderboard score while still exposing the native display score in the per-step state. Performance orders the board; efficiency stands next to it for everyone to see, and breaks an exact score tie so that two agents with the identical mean score rank by the faster one. The two are never folded into one combined number: score is the sole ranking quantity, and compute only decides an otherwise exact tie.

The board is produced by a workflow that the operator triggers manually for the current season. The workflow:

- Runs the season's configured match configurations, expanded over the season's submissions into a balanced schedule. The environment's built-in baseline agent is always included as a row, so every board has a fixed point of comparison.
- Supports controlled repetitions per configuration, with seeds passed to both the environment and the agents (see [environment.md](environment.md) and [submission.md](submission.md)), so a single lucky run does not dominate.
- Records every run so it can be replayed afterwards. See [recording.md](recording.md).
- Measures wall-clock time per decision and per episode as a proxy for computational intensity. Time an agent spends in its optional `learn` and `chat` hooks counts too, as does time spent waiting on LLM calls.
- Aggregates LLM telemetry per agent, so the board shows input, reasoning, and output token usage broken down by model next to the timing column (see [llm.md](llm.md)). LLM-backed agents are stochastic even under fixed seeds; the same controlled repetitions absorb that.
- Enforces per-step and per-episode timeouts so a slow or stuck agent cannot block the queue. The timeouts come from the environment defaults unless the season overrides them.

Matches for a season run sequentially on the same host, so timing measurements are comparable between agents. At class scale this costs little and removes the noise that concurrent runs would add.

Each match runs in its own Docker container holding the harness, the environment, and the agents, for reproducibility and sandboxing. See [execution.md](execution.md).

## Human-feedback board

The human-feedback board aggregates the ratings collected through the play and watch flows for that environment in that season. It shows each agent's mean rating along with the number of ratings, and an agent needs at least three ratings to be ranked. See [frontend.md](frontend.md) for how ratings are collected and the rules they follow.

Two optional **rating prompts** guide what the human is rating: one set by the operator on the season (applies to every agent), and one set by an agent's own author for their submission (applies only to that agent). Both are shown to the rater at rating time when present. The prompts are guidance for the single 1-to-5 rating, not separate scores. The built-in baseline agent has no author, so only the season prompt applies when it is rateable in a session that also contains a submitted agent. Pure baseline-only watch recordings do not collect feedback.
