# Leaderboards

There are two leaderboards per environment per iteration: an automated board and a human-feedback board. They are kept separate and are never combined into a single number.

## Iteration: one competition

An iteration is one competition. For a single environment, the operator declares an iteration, accepts submissions for that iteration (see [submission.md](submission.md)), runs the automated workflow, and collects human feedback through the website. When the next competition starts, a new iteration begins, both boards reset, and the previous iteration remains viewable as a historical board.

The iteration concept is independent of GitHub Classroom. A class might run several iterations over a term, each tied to a class assignment. A workshop might run a single iteration. An open competition might run a series. In every case the unit is the same: one iteration is one competition with one pair of boards.

## Automated board

The automated board is produced by a workflow that the operator can trigger manually. The workflow:

- Runs a configured set of match configurations (environment, opponents, seeds).
- Supports controlled repetitions per configuration so a single lucky run does not dominate.
- Records every run so it can be replayed afterwards. See [recording.md](recording.md).
- Measures wall-clock time per decision and per episode as a proxy for computational intensity.
- Enforces per-step and per-episode timeouts so a slow or stuck agent cannot block the queue.
- Produces a weighted score that combines task performance with efficiency. The weights are configurable per environment and live next to the environment's public metadata (see [environment.md](environment.md)).

Automated runs always execute on Docker for reproducibility and sandboxing. See [execution.md](execution.md).

## Human-feedback board

The human-feedback board aggregates the ratings collected through the play and watch flows for that environment in that iteration. See [frontend.md](frontend.md) for where ratings are collected.
