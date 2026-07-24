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

For each environment, only one season may have submissions open and only one may have play open. Releasing results is independent of both windows. Operators can preview unreleased boards and rerun a season before publishing replacement results.

Independent gates let an operator accept submissions for the next round while the previous round remains open for play. They also keep released history visible after public play closes. Allowing only one open submission or play window keeps each default target unambiguous.

## Per-season configuration

Each season defines:

- Match design: which seats use submissions, built-in agents, or opponents, plus seeds and games per configuration.
- Template dependency version.
- Optional gameplay parameter overrides. Every match's slot count must equal the resolved `seats` value.
- Optional step and episode limit overrides.
- Optional messaging overrides.
- Optional overrides for the deployment's default LLM model, token prices, official limits, and student development limits. Limits set the weighted token budget and request rate per minute. When an automated run is created, it freezes the full resolved official policy, including enabled aliases, upstream model mappings, prices, and limits for each slot.
- Optional season-wide rating prompt.
- An optional **Season description** in Markdown. This description is display metadata, not run configuration or workflow input. Operators may save, replace, or clear it at any time. It is public whenever submissions or play are open or results are released. Otherwise, it is private. Public cross-game Seasons cards show the description only when one exists. The description must be a normalized, trimmed inline paragraph of no more than 2,000 characters. Soft-wrapped lines are allowed, but blank-line-separated paragraphs are rejected. It supports emphasis, strong text, inline code, and absolute HTTP(S) links. Raw HTML, images, block Markdown, and other link destinations remain inactive.

A season's gameplay parameters, timing, messaging, and official LLM overrides apply to both its automated games and its live watch and play sessions. Players may tweak gameplay parameters for one live session, while automated games always use the season values. Student development LLM limits use a separate meter for each season and neither consume nor contribute to official limits or telemetry.

Creating an automated run freezes the season config, resolved gameplay parameters, resolved official LLM policy, eligible ready submissions, and concrete schedule from one transactionally consistent read. An empty resolved schedule creates no run. Every game in a run therefore uses the same frozen season-wide parameters and roster even if the operator edits the season or a participant resubmits afterward.

Operators manage seasons through the website's admin console and an operator-only HTTP API. They can declare, configure, describe, open, close, run, rerun, cancel, preview, and release seasons. They may also permanently delete a closed, unreleased season with no submissions, sessions, runs, ratings, prompts, descriptions, or development keys. The admin console requires explicit confirmation. The API refuses to delete related historical activity. The backend runs these workflows and streams logs to the console.

## Automated board

The automated board ranks agents by mean episode score. A higher value is always better for ranking, even when the environment also displays a native score where lower is better. The board shows the population standard deviation of episode scores beside the mean.

Each game contributes one episode score for each seat: that seat's final score for the game. Some environments score every seat only at the end. For example, Hearts settles its penalty on the final trick. In these environments, the reported game result supplies every seat's final score. A seat that did not act on the final tick is therefore scored on its true outcome instead of an outdated intermediate value.

A game is a forfeit for any seat that does not finish cleanly because its agent crashed, played an illegal move, or exceeded its budget. A fault in the whole container also causes a forfeit. The environment assigns a forfeiting seat its worst achievable score: a floor below every honest outcome. Failure can therefore never score better than honest play.

This floor is necessary for games scored at the end. Without it, a seat that aborted an unfinished Hearts hand could keep its intermediate score near zero, which is the best possible result. Hearts sets the forfeit floor at the maximum penalty for one hand. In Spades, where a seat is ranked by its partnership's score, the floor is below every honest team outcome. A score that only increases, such as Flappy Bird's, has a floor of zero. Each environment registers its own floor.

Mean compute time per decision is shown separately and breaks only an exact score tie. It includes chargeable time in `act` and optional hooks. The [LLM API](llm.md#determinism-and-timing) defines how official LLM proxy time is counted. The mean is weighted by the number of ticks on which the agent acted across all games.

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

Each match runs in its own sandboxed session container. See [Execution](execution.md).

## Human-feedback board

The human-feedback board shows each agent's mean rating, population standard deviation, and rating count. An agent needs at least three ratings to be ranked. If the agent's author has set a rating prompt, the board shows a shortened version beneath the agent's name and the full text on hover.

Ratings use a 1 to 5 scale. Two optional prompts may guide one rating:

- The operator's season prompt, applied to every agent.
- The author's prompt, applied only to that agent.

Users cannot rate their own submitted agents. The built-in baseline is rateable only in a session that also contains a submitted agent. See [Frontend](frontend.md).
