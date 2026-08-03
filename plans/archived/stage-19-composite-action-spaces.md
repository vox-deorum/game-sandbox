# Stage 19: Composite action spaces

Status: implemented.

## Goal

An environment may declare a Gymnasium `Dict` action space and publish a matching per-key `action_mask`, and the platform handles that action correctly at every boundary it owns: legality attribution, recording, and conformance. The rule for when a composite action is sound is written into the specification with a worked example on each side of it.

This is platform work rather than a product feature. No shipped environment uses the new shape, so nothing a participant or an operator sees changes.

## Scope

The wire is already shape-agnostic. `action` is `z.unknown()` in the command schema, untyped in the state schema, `Any` in the harness, and `unknown` in the renderer contract, so a composite action already travels from a browser to an environment and back into a recording untouched. Three platform boundaries do not handle it, and this stage fixes those:

- `illegal_action_reason` judges a mapping-shaped mask key by key, against the subspace that declares each key. The flat path keeps its verdicts and gains the `start` offset the mask has always been indexed from.
- One JSON normalizer serves the recording writer, the live opening frame, and the conformance suite. Today the conformance suite accepts a NumPy leaf while the writer crashes on the same leaf.
- The conformance suite checks a published mask against its declared action space, so an author learns about a shape the platform cannot read at test time rather than through a session that aborts with no player to charge.
- A `Dict`-masked AEC fixture and its tests in `harness/tests/` prove the factorization rule, the attribution path, and the recording round trip.

[The environment contract](../docs/specs/environment.md) gains a composite-actions section with the rule, both examples, and the sequential-only limitation. Three other pages lose a claim that is no longer universal.

Out of scope:

- Migrating Spades off its `Discrete(66)` combined space. Its `52 + k` bid offset is the obvious first consumer, but converting it touches the engine, the overlay, the cards renderer, the student template, the student guide, and every Spades test.
- Simultaneous environments. The limitation is documented, not enforced in code.
- An `EnvironmentMeta` field naming the action space shape. Nothing would read it, and adding one would pull in a zod change, a regenerated JSON Schema, and a backend pass-through to carry information every downstream layer is deliberately opaque to.
- Any frontend, backend, or schema change.

## Related specifications

- [Environments](../docs/specs/environment.md): the observation and action contract, which this stage extends.
- [Submissions](../docs/specs/submission.md): the `act` return value.
- [Interaction](../docs/specs/interaction.md): the renderer's gesture-to-action mapping.

## Dependencies

- [Stage 11](stage-11-semantic-contract.md): the semantic observation and the `{"observation", "action_mask"}` wrapper this stage extends to an object mask.
- [Stage 17](stage-17-simultaneous-stepping.md): parallel environments, which the sequential-only limitation constrains.

## Implementation decisions

### A composite action space must factorize

Gymnasium masks each subspace independently. `Dict.sample(mask=...)` draws one value per key and combines them, so masked sampling covers the cross product of the per-key legal sets. A `Dict` action space is permitted only when the legal action set is exactly that product. Where it is, the mask stays authoritative for agent legality, which is what the environment contract already promises.

A phase-tagged action factorizes:

```python
spaces.Dict({"kind": spaces.Discrete(2), "index": spaces.Discrete(52)})
```

During bidding, `kind` is pinned to the bid phase and `index` is masked to the legal bids. `index` is free within that phase, so every combination the mask allows is a legal move. Five hundred masked samples produced no illegal draw.

A coordinate action does not:

```python
spaces.Dict({"suit": spaces.Discrete(4), "rank": spaces.Discrete(13)})
```

A hand holding the two of clubs and the nine of spades masks in the suits `{clubs, spades}` and the ranks `{two, nine}`, so masked sampling can draw the two of spades, which is not held. A legal set of `{(0, 3), (2, 9)}` sampled as all four of `{(0, 3), (0, 9), (2, 3), (2, 9)}`, and a full `api_test` run fed four illegal actions out of twelve to the environment.

An environment in the second position keeps a flat `Discrete` over the joint options, or moves the joint choice into a single `Dict` key whose values enumerate it.

### The mask check judges each key on its own

`action_mask` in `participant_runner.py` returns the raw `"action_mask"` value without interpreting it, so a mapping already passes through and only its docstring widens. `illegal_action_reason` looks the player's declared action space up once, through `env.action_space(player_id)`, and reuses that one space for both the `contains` check and the mask check, so the two checks judge the action against the same declaration.

