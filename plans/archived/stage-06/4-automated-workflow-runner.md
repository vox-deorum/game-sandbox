# Stage 6.4: Automated Workflow Runner

Status: done. Parallel match execution, resource limits, and shared image cleanup are implemented and verified.

Part of [Stage 6](../stage-06-leaderboards.md). The backend executes each persisted schedule through the execution driver, records match outcomes, and publishes progress. The [leaderboard specification](../../../docs/specs/leaderboard.md) defines scoring and the [execution specification](../../../docs/specs/execution.md) defines container isolation.

## Schedule and capacity

The admin route freezes the season configuration, resolved parameters, official LLM policy, eligible submissions, and concrete schedule before enqueueing a run. The runner validates the frozen layout and assignments before launching anything. It never rebuilds the schedule or rereads the active submission roster.

Season runs execute one at a time. Within a run, a worker pool claims matches in schedule order and allows them to finish in any order. Each slot covers image preparation, container execution, result persistence, and final cleanup.

At run start, `ExecutionDriver.getHostResources()` reads Docker's CPU count and total RAM, including Docker Desktop's VM capacity. `LEADERBOARD_CONCURRENCY` is an optional positive integer; unset or empty means half of Docker's CPUs rounded down, with a minimum of one. The memory ceiling always overrides that count:

```text
match_memory = base_memory + memory_per_extra_player * (player_count - 1)
memory_limit = floor((Docker_total_RAM / 2) / match_memory)
requested = configured_count or max(1, floor(Docker_CPUs / 2))
concurrency = min(requested, memory_limit, scheduled_match_count)
```

The quota comes from the shared sandbox resource calculation and the frozen layout's player count, converted to bytes. Invalid or unavailable host capacity, a nonpositive quota, or insufficient memory for one match fails the run before launching containers. The error identifies the required quota and budget when those are known. Combined match sandbox quotas reserve at most half of Docker's RAM; the remaining half covers backend, build, relay, and other activity. This is a fixed budget, not a free-memory monitor. Parallel matches can contend for CPU; a count of one restores sequential execution subject to the memory ceiling.

## Match execution and results

Each match uses the shared launch configuration with `headless: true`, its frozen seed and rules, and one isolated recording directory. The backend drains stdout and diagnostic streams while the harness plays the episode. The complete result envelope supplies final player scores; recorded states supply compute timing. Player results reduce to seats, with forfeits and normalization following the specification. LLM usage remains scoped to the run and filtered by game and player.

An attributable crash or timeout records the appropriate forfeits. An infrastructure fault marks the match failed without invented result rows. These expected match failures do not abort the remaining schedule. Recording associations protect active run recordings from retention, and completion recomputes placements only for a completed run.

Identical submitted seatings share composed images. The Docker driver shares builds, counts acquisitions, and removes an image only after its last release. Eviction cannot remove active images or their build intermediates. Every abandoned launch releases its acquisition, including an image helper whose source-tree cleanup prevents returning an acquired image.

## Cancellation and terminal states

The runner tracks processes and official LLM leases by game. Cancellation and shutdown stop admission, revoke every active lease, stop every active container, and wait for all workers. Matches check the stop signal after delayed image preparation, grant issuance, and launch. Already finished matches retain their outcomes; unfinished matches become cancelled.

An unexpected worker exception marks its game failed, stops admission, cancels the remaining unfinished games, and fails the run after all workers settle. Cleanup attempts every required operation even when another fails. No terminal event, placement update, or retention completion hook runs while workers still own resources. Queued runs stay serial, and a cancelled or failed run never replaces the latest completed board.

## Verification

- Configuration tests cover automatic, explicit, and invalid match counts.
- Fake-driver tests cover CPU rounding, player-scaled memory ceilings, no-fit and unavailable capacity, bounded overlap, out-of-order attribution, serial runs, ordinary match failures, cancellation, delayed launches, shutdown, fatal errors, and cleanup failures.
- Driver and image-helper tests cover shared builds, acquisition and release races, eviction protection, failed-build retry, and source-tree disposal failures.
- Docker integration tests compare deterministic scores between sequential and parallel runs and execute repeated composed matchups with replayable recordings.
- Backend checks, unit tests, Docker integration coverage, and the strict documentation build pass before completion.
