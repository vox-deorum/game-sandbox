# Stage 7.3: Multi-Seat Schedule Expansion

Status: done.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 3 and the direct continuation of [Stage 6.2](../stage-06/2-matchmaking-schedule.md). It makes the scheduler's already-implemented multi-submission-seat path live for Hearts and pins the full test matrix that Stage 6 deferred. It is a pure, deterministic function: no Docker, no DB, no I/O.

## Why this is its own seam

Stage 6 shipped `backend/src/scheduler/build-schedule.ts` with the general multi-seat expansion already coded (ordered permutations versus unordered combinations, selected by `seat_order_matters`), but it only exercised and tested the single-submission-seat path. Hearts is the first environment with `seat_order_matters=true` and more than one submission seat, so this is where that path goes live. Keeping it a pure step means the balancing rules can be tested exhaustively without containers, exactly as Stage 6.2 was, and the runner stays a straightforward sequential executor.

## What changes

The runner, storage, and seed round-robin from Stage 6 are unchanged. The scheduler still fills fixed built-in seats with `{ kind: 'builtin-naive' }`, expands seeds by run index (`seeds[i % seeds.length]`), and emits `games` runs per resolved assignment. Only the submission-seat expansion differs from the single-seat case, and that difference is the environment capability `seat_order_matters`, not a per-match toggle.

Given a match configuration with `K` submission seats and `N` trigger-time `ready` submissions:

- `seat_order_matters = true` (Hearts): enumerate the **ordered** `K`-permutations of the submissions, `P(N, K) = N! / (N - K)!` distinct seatings. Each distinct ordering is its own match, because seat position changes play.
- `seat_order_matters = false`: enumerate the **unordered** `K`-combinations, `C(N, K) = N! / (K! * (N - K)!)` distinct rosters. Each roster is seated in sorted-submission-id order so the concrete `slots` assignment is still fully determined.

Determinism carries over from Stage 6 unchanged: submissions are sorted by stable submission id before enumeration, and permutations or combinations are generated in fixed lexicographic order over that sorted list, so a re-run schedules the identical games. The Naive baseline still always runs: the scheduler also emits the match with every submission seat filled by `builtin-naive`, giving the board its comparable baseline row.

## Edge cases the tests pin

Alongside the Stage 6 cases:

- `N < K` (fewer ready submissions than submission seats) emits no submitted seatings, only the Naive baseline, so a thin season still dry-runs rather than erroring.
- `K` equal to the seat count with zero built-in seats is the all-submission Hearts board.
- A single submission seat (`K = 1`) reduces to exactly the Stage 6 behavior under both flag values, since `P(N, 1) = C(N, 1) = N`. This is the regression that proves the multi-seat expansion is a strict generalization of the single-seat path.

Worked example for the agreed Hearts shape: Hearts is fixed at four slots, so a match with two `submission` seats (`K = 2`) and two fixed `builtin-naive` seats, four ready submissions (`N = 4`), and two seeds yields `P(4, 2) = 12` ordered seatings times 2 seeds = 24 submitted games, plus the 2 baseline games, for 26 total. The same shape on a `seat_order_matters = false` environment yields `C(4, 2) = 6` times 2 = 12 submitted games plus 2 baseline, for 14 total.

## The same agent may fill multiple seats

A resolved `slots` assignment is not required to name a distinct agent per seat. The Naive baseline already places the same `builtin-naive` ref in every submission seat, so the four-seat Hearts baseline seats Naive in all four slots. The scheduler must therefore never dedupe or reject a repeated ref, and it supports a submission filling more than one seat for self-play and mirror matches. The downstream image build and harness (step 5) load an independent instance per seat, so the same agent can play several seats of one game.

The default competitive expansion still enumerates distinct `P(N, K)` or `C(N, K)` seatings for fair head-to-head coverage, so the worked counts above are unchanged. Self-play is an additional, explicitly configured shape rather than a side effect of the default rotation: a season that wants a submission to face copies of itself, or that wants a runnable submitted game when fewer submissions than seats are ready, configures it, and the scheduler resolves it to a `slots` assignment with the repeated ref.

## Tests

Vitest, pure unit tests, no Docker, no DB:

- A `seat_order_matters = true` environment expands `K = 2` submission seats into `P(N, K)` ordered seatings; a `false` one into `C(N, K)` rosters. Both are deterministic and identical across re-runs.
- The worked 26-game Hearts example and its 12-plus-2 unordered counterpart match exactly.
- `K = 1` reduces to the exact Stage 6 schedule under either flag.
- `N < K` yields baseline-only. The Naive baseline is always present.
- The same agent may fill multiple seats: the four-seat Hearts baseline seats `builtin-naive` in all four slots, and a self-play assignment that seats one submission in two seats is emitted without dedup or error.
- Calling `buildSchedule` twice with the same inputs yields an identical ordered schedule.

## Done when

`buildSchedule` expands a Hearts match design with multiple submission seats into `P(N, K)` ordered seatings for `seat_order_matters = true` and `C(N, K)` rosters for `false`, deterministically and identically across re-runs, with the Naive baseline always present and `N < K` yielding baseline-only. The `K = 1` case reproduces the Stage 6 schedule exactly under both flags. Resolved assignments may repeat an agent ref across seats, which the baseline already requires and self-play uses, and the scheduler never dedupes or rejects them. All cases are proven by pure Vitest unit tests with no Docker or DB.
