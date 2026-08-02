# Stage 19: Composite action spaces

Status: planned.

## Goal

An environment may declare a Gymnasium `Dict` action space and publish a matching per-key `action_mask`, and the platform handles that action correctly at every boundary it owns: legality attribution, recording, and conformance. The rule for when a composite action is sound is written into the specification with a worked example on each side of it.

This is platform work rather than a product feature. No shipped environment uses the new shape, so nothing a participant or an operator sees changes.

## Scope

The wire is already shape-agnostic. `action` is `z.unknown()` in the command schema, untyped in the state schema, `Any` in the harness, and `unknown` in the renderer contract, so a composite action already travels from a browser to an environment and back into a recording untouched. Three platform boundaries do not handle it, and this stage fixes those:

- `illegal_action_reason` judges a mapping-shaped mask key by key. Its flat behavior is unchanged.
- One JSON normalizer serves the recording writer, the live opening frame, and the conformance suite. Today the conformance suite accepts a NumPy leaf while the writer crashes on the same leaf.
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

`action_mask` in `participant_runner.py` returns the raw `"action_mask"` value without interpreting it, so a mapping already passes through and only its docstring widens. `illegal_action_reason` gains a mapping branch and factors the flat index test into a `_masked_out` helper, leaving the flat path unchanged expression for expression.

Three shape disagreements withhold a verdict rather than charging the acting player, because a mask whose shape does not match the action space is the environment's defect:

| Case | Verdict | Reason |
| --- | --- | --- |
| Mapping mask, non-mapping action | None | Unreachable for a real `Dict` space, since `contains` already returned the out-of-space reason. Today this raises `KeyError` from `mask[0]` on a dict, outside the agent try block, surfacing as an unowned fault. The guard is a fix. |
| Flat mask, mapping action | None | Already the outcome by accident, because `int(dict)` raises and the index becomes `None`. Now reached deliberately. |
| Mask key the action omits | Skipped | `Dict.contains` already rejects a missing component, so the space check owns it. |
| Mask entry of `None` | Skipped | Gymnasium's spelling for an unrestricted subspace, and the only legal entry for a `Box` subspace. |

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

`test_dict_action_space.py` proves four things: the fixture passes `api_test`; the cross product of the masked-in per-key values equals the environment's own legal set on every turn, checked by enumeration rather than sampling; a per-key mask violation is charged to the acting player while a shape disagreement charges nobody; and a composite action sampled through `space.sample(mask=...)` round-trips into a recording as plain JSON integers while a value the recording cannot represent still fails the write.

`api_test` passing is a weaker statement for a composite action than for Hearts, because PettingZoo's `test_action_flexibility` branches on `Discrete` and `Box` only and skips a `Dict` space silently. The enumeration proof exists for that reason.

### The parallel limitation is documented, not enforced

PettingZoo's `parallel_api_test` reduces an action mask with `np.flatnonzero` before sampling, which on an object mask yields `array([0])` and sends the bare integer zero. The correction merged upstream on 24 May 2026 in [PettingZoo pull request 1313](https://github.com/Farama-Foundation/PettingZoo/pull/1313), after the 1.26.1 release of 27 April 2026, and `environments/pyproject.toml` pins `pettingzoo>=1.26,<1.27`.

The specification states the sequential-only limitation and names the reason. The conformance suite stays permissive, so an author who tries it gets PettingZoo's own failure, and the constraint lifts on its own when a release carrying the fix lands.

## Exit criteria

- A `Dict`-action AEC fixture passes PettingZoo's `api_test` with only the known non-array action-mask warning filtered.
- The per-key masked legal set enumerates exactly to the environment's own legal set on every turn of a full episode.
- A per-key mask violation raises `IllegalAgentActionError` naming the acting player, and a mask-versus-action shape disagreement charges nobody.
- The five existing illegal-action tests pass unedited.
- A composite action sampled through `space.sample(mask=...)` round-trips into a recording as plain JSON integers, and a value the recording cannot represent still fails the write.
- `schema/fixtures/` is byte-identical across the change.
- The specification states the factorization rule with both examples and the sequential-only limitation.
- `uv run python scripts/ci.py python`, `generated-code-fresh`, and `docs` pass.