The mask check itself is `_masked_out(space, component, entry)`, which reads one mask entry against the subspace that declares it:

- A `Discrete` subspace honors `start`: the entry is a binary vector whose position `i` covers the action `start + i`.
- A `MultiDiscrete` subspace is checked per dimension, each dimension honoring its own `start`.
- A nested `Dict` subspace recurses key by key, through the same helper that walks the top-level mapping.
- Anything else withholds a verdict rather than guessing at a shape it does not recognize.

Every level is wrapped so an unreadable entry withholds that component's verdict alone and the check itself cannot raise. This matters because `illegal_action_reason` runs outside the attribution guards in `select_action`, on both the agent path, where a raise would surface as an unowned fault, and the human path, which is designed to fall back to the default action rather than fail.

When no declared space is available, the check judges a scalar component against a zero-start binary vector and withholds anything it cannot align to that shape, rather than guessing at a shape it cannot confirm.

These shape disagreements withhold a verdict rather than charging the acting player, because a mask the check cannot align to its declared shape is the environment's defect, not the agent's:

| Case | Verdict | Reason |
| --- | --- | --- |
| Mapping mask, non-mapping action | None | Unreachable for a real `Dict` space, since `contains` already returned the out-of-space reason. The guard keeps an object mask out of the flat branch, which would index it by an integer. |
| Flat mask, mapping action | None | A flat mask says nothing about a composite action, so the flat branch does not judge one. |
| Mask key the action omits | Skipped | `Dict.contains` already rejects a missing component, so the space check owns it. |
| Mask entry of `None` | Skipped | The spelling for an unrestricted subspace, and the only legal entry for a `Box` subspace. |
| Mask entry the check cannot read against its subspace | Withheld for that key alone; the other keys are still judged | A malformed entry, such as the wrong length or a non-numeric value, is the environment's defect, not the agent's. |
| A subspace type outside `Discrete`, `MultiDiscrete`, and nested `Dict` | Withheld | The check does not guess at a shape it does not recognize. |

The message keeps the `legal-move mask` substring, so the five existing illegal-action tests pass unedited. Those tests passing without modification is the acceptance criterion for the flat path not having moved.

### One JSON normalizer, silent for NumPy and loud for everything else

`json_default` lives in `state.py`, which owns the JSON-shaped wire TypedDicts. It tries `tolist` then `item`, then falls through to `json.JSONEncoder().default`, so NumPy scalars and arrays normalize while a set, a dataclass, or a card object still raises. The converter is duck-typed, so the harness gains no NumPy dependency.

Three call sites converge on it:

1. `recording/local.py`: `_dump_line` becomes public `dump_line` and gains `default=json_default`.
2. `live_io.py`: `ProtocolStream.emit_state` calls `dump_line` instead of its own copy of the same `json.dumps` call. Its docstring already promises the same bytes the recording writer produces, and that promise was held by duplication. This is a live crash path, because the opening frame carries an environment overlay and bypasses the recording entirely.
3. `environments/test_conformance.py` drops its private `_json_default` and imports the shared one. `_json_bytes` keeps its `allow_nan=False`, which `dump_line` must not adopt.

`emit_envelope` keeps its own call. Its payloads are harness-owned, and rewards and scores are already coerced to `float` in `session.py`.

NumPy normalizes silently rather than raising. The bytes are identical either way, the serializer runs after `env.step` with no way to attribute fault, and the platform's own recommended call for a composite action is `space.sample(mask=...)`, which returns NumPy scalars by construction.

### The fixture lives in the harness tests

No shipped environment declares a `Dict` action space, so a conformance check gated on one would be dead code. The conformance suite also never constructs an `Episode`, so it can prove neither mask attribution nor the recording round trip. The fixture follows the `support_parallel.py` precedent, which already imports Gymnasium and PettingZoo from harness tests.

It must stay out of `environments/` and gain no entry point, or the authoring-shape conformance test will demand a renderer, a thumbnail, a template, an example, and a student guide for it.

`support_dict_action.py` holds a two-player AEC environment with a `{"kind", "index"}` action space, an object mask under the usual observation wrapper, a `step` that recomputes the legal set and rejects anything outside it, a test-only `legal_actions` accessor, and a `default_action` returning plain Python integers.

It is sequential on purpose. `parallel_api_test` cannot sample an object mask on the pinned PettingZoo, so a parallel fixture could not be conformance-tested at all.

