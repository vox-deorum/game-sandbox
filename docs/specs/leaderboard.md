# Leaderboards

There are two leaderboards per environment per season: an automated board and a human-feedback board. They are kept separate and are never combined into a single number. See [Seasons](seasons.md) for the season model and its public gates.

## Leaderboard views

A selected season's leaderboard header shows a compact **Settings** summary from the server-resolved settings returned with that season's boards. It uses the same default-to-season differences as the environment overview and My Submissions. The **All Seasons** section is a clean season index and does not repeat the selected season's settings.

## Automated board

The automated board ranks agents by mean episode score. A higher value is always better for ranking, even when the environment also displays a native score where lower is better. The board shows the population standard deviation of episode scores beside the mean.

A **match** is the scheduled unit and plays one episode. It contributes one episode score for each seat: the mean of the final scores of the players that seat covers. See [Environments](environment.md#players-and-seats).

Some environments score every player only at the end; Hearts, for example, settles its penalty on the final trick. In these environments, the reported match result supplies every player's final score. A player that did not act on the final tick is therefore scored on its true outcome instead of an outdated intermediate value.

Compute time, acted ticks, and LLM usage sum across a seat's players. A seat fails when any of its players fails.

| Event | Result |
| --- | --- |
| A player crashes, makes an illegal move, or exceeds its episode budget | Its seat forfeits. |
| The session container faults | Every seat forfeits. |
| An `act` call exceeds the step compute limit | The harness uses the environment's legal default action, records the overrun, charges the compute to that player's episode budget, and continues. The seat does not forfeit. |
| A `chat` or `learn` call overruns | The chosen action stands. See [Communication](communication.md#timing). |

Each environment registers a forfeit floor at or below every honest outcome. The floor is applied after the seat's player scores are reduced to one episode score, so a failed seat cannot keep an intermediate score.

Mean compute time per decision is shown separately and breaks only an exact score tie. It includes chargeable time in `act` and optional hooks. The [LLM API](llm.md#determinism-and-timing) defines how official LLM proxy time is counted. The mean is weighted by the number of ticks on which the agent acted across all matches and across every player its seats covered.

The displayed spread is the population standard deviation of each match's compute time per decision. It is weighted by that match's acted ticks so it describes the same distribution as the mean. Score and efficiency are never combined.

Creating an automated run freezes the season config, resolved gameplay parameters, resolved official LLM policy, eligible ready submissions, and concrete schedule from one transactionally consistent read. Before freezing, it validates every match against the environment's current resolved seats and builtin declarations. An empty resolved schedule, a stored parameter override that the current declarations reject, or a matchup that no longer fits the resolved layout creates no run. Each failure is reported to the operator with a typed reason. Every match in a run therefore uses the same frozen season-wide parameters and roster even if the operator edits the season or a participant resubmits afterward.

The operator-triggered workflow:

- Expands the match design over eligible submissions into a balanced schedule.
- Includes named builtins as ordinary agents and the required `naive` baseline on every board.
- Uses controlled seeded repetitions.
- Runs matches sequentially on the same host for comparable timing.
- Records every match.
- Enforces step and episode limits.
- Aggregates successful LLM usage by model, including authoritative weighted cost and estimated-call counts.

When a match design fills more than one seat with submissions, the schedule respects whether seat order changes the game. See [Environments](environment.md#seat-order). The schedule includes every distinct ordered seating when order matters and every distinct unordered group when it does not. Configured builtins stay in their declared seats throughout expansion. The `naive` builtin fills every `submission` seat in the appended baseline match, giving each board a comparable reference row without replacing another configured builtin.

The schedule expands over resolved seats, not players.

Each match runs in its own sandboxed session container. See [Execution](execution.md).

## Human-feedback board

The human-feedback board shows each agent's mean rating, population standard deviation, and rating count. An agent needs at least three ratings to be ranked, so a single early rating cannot rank it. If the agent's author has set a rating prompt, the board shows a shortened version beneath the agent's name and the full text on hover.

Ratings use a 1 to 5 scale. Two optional prompts may guide one rating:

- The operator's season prompt, applied to every agent.
- The author's prompt, applied only to that agent.

Users cannot rate their own submitted agents. A named builtin is rateable only in a session that also contains a submitted agent. Each builtin keeps a separate rating identity through its stable name. See [Frontend](frontend.md).
