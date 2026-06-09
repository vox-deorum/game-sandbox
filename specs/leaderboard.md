# Leaderboards

There are two leaderboards per environment per iteration: an automated board and a human-feedback board. They are kept separate and are never combined into a single number.

## Iteration: one competition

An iteration is one competition. For a single environment, the operator declares an iteration, accepts submissions for that iteration (see [submission.md](submission.md)), runs the automated workflow, and collects human feedback through the website. When the next competition starts, a new iteration begins, both boards reset, and the previous iteration remains viewable as a historical board. An iteration can map to a class assignment, a workshop, or a round of an open competition; the unit is always the same (see [overview.md](overview.md)).

## Per-iteration configuration

Each iteration carries its own configuration, set by the operator when the iteration is declared:

- The set of match configurations the automated workflow will run (environment, opponents, seeds, repetitions).
- Optional overrides of the environment's default per-step and per-episode time limits. If the iteration does not override, the environment's defaults (see [environment.md](environment.md)) are used.

Iterations are declared, configured, and their workflow triggered through a configuration file and CLI on the deployment. There is no admin UI.

## Automated board

The automated board ranks agents by mean episode score across the iteration's runs, and shows mean wall-clock time per decision as a separate column. Performance orders the board; efficiency stands next to it for everyone to see. The two are never folded into one number.

The board is produced by a workflow that the operator triggers manually for the current iteration. The workflow:

- Runs the iteration's configured match configurations.
- Supports controlled repetitions per configuration, with seeds passed to both the environment and the agents (see [environment.md](environment.md) and [submission.md](submission.md)), so a single lucky run does not dominate.
- Records every run so it can be replayed afterwards. See [recording.md](recording.md).
- Measures wall-clock time per decision and per episode as a proxy for computational intensity. Time an agent spends in its optional `learn` hook counts too.
- Enforces per-step and per-episode timeouts so a slow or stuck agent cannot block the queue. The timeouts come from the environment defaults unless the iteration overrides them.

Matches for an iteration run sequentially on the same host, so timing measurements are comparable between agents. At class scale this costs little and removes the noise that concurrent runs would add.

Automated runs always execute on Docker for reproducibility and sandboxing. See [execution.md](execution.md).

## Human-feedback board

The human-feedback board aggregates the ratings collected through the play and watch flows for that environment in that iteration. It shows each agent's mean rating along with the number of ratings, and an agent needs at least three ratings to be ranked. See [frontend.md](frontend.md) for how ratings are collected and the rules they follow.
