# Leaderboards

There are two leaderboards per environment per season: an automated board and a human-feedback board. They are kept separate and are never combined into a single number.

## Seasons

A **season** is one competition for one environment. It may be a class assignment, workshop, or round of an open competition. A new season starts both boards from scratch. Previously released seasons remain available as history.

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

## Per-season configuration

Each season defines:

- Match design: which seats use submissions, built-in agents, or opponents, plus seeds and games per configuration.
- Template dependency version.
- Optional gameplay parameter overrides, including `players` for player-bounds environments or `seat_plan` for environments with declared plans. Every match's seat count must equal the number of seats in the resolved layout.
- Optional step and episode limit overrides.
- Optional messaging overrides.
- Optional overrides for the deployment's LLM model aliases, token prices, official limits, and student development limits. Limits set the weighted token budget and request rate per minute. See [LLM API](llm.md#budgets-and-limits).
- Optional season-wide rating prompt.
- An optional **Season description**: display-only Markdown metadata that operators may save, replace, or clear at any time. The [frontend](frontend.md) defines its format and visibility.

A season's gameplay parameters, step and episode compute limits, messaging, and official LLM overrides apply to both its automated games and its live watch and play sessions. Players may tweak gameplay parameters for one live session, while automated games always use the season values. Student development LLM limits use a separate meter for each season and neither consume nor contribute to official limits or telemetry.

Creating an automated run freezes the season config, resolved gameplay parameters, resolved official LLM policy, eligible ready submissions, and concrete schedule from one transactionally consistent read. An empty resolved schedule creates no run, and neither does a stored parameter override that the environment's current declarations reject; both are reported to the operator with a typed reason. Every game in a run therefore uses the same frozen season-wide parameters and roster even if the operator edits the season or a participant resubmits afterward.

Operators manage seasons through the website's admin console and an operator-only HTTP API. They can declare, configure, describe, open, close, run, rerun, cancel, preview, and release seasons. They may also permanently delete a closed, unreleased season with no submissions, sessions, runs, ratings, prompts, descriptions, or development keys. The admin console requires explicit confirmation. The API refuses to delete related historical activity. The backend runs these workflows and streams logs to the console.

## Automated board

The automated board ranks agents by mean episode score. A higher value is always better for ranking, even when the environment also displays a native score where lower is better. The board shows the population standard deviation of episode scores beside the mean.

Each game contributes one episode score for each seat: the mean of the final scores of the players it covers. See [Environments](environment.md#players-and-seats).

Some environments score every player only at the end. For example, Hearts settles its penalty on the final trick. In these environments, the reported game result supplies every player's final score. A player that did not act on the final tick is therefore scored on its true outcome instead of an outdated intermediate value.

Compute time, acted ticks, and LLM usage sum across a seat's players. A seat fails when any of its players fails.

| Event | Result |
| --- | --- |
| A player crashes, makes an illegal move, or exceeds its episode budget | Its seat forfeits. |
| The session container faults | Every seat forfeits. |
| An `act` call exceeds `step_limit_ms` | The harness uses the environment's legal default action, records the overrun, charges the compute to that player's episode budget, and continues. The seat does not forfeit. |
| A `chat` or `learn` call overruns | The chosen action stands. See [Communication](communication.md#timing). |

Each environment registers a forfeit floor at or below every honest outcome. The floor is applied after the seat's player scores are reduced, so failure cannot retain an intermediate score.

Mean compute time per decision is shown separately and breaks only an exact score tie. It includes chargeable time in `act` and optional hooks. The [LLM API](llm.md#determinism-and-timing) defines how official LLM proxy time is counted. The mean is weighted by the number of ticks on which the agent acted across all games and across every player its seats covered.

The displayed spread is the population standard deviation of each game's compute time per decision. It is weighted by that game's acted ticks so it describes the same distribution as the mean. Score and efficiency are never combined.

The operator-triggered workflow:

- Expands the match design over eligible submissions into a balanced schedule.
- Includes the built-in baseline on every board.
- Uses controlled seeded repetitions.
- Runs matches sequentially on the same host for comparable timing.
- Records every match.
- Enforces step and episode limits.
- Aggregates successful LLM usage by model, including authoritative weighted cost and estimated-call counts.

When a match design fills more than one seat with submissions, the schedule respects whether seat order changes the game. See [Environments](environment.md). It includes every distinct ordered seating when order matters and every distinct unordered group when it does not. The built-in baseline still fills every submission seat, giving each board a comparable reference row.

The schedule expands over resolved seats, not players. A season run always freezes its schedule from a fresh transactionally consistent read.

Each match runs in its own sandboxed session container. See [Execution](execution.md).

## Human-feedback board

The human-feedback board shows each agent's mean rating, population standard deviation, and rating count. An agent needs at least three ratings to be ranked. If the agent's author has set a rating prompt, the board shows a shortened version beneath the agent's name and the full text on hover.

Ratings use a 1 to 5 scale. Two optional prompts may guide one rating:

- The operator's season prompt, applied to every agent.
- The author's prompt, applied only to that agent.

Users cannot rate their own submitted agents. The built-in baseline is rateable only in a session that also contains a submitted agent. See [Frontend](frontend.md).