`support_dict_action.py` keeps its two `Discrete` keys rather than growing more subspace types onto the one fixture: the enumeration proof, the `api_test` run, and the recording round trip are all written against that two-key shape. The tests covering `MultiDiscrete`, a nested `Dict`, `Box`, `start`, and a malformed entry instead use small rigs defined beside the tests in `test_dict_action_space.py`, following the `MaskedEnv` precedent in `test_session.py`, where a fixture built for one test lives next to it rather than in the shared support module.

`test_dict_action_space.py` proves five things: the fixture passes `api_test`; the cross product of the masked-in per-key values equals the environment's own legal set on every turn, checked by enumeration rather than sampling; a per-key mask violation is charged to the acting player while a shape disagreement charges nobody; an entry the check cannot read costs nobody the episode, on the agent path and the human path alike; and a composite action sampled through `space.sample(mask=...)` round-trips into a recording as plain JSON integers while a value the recording cannot represent still fails the write. The per-subspace rules and the conformance validator are covered alongside them.

`api_test` passing is a weaker statement for a composite action than for Hearts, because PettingZoo's `test_action_flexibility` branches on `Discrete` and `Box` only and skips a `Dict` space silently. The enumeration proof exists for that reason.

### The conformance suite validates a mask against its declared space

`action_mask_problems(space, mask)` lives in `environment.py` beside the parallel validators, since that module already owns the contract boundary and the conformance suite already imports from it. It returns a list of problem descriptions rather than raising, so one run reports every disagreement and a unit test can inspect them.

It recognizes a subspace by its type name, so the harness gains no Gymnasium dependency. A `Discrete` mask must be a binary vector of length `n`; a `MultiDiscrete` mask must be a tuple of one binary vector per dimension, each the length of its `nvec` entry; a `Box` mask must be `null`; and a `Dict` mask is checked key by key against its declared children, recursing into a nested `Dict`. It validates a flat action space too, not only a composite one.

Before it checks the mask, it checks the space: a `Dict` child outside `Discrete`, `MultiDiscrete`, `Dict`, and `Box` is rejected by name. `MultiBinary` and `Tuple` name the permitted shape to declare instead, a `MultiDiscrete` with two values per dimension and a `Dict` with one key per component respectively.

It is wired into both the AEC and parallel rollouts in `environments/test_conformance.py`, reading the mask through the same `action_mask` lookup the harness uses at runtime, so the suite validates what a running session actually reads rather than a shape reconstructed for the test.

### The parallel limitation is documented, not enforced

PettingZoo's `parallel_api_test` reduces an action mask with `np.flatnonzero` before sampling, which on an object mask yields `array([0])` and sends the bare integer zero. The correction merged upstream on 24 May 2026 in [PettingZoo pull request 1313](https://github.com/Farama-Foundation/PettingZoo/pull/1313), after the 1.26.1 release of 27 April 2026, and `environments/pyproject.toml` pins `pettingzoo>=1.26,<1.27`.

The specification states the sequential-only limitation and names the reason. The conformance suite stays permissive, so an author who tries it gets PettingZoo's own failure, and the constraint lifts on its own when a release carrying the fix lands.

## Exit criteria

- A `Dict`-action AEC fixture passes PettingZoo's `api_test` with only the known non-array action-mask warning filtered.
- The per-key masked legal set enumerates exactly to the environment's own legal set on every turn of a full episode.
- A per-key mask violation raises `IllegalAgentActionError` naming the acting player, and a mask-versus-action shape disagreement charges nobody.
- A masked-out `MultiDiscrete` dimension raises `IllegalAgentActionError` naming the acting player.
- A malformed mask entry withholds that key's verdict alone: the other keys in the same action are still judged, and the human path defaults rather than crashing on it.
- `start` is honored on both the flat action-space path and the per-key composite path.
- The five existing illegal-action tests pass unedited.
- A composite action sampled through `space.sample(mask=...)` round-trips into a recording as plain JSON integers, and a value the recording cannot represent still fails the write.
- The conformance suite rejects a `Dict` action space that declares an unpermitted child type, and a mask whose shape disagrees with its declared space.
- `schema/fixtures/` is byte-identical across the change.
- The specification states the factorization rule with both examples and the sequential-only limitation.
- `uv run python scripts/ci.py python`, `generated-code-fresh`, and `docs` pass.
