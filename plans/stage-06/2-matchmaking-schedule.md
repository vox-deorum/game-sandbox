# Stage 6.2: Matchmaking and Schedule Generation

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 2 and the **first demonstrable slice**. It is a pure, deterministic function. Given an iteration's match design and its live submission set, it produces the concrete list of matches the workflow will run. It has no I/O, no Docker, and no database. It takes plain inputs and returns a plain schedule, so it is fully unit-testable. This is where the "auto-generate balanced matchup schedules from opened slots" decision lives.

## Why this is its own seam

The runner (step 4) should not hold the rules for _which_ games to run. It should be handed a list and execute it. Splitting the schedule (pure logic) from the execution (Docker, timing) lets us test the balancing rules exhaustively without containers, and keeps the runner a straightforward sequential executor. It also keeps the model forward-compatible. Stage 7's multi-agent opponents change only the slot-composition expansion here, not the runner.

## Input

A `buildSchedule` function taking:

- The iteration's `IterationConfig.matches` (from step 1): each match configuration's `slots` (ordered seat specs, `builtin-naive` or `submission`), `seeds`, and `games` count.
- The trigger-time snapshot of the iteration's active `ready` submissions (`listActiveSubmissionsByIteration(iterationId, 'ready')` from Stage 5.1). These are the agents eligible to fill submission seats. The scheduler receives them as plain data, so the background runner never re-reads live submissions.
- A reference to the built-in Naive baseline as the shared Stage 6 `AgentRef` (`{ kind: 'builtin-naive' }`); it is not a submission row.

## Output

An ordered list of **scheduled games**. Each one carries the originating `match_index`, a deterministic `game_index`, a concrete `seed`, and a resolved `slots` assignment. That assignment names exactly what fills every seat as an `AgentRef` (a specific submission/user pair, or `builtin-naive`). This is exactly the shape step 1's `iteration_run_games.slots` stores and step 4 executes. The list order is the execution order (sequential, single host). It is deterministic for a given input, so a re-run schedules the same games.

## Balancing rules

The operator designs _match shapes_ (slot compositions plus a game count), not a hand-listed roster. The scheduler expands each shape over the live submissions. For the agreed model:

- **Single submission seat (the Flappy Bird case).** Consider a match with one `submission` seat, where the rest are `builtin-naive` (possibly none). For each active `ready` submission, fill the submission seat with that submission's `AgentRef`, fill every built-in seat with `{ kind: 'builtin-naive' }`, and emit `games` total runs for that resolved assignment. Seeds round-robin by run index: run `i` uses `seeds[i % seeds.length]`. With two seeds and `games: 2`, each resolved assignment runs twice, once per seed. With two seeds and `games: 5`, the seeds are `seed0, seed1, seed0, seed1, seed0`.
- **The Naive baseline always runs.** Besides filling empty seats, the scheduler emits the same match with the Naive baseline in the submission seat. This way the board always has a baseline row to compare against (the "Yes, always include Naive" decision). The baseline games use the same seeds and count as the submissions, so its column is comparable.
- **Multiple submission seats are deferred.** The `IterationConfig` format can store future multi-slot match shapes. But Stage 6's executable scheduler accepts at most one `submission` seat per match configuration. A match with more than one `submission` seat is rejected with `unsupported_multi_submission_seats`. When Hearts lands in Stage 7, that guard is replaced with a deterministic multi-seat rotation and its tests.

Determinism: no `Math.random()`. Submission refs are sorted by stable submission id before expansion. Baseline rows are emitted after the submitted rows for each match configuration. Seed-cycling is index-driven from the seed list. The same inputs always yield the same ordered schedule, which is what lets a re-run reproduce a deterministic agent's games exactly.

The function handles these edge cases explicitly, and tests pin each one. Zero ready submissions: the schedule is just the Naive baseline games, so an operator can dry-run an iteration before anyone submits. A match with no submission seat at all: pure baseline, emitted once for its `games` count. An empty `seeds` list: rejected by the config codec in step 1, but the scheduler also guards. `games` of zero or less: typed rejection. A match with zero slots: typed rejection, also rejected by the admin config validator. An empty overall match list: returns an empty schedule that the trigger refuses with `empty_schedule`, because an unconfigured iteration can be stored but cannot be run. More than one submission seat: typed rejection, not a partial schedule.

## Tests

Vitest, pure unit tests, no Docker, no DB:

- A single-submission-seat Flappy Bird match with two seeds, `games: 2`, and three ready submissions expands to two games per submitted agent plus two Naive baseline games, in deterministic order. Calling twice yields an identical schedule.
- The Naive baseline is always present, even with zero ready submissions, and the baseline games mirror the submissions' seeds and count.
- Increasing `games` scales the per-assignment run count by the documented rule. Changing the seed list changes the seeds assigned, deterministically, by `seeds[i % seeds.length]`.
- A two-`submission`-seat composition returns `unsupported_multi_submission_seats`, so Stage 6 cannot accidentally run an underspecified multi-agent board.
- Guard cases: zero submissions, no submission seat, `games: 0`, zero slots, empty seeds, an empty match list, and unsupported multi-seat compositions. Each produces the specified schedule or typed rejection. The empty match list case proves the scheduler stays pure while the trigger owns the `empty_schedule` refusal.

## Done when

`buildSchedule` takes Stage 6's one-submission-seat match design and a trigger-time ready-submission snapshot. It deterministically expands them into the ordered, fully-resolved game list that the runner executes and the storage stores. The expansion follows the exact game-count and seed semantics, and always includes the Naive baseline for runnable submission-seat designs. Unsupported multi-submission-seat designs, zero-slot matches, empty seeds, and non-positive game counts fail with typed errors for the admin API to surface. No Docker, DB, or route work is part of this slice. It is the pure input to step 3's trigger and step 4's runner.
