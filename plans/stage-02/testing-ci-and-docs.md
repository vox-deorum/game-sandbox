# Stage 2: Testing, CI Wiring, and Docs

Part of [Stage 2](../stage-02-harness-and-first-environment.md). Stage 1's workflows, jobs, and local-reproduction story ([stage-01/testing-and-ci.md](../stage-01/testing-and-ci.md)) carry over unchanged; this file lists what Stage 2 adds to them and which docs pages stop being stubs.

## Tests per package

`environments/` carries pytest suites for:

- the adapter passing PettingZoo's `api_test`;
- seeded determinism at the environment level: two resets with the same seed produce identical observation and overlay sequences under a scripted action list. This isolates environment nondeterminism from harness nondeterminism before the recording-level test below ever runs.
- the overlay extractor returning every documented field with finite values;
- `EnvironmentMeta.to_json()` round-tripping through `json.dumps`.

`harness/` adds suites that are the exit criteria made executable, all on `ManualClock`:

- **Determinism**: the same seed and the same scripted agent, run twice through `run_episode` into two recordings, compare byte-for-byte.
- **Agent per-step timeout**: an agent whose `act` advances the clock past the limit gets its action discarded, the default action applied, and the overage counted in the result.
- **Per-episode budget**: a slot that exhausts its cumulative budget truncates the episode with reason `episode_limit`.
- **External slot**: a `ScriptedSource` drives `player_0` through the programmatic API; a `NoopSource` slot falls back to the default action with no agent-timeout accounting touched (asserted via the result's zeroed overage counts).
- **Manifest loading**: a fixture repo loads and plays; each malformed-manifest variant raises `ManifestError` naming the actual problem.
- **Interface parity**: the template's `agent.py` stub and `AgentBase` agree method-for-method, so the two deliberately separate copies cannot drift.
- **CLI smoke**: the CLI runs the composed hello agent for a full seeded episode and the recording validates: the "scripted agent loaded from a manifest plays a full episode through the CLI" criterion, also the test that crosses all three packages.

Template-level testing rides the existing composed-example CI job: compose, fresh venv, pytest. It includes a short local-runner smoke test, which is the "clean machine with no sandbox backend" criterion in CI form. The composed venv includes the copied `sandbox.harness` package but not the backend.

## Tooling and CI wiring

Workspace changes ripple through existing config rather than new jobs. `environments` joins the uv workspace members and `tool.uv.sources`, `pytest` testpaths, ruff `src`, and pyright `include` in basic mode. The harness stays the only strict package, because environment wrappers talk to untyped game internals, where strictness buys suppressions, not safety. The `python` CI job picks all of this up via `uv sync` with no YAML change. The `generated-code-fresh` job covers each `templates/<env>/sandbox/env/` location from the static `TEMPLATE_ENVIRONMENTS` catalog and the shared modules synced into `templates/base/sandbox/`. The `examples` job installs the pinned Python dependency set, including NumPy and local-relay dependencies, but uv's wheel cache keeps that tolerable and no structural change is needed. `scripts/ci.py all` remains the one pre-PR command.

The schema change in this stage is exactly one additive edit: the optional `learn_ms` property on the per-agent timing object. It flows through `scripts/generate.py` as usual, regenerating TypeScript types, packaged schema copies, and golden fixtures in one run, with no version bump per the [versioning rule](../stage-01/state-schema.md).

## Docs

Two student stubs become real pages, written against the published template rather than the monorepo:

- `students/getting-started.md`: use the template repository, install the pinned set, run `play.py` and `evaluate.py`, set up `.env`.
- `students/agent-interface.md`: the four methods, what the harness guarantees about calls and seeds, the manifest fields, and the timeout rules an agent lives under.

`students/submitting.md` stays a stub until Stage 5 exists.

One contributor page is added: `contributors/environments.md`, the how-to-add-an-environment walkthrough. It covers the directory layout, the adapter, `EnvironmentEntry`, metadata fields and their meanings, the overlay contract with the renderer, the entry-point registration, and the `api_test` requirement. Hearts in Stage 7 is its first consumer. The `environments/README.md` placeholder is replaced with a pointer to that page, and the harness docs page gains the session-loop and CLI sections.
