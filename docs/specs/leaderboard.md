# Leaderboards

There are two leaderboards per environment per season: an automated board and a human-feedback board. They are kept separate and are never combined into a single number.

## Seasons

A **season** is one competition for one environment. It may represent a class assignment, workshop, or round of an open competition. A new season resets both boards while previous released seasons remain available as history.

A season has three independent public gates:

- The **submission window** controls whether participants can submit.
- The **play window** controls whether signed-in, allowlisted users can start public watch or play sessions and write ratings.
- The **release status** controls whether ordinary users can see the boards and history.

The gates may point to different seasons:

- The submit form targets the submission-open season.
- Watch, play, and feedback target the play-open season.
- The boards target the current released season.

```text
Season A: submissions closed | play open  | released
Season B: submissions open   | play closed | unreleased
```

Only one season per environment may have submissions open, and only one may have play open. Releasing results is independent. Operators can preview unreleased boards and rerun a season before publishing the replacement results.

Keeping the gates independent lets an operator accept the next round's submissions while the previous round remains open for play, or keep released history visible after public play closes. The one-open rule keeps each default submit and play target unambiguous.

## Per-season configuration

Each season defines:

- Match design: which seats use submissions, built-in agents, or opponents, plus seeds and games per configuration.
- Template dependency version.
- Optional step and episode limit overrides.
- Optional messaging overrides.
- Optional LLM model and budget overrides.
- Optional season-wide rating prompt.

Operators manage seasons through the website's admin console and an operator-only HTTP API. They can declare, configure, open, close, run, rerun, cancel, preview, and release seasons. The backend runs the workflow and streams logs to the console.

## Automated board

The automated board ranks by mean episode score. Higher is always better for ranking, even when the environment also exposes a native lower-is-better display score. The board shows the population standard deviation of episode scores beside the mean.

Mean compute time per decision is shown separately and breaks only an exact score tie. It includes `act`, optional hooks, and time waiting for LLM calls. The mean is weighted by acted ticks across games. The spread shown beside it is the population standard deviation of each game's per-decision compute rate, weighted by that game's acted ticks so it describes the same distribution as the mean. Score and efficiency are never combined.

The operator-triggered workflow:

- Expands the match design over eligible submissions into a balanced schedule.
- Includes the built-in baseline on every board.
- Uses controlled seeded repetitions.
- Runs matches sequentially on the same host for comparable timing.
- Records every match.
- Enforces step and episode limits.
- Aggregates LLM usage by model.

Each match runs in its own sandboxed session container. See [Execution](execution.md).

## Human-feedback board

The human-feedback board shows each agent's mean rating, the population standard deviation of its ratings, and its rating count. An agent needs at least three ratings to be ranked. When an agent's author has set a rating prompt, it is shown beneath the agent's name on the board (truncated, with the full text on hover).

Ratings use a 1 to 5 scale. Two optional prompts may guide one rating:

- The operator's season prompt, applied to every agent.
- The author's prompt, applied only to that agent.

Users cannot rate their own submitted agents. The built-in baseline is rateable only in a session that also contains a submitted agent. See [Frontend](frontend.md).
