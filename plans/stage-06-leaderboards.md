# Stage 6: Iterations and Leaderboards

Status: not started

## Goal

A full competition cycle works: the operator declares and configures an iteration from the CLI, participants submit, the operator triggers the automated workflow, both boards appear on the environment page, and the previous iteration remains viewable when the next one starts.

## Scope

Implement iteration configuration per [leaderboard.md](../specs/leaderboard.md): a configuration file declaring the match configurations (environment, slot plan or opponents, seeds, repetitions), the template dependency-set version every submission in the iteration is built and run against (defaulting to the latest template release at declaration, see [submission.md](../specs/submission.md)), and the optional overrides of time limits, messaging settings, and LLM budgets and allowlist. For the current Flappy Bird environment, a match configuration is usually one submitted agent in the single slot; opponent fields become meaningful for environments with multiple slots. The override fields for messaging and LLM are parsed and stored now so the format is stable, and take effect when the LLM gateway (Stage 9) and communication (Stage 8) land. Build the deployment CLI: declare an iteration, open and close submissions, trigger the workflow, and inspect status. There is no admin UI.

Implement the automated workflow: run the iteration's match configurations sequentially on the same host so timings are comparable, one container per match through the execution driver, using the Stage 5 submission images, seeds passed to both the environment and the agents, controlled repetitions per configuration, per-step and per-episode timeouts from the environment defaults or the iteration overrides, every run recorded, and wall-clock time per decision and per episode measured (the Stage 2 harness already produces the timing; the workflow aggregates it). In the single-agent stage, a failing or timed-out agent is reported as that agent's result. Once multi-agent match configurations arrive, the same rule applies per slot without aborting the whole iteration.

Compute and store the automated board: agents ranked by mean episode score, where the environment's leaderboard score is normalized so higher is better, with mean wall-clock time per decision as a separate column, never folded into one number. Leaderboard recordings are retained for as long as their iteration stays viewable, per [recording.md](../specs/recording.md).

Implement ratings per [frontend.md](../specs/frontend.md): after any session, watch or play, the user rates each involved agent 1 to 5; one effective rating per user per agent per iteration, overwritten on re-rating; ratings of the user's own agent excluded. The human-feedback board shows mean rating and count, ranking only agents with at least three ratings.

Surface it all on the frontend: both boards side by side on the environment page for the current iteration, links to historical iterations, leaderboard placements on agent profiles, and replays linked from board rows.

## Spec references

[leaderboard.md](../specs/leaderboard.md), [frontend.md](../specs/frontend.md) (feedback, boards on pages), [recording.md](../specs/recording.md) (leaderboard retention), [environment.md](../specs/environment.md) (defaults the iteration can override).

## Depends on

Stage 5 (submissions, images, iteration records), Stage 4 (pages, identity).

## Done when

The operator runs the CLI to declare an iteration with two seeded repetitions of a Flappy Bird match configuration, two test submissions land, the workflow produces a board where every run has a replay, and re-running with the same configuration reproduces the scores of deterministic agents. Ratings from three test users rank an agent on the human board only after the third rating arrives, and declaring the next iteration resets both boards while the old ones stay reachable.
