# Stage 11.1: Harness Hook and Shared Observation Spaces

Status: not started.

Part of [Stage 11](../stage-11-semantic-contract.md). This is build-order step 1. It lands the two pieces every environment conversion depends on, before any environment converts: the shared card-observation spaces (`CARD`/`HAND`/`TRICK`) and codec in `local_play/spaces.py`, and the `default_action(env, slot_id)` signature so a timeout can record the real action. The harness boundary check is deliberately left alone — actions stay a flat `Discrete(n)` with a binary `action_mask`, which the boundary already understands.

## Why this is its own seam

Steps 2 and 3 both build their object-shaped observations out of the same card, hand, and trick spaces, so those must exist and be shared first rather than duplicated per game. Landing the `default_action` signature here too keeps the environment steps focused on their observation shape: by the time Hearts converts, the hook it needs is already in place, and the three environments adapt their providers mechanically without changing behavior.

## What to build

### Shared observation spaces

A new dependency-light `environments/src/local_play/spaces.py` exports the composite observation building blocks and the int↔object codec:

```python
import numpy as np
from gymnasium import spaces

# Card ids are suit-major: card = suit * 13 + rank_index, so Q♠ == 36.
# Two rank conventions live here, deliberately distinct and never interchangeable:
#   engine rank INDEX  0..12: 0=2 .. 8=10, 9=J, 10=Q, 11=K, 12=A  — what rules.py compares on
#   observation FACE VALUE 2..14: 2..10, J=11 Q=12 K=13 A=14      — what the CARD space carries

CARD = spaces.Dict({"suit": spaces.Discrete(4),            # 0=clubs 1=diamonds 2=spades 3=hearts
                    "rank": spaces.Discrete(13, start=2)}) # FACE VALUE 2..10, J=11 Q=12 K=13 A=14
HAND = spaces.Sequence(CARD)
TRICK = spaces.Sequence(spaces.Dict({"seat": spaces.Discrete(4), "card": CARD}))  # play-ordered records
SUIT_NAMES = ("clubs", "diamonds", "spades", "hearts")

def suit_of(card_id: int) -> int:   # engine accessor, unchanged semantics
    return card_id // 13

def rank_of(card_id: int) -> int:   # engine rank INDEX 0..12 — NOT face value
    return card_id % 13

def card_to_obj(card_id: int) -> dict[str, int]:   # -> FACE-VALUE object, observation only
    return {"suit": card_id // 13, "rank": card_id % 13 + 2}

def card_from_obj(o: dict[str, int]) -> int:
    return o["suit"] * 13 + (o["rank"] - 2)
```

This lives in `local_play/` because that is the one package the template sync ships to every template (via `TEMPLATE_BASE_MODULES`, the same channel as `render_cards.py`), and both `hearts/env.py` and `spades/env.py` import it through the established `local_play`↔`sandbox` fallback (as `hearts/render.py` already does for `render_cards`). It replaces the byte-for-byte `suit_of`/`rank_of` and suit-id duplication currently sitting in both `rules.py`, which now import the 0-based `suit_of`/`rank_of` from here for their internal comparisons. The module deliberately carries two rank conventions that must never be mixed: `rules.py` keeps comparing on the engine **index** (`rank_of`, queen = 10), while `card_to_obj`/`card_from_obj` are the **face-value** observation codec (queen = 12) applied only at the `env.py`/`overlay.py` boundary — reaching for `card_to_obj(c)["rank"]` where the engine expects `rank_of(c)` shifts every rank by two and silently breaks the pure, heavily-tested engine. The actual wiring into `TEMPLATE_BASE_MODULES` lands in step 5 with the rest of the generation pass; this step only creates the module and points the two rules engines at it.

### Default-action hook

`EnvironmentEntry.default_action` in `harness/src/game_sandbox_harness/environment.py` changes from `Callable[[str], Any]` to `Callable[[Any, str], Any]`: the hook now receives the live environment instance first and the slot id second, so a default can be computed from real state (the lowest legal card index) instead of a sentinel the environment resolves later. The docstring changes with it: the hook returns a real action in the environment's action contract, applied on every timeout path. The three `default_action(slot_id)` call sites in `session.py` become `default_action(env, slot_id)`, and `scripts/play.py` updates its single call the same way.

### Boundary check — unchanged

`_illegal_action_reason` and `_action_mask` in `session.py` stay as they are: an action is judged by `action_space(slot).contains(action)` and by the binary `action_mask`, exactly as today. No JSON Schema, no `legal_actions`, no `jsonschema` validator, no metadata schema fields. `EnvironmentMeta` is untouched.

### Mechanical environment adaptation

The three registry entries in `environments/src/{hearts,spades,flappy_bird}/__init__.py` adapt their `default_action` providers to the two-argument signature. Each provider computes, from the live env, the same action the environment used to resolve the sentinel to internally — Hearts and Spades return the real lowest-legal card index; Flappy returns `0` (idle) — so the action actually played on a timeout is unchanged. The one intended behavior change lands here and is the reason the signature moved: from this step on a timed-out seat **records** that real index rather than the sentinel. The `AUTO_ACTION`/`NOOP_ACTION` sentinel constants and their env-side resolution are retired in the environments' own steps (2–4).

## Tests

- `environments/tests/` gains a test that `card_to_obj`/`card_from_obj` round-trip all 52 cards and pin worked examples (the queen of spades is `{"suit": 2, "rank": 12}`, int 36), and that both `rules.py` still expose identical suit/rank semantics now sourced from `spaces.py`.
- Harness tests (`test_session.py`, `test_session_chat.py`, `test_live.py`, `test_environment.py`) update their fake entries to the two-argument `default_action` signature; the existing `Discrete`/`action_mask` fakes are otherwise unchanged.
- A case pins that `default_action(env, slot_id)` is called on the timeout path and its return value is recorded as the action played.
- pyright accepts the new `default_action` signature everywhere it is referenced.

## Done when

The full Python suite is green with the three environments unconverted: a Hearts, Spades, and Flappy Bird episode each play to completion through the harness to the same terminal outcome as before — with the one intended change that a timed-out seat records the real action index its provider produced rather than the sentinel — and `scripts/play.py` still runs every environment. `local_play/spaces.py` exists, both card games import their suit/rank semantics from it, and pyright accepts the new `default_action` signature everywhere it is referenced.
