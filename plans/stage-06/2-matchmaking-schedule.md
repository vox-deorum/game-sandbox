# Stage 6.2: Matchmaking and Schedule Generation

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 2 and the **first demonstrable slice**: a pure, deterministic function that turns an iteration's match design plus its live submission set into the concrete list of matches the workflow will run. It has no I/O, no Docker, and no database — it takes plain inputs and returns a plain schedule — so it is fully unit-testable and is where the "auto-generate balanced matchup schedules from opened slots" decision lives.

## Why this is its own seam

The runner (step 4) should not contain the rules for _which_ games to run; it should be handed a list and execute it. Separating the schedule (pure logic) from the execution (Docker, timing) means the balancing rules are tested exhaustively without containers, and the runner stays a straightforward sequential executor. It also keeps the model forward-compatible: Stage 7's multi-agent opponents change only the slot-composition expansion here, not the runner.

## Input

A `buildSchedule` function taking:

- The iteration's `IterationConfig.matches` (from step 1): each match configuration's `slots` (ordered seat specs, `builtin-naive` or `submission`), `seeds`, and `games` count.
- The iteration's active `ready` submissions (`listActiveSubmissionsByIteration(iterationId, 'ready')` from Stage 5.1) — the agents eligible to fill submission seats.
- A reference to the built-in Naive baseline (a stable pseudo-agent ref the rest of the system already knows from the watch picker; it is not a submission row).

## Output

An ordered list of **scheduled games**, each: the originating `match_index`, a concrete `seed`, and a resolved `slots` assignment naming exactly what fills every seat (a specific submission id, or `builtin-naive`). This is exactly the shape step 1's `iteration_run_games.slots` stores and step 4 executes. The list order is the execution order (sequential, single host), and it is deterministic for a given input so a re-run schedules the same games.

## Balancing rules

The operator designs _match shapes_ (slot compositions + game count), not a hand-listed roster; the scheduler expands each shape over the live submissions. For the agreed model:

- **Single submission seat (the Flappy Bird and common case).** A match with one `submission` seat (the rest `builtin-naive`, possibly none) expands to: for **each** active `ready` submission, fill the submission seat with it, fill the other seats with the Naive baseline, and emit `games` runs across the configured `seeds` (seeds cycled/repeated to reach the count, so `games` and `seeds.length` compose predictably — document the exact rule: `games` is runs _per submission per seed_, or total-per-submission with seeds round-robined; pick total-per-submission round-robining seeds and state it, so two seeds with `games: 2` means two runs, one per seed). Flappy Bird's lone slot degenerates to "each ready submission × its seeds, `games` each."
- **The Naive baseline always runs.** In addition to filling empty seats, the scheduler emits the same match with the Naive baseline occupying the submission seat, so the board always has a baseline row to compare against (the "Yes, always include Naive" decision). The baseline games use the same seeds and count as the submissions, so its column is comparable.
- **Multiple submission seats (forward-compatible, Stage 7).** A composition with more than one `submission` seat rotates the active submissions through those seats so that, across the generated games, each submission appears a balanced number of times in each seat position (seat position can matter — turn order in Hearts). The first cut may be a round-robin / Latin-square rotation; this stage does not exercise it (Flappy Bird is single-slot), but the function is written and unit-tested for it now so Stage 7 inherits a tested scheduler rather than retrofitting one. Document that the multi-seat balancing is a placeholder rotation refined when Hearts lands.

Determinism: no `Math.random()`. Any rotation/seed-cycling is index-driven from the sorted submission list and the seed list, so the same inputs always yield the same ordered schedule — which is what makes a re-run reproduce a deterministic agent's games exactly.

Edge cases the function handles explicitly (and tests pin): zero ready submissions (schedule is just the Naive baseline games, so an operator can dry-run an iteration before anyone submits); a match with no submission seat at all (pure baseline); an empty `seeds` list (rejected by the config codec in step 1, but the scheduler also guards); and `games` of zero (that match contributes nothing).

## Tests

Vitest, pure unit tests, no Docker, no DB:

- A single-submission-seat Flappy Bird match with two seeds and `games: 2`, three ready submissions, expands to the expected per-submission games plus the Naive baseline games, in deterministic order; calling twice yields an identical schedule.
- The Naive baseline is always present even with zero ready submissions, and the baseline games mirror the submissions' seeds/count.
- Increasing `games` scales the per-submission run count by the documented rule; changing seed list changes seeds assigned, deterministically.
- A two-`submission`-seat composition rotates a set of submissions through both seats with balanced seat-position counts across the schedule (the Stage 7-facing case), proven on a small fixture.
- Guard cases: zero submissions, no submission seat, `games: 0` each produce the specified schedule with no throw.

## Done when

`buildSchedule` deterministically expands an iteration's match design into the ordered, fully-resolved game list the runner executes and the storage stores, with the Naive baseline always included and the balancing rules unit-proven for both the single-seat case this stage uses and the multi-seat case Stage 7 will. No Docker, DB, or route work is part of this slice; it is the pure input to step 4. </content>
