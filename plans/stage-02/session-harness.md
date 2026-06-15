# Stage 2: The Session Harness

Part of [Stage 2](../stage-02-harness-and-first-environment.md). This file designs the single session loop from [interaction.md](../specs/interaction.md): seeded, slot-sequential, deadline-aware, recording through the Stage 1 store, with one loop for realtime and turn-based alike. Stage 3 drives the same programmatic API from inside the container; the local CLI exists for development.

## New harness modules

```
harness/src/game_sandbox_harness/
  agent.py        AgentBase, hook detection (see agent-interface-and-manifest.md)
  manifest.py     manifest parsing and agent loading (same file)
  environment.py  EnvironmentMeta, EnvironmentEntry, entry-point discovery
                  (see environments-and-metadata.md)
  clock.py        Clock protocol, SystemClock, ManualClock
  session.py      slot bindings, ActionSource, run_episode, EpisodeResult
  cli.py          python -m game_sandbox_harness.cli
```

## The injectable clock

`Clock` is a protocol with a single member, `now_ms() -> int` (epoch milliseconds UTC); every duration in the system is a difference of two readings. `SystemClock` reads `time.time()`. `ManualClock` starts at a fixed instant and advances only when told to (`advance(ms)`), which makes recordings a pure function of seed plus agent behavior: `started_at`, `duration_ms`, `decision_ms`, and the header's `created_at` all come from the injected clock, so the determinism exit criterion ("same seed twice produces identical recordings") is byte-for-byte comparable JSONL with no tolerance windows. A deliberately slow agent in tests is one whose `act` calls `clock.advance(...)` — the timeout trips deterministically without a real sleep.

## Slots: agents and external action sources

`run_episode` takes a mapping from slot id to a binding, one of two kinds:

- `AgentSlot(agent)` — a loaded agent driven by the agent timeout machinery below.
- `ExternalSlot(source, timeout_ms=None)` — a slot fed from outside, which is what "human" means to the harness. `ActionSource` is a protocol: `get_action(slot_id, observation, deadline_ms) -> action | None`. The source may block up to the deadline (Stage 3's transport-backed source will); returning `None` means no input arrived, and the harness applies `entry.default_action(slot_id)` — noop for Flappy Bird, a legal default move for a later turn-based game. The slot's `timeout_ms` defaults from `meta.human_timeout_ms`, and when the environment has a pace interval the interval is the deadline, per [interaction.md](../specs/interaction.md).

The two paths are deliberately separate machinery, as the exit criteria demand: external slots never consult the per-step agent limit, and their `None`-fallback involves no measurement or overage accounting. Stage 2 ships two trivial sources, `NoopSource` (always `None`) and `ScriptedSource` (replays a list), which is enough to drive the human path through the programmatic API today.

## Timeouts, honestly stated

Python cannot preempt a synchronous `act()` in-process, and the harness shares the process with participant code by design. So per-step enforcement is cooperative: the harness reads the clock around `act`, and if the decision exceeds the per-step limit it **discards the returned action, applies the environment default, and records the overage**. The optional `learn` hook runs after the step, so its time cannot change the action that already happened, but it still counts toward the same per-step overage count and the per-episode budget. The agent pays for slowness in outcome when the action itself is late, and always pays in timing and budget, which is what [submission.md](../specs/submission.md) prescribes. A truly hung agent stalls the loop; containment for that is the container's per-episode wall clock and the Stage 3 orchestrator's kill path, not in-process threads. Threads were considered and rejected: a timed-out thread cannot be killed, keeps consuming the CPU the next agent is entitled to, and buys nothing the container does not already guarantee.

The per-episode limit is a cumulative budget of measured agent compute (`act` plus `learn`) per slot; when a slot exhausts it, the episode truncates with reason `episode_limit`, recorded in the result. Episode-limit semantics across multiple slots are confirmed in Stage 7 when a second multi-slot environment exists; Stage 2 implements per-slot budgets, which degenerate to the obvious thing for one slot. Both limits default from `EnvironmentMeta` and are overridable per call, since iterations override them in Stage 6.

`learn` is called after the environment step with that step's transition, only when present. Its time counts against both limits. The schema's per-agent timing object is an open region, so a `learn_ms` field is added now as a documented optional property, an additive change with no version bump, regenerated through the Stage 1 staleness machinery. `decision_ms` stays pure `act` time, while the later leaderboard compute column can combine `decision_ms`, `learn_ms`, and future hook timings.

## The loop and state assembly

`run_episode(entry, slots, *, seed, store=None, recording_id=None, clock=SystemClock(), step_limit_ms=None, episode_limit_ms=None, max_steps=None) -> EpisodeResult`. (`max_steps` backs the CLI's `--steps` cap and truncates the episode with reason `truncated`; the default clock is constructed lazily as `SystemClock()` when `clock` is `None`.)

Reset seeds everything: `env.reset(seed=seed)`, then each agent's `reset(seed)`. The loop is PettingZoo's agent-environment cycle: for each acting slot, take the clock, obtain an action (agent path or external path above), step the environment, call `learn` if present, assemble one per-step state, validate-and-write it through the Stage 1 `RecordingWriter`, and advance `tick`. One state line per environment step; the `agents` object carries the acting slot's entry (display observation if the entry provides one, action, reward, cumulative score, `decision_ms`), and `overlay` comes from `entry.overlay(env)` when the hook exists. There is no pacing anywhere in this function: the pace interval is metadata that Stage 3's live loop reads to schedule calls into the same step machinery, and the local CLI steps as fast as the agent acts. The header records the environment id, the seed, and `created_at` from the injected clock.

`EpisodeResult` reports ticks played, final score per slot, the termination reason (`terminated`, `truncated`, `episode_limit`), per-slot step-timeout counts, and the recording id when a store was given. Recording is optional precisely so the template's evaluation harness pattern (run many seeds, keep scores, store nothing) is the same code path.

## The CLI

`python -m game_sandbox_harness.cli` is the development runner: `--env flappy_bird` (resolved through the entry-point registry), `--agent <repo-root>` to load a manifest agent or `--source noop|scripted:<file>` to drive the slot externally, `--seed`, `--record <dir>` (a `FolderRecordingStore` root; recording id defaults to `<env>-seed<seed>-<created_at>`), and `--steps` to cap an episode. It prints the `EpisodeResult` summary and the recording id. The CLI is a thin argument-parsing shell over `run_episode`; anything the CLI can do, Stage 3 can do programmatically, which is the point.
