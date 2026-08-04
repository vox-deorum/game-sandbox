"""Generate deterministic Crane Reach recordings and test-only legality sidecars.

The recordings use the real harness path. Their legality files deliberately live beside, not in,
production JSONL: the opening frame is live-only and action masks are test inputs, not replay data.

Run from the repository root with: ``uv run python scripts/gen_crane_fixture.py``.
"""

from __future__ import annotations

import base64
import json
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from _fixture_common import FIXTURES_DIR
from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import resolve_parameters
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, Episode
from game_sandbox_harness.state import PlayerAttribution, StepState
from skirmish_crane import ENTRY
from skirmish_crane.hexes import distance
from skirmish_crane.naive import Agent as NaiveAgent
from skirmish_crane.naive import _end
from skirmish_crane.overlay import decode_overlay


def _encode_mask(mask: Any) -> str:
    """Encode a binary mask with bit ``i`` at byte ``i // 8``, little-endian within each byte."""
    encoded = bytearray((len(mask) + 7) // 8)
    for index, allowed in enumerate(mask):
        if allowed:
            encoded[index // 8] |= 1 << (index % 8)
    return base64.b64encode(encoded).decode("ascii")


class MaskingAgent:
    """Wrap a policy and retain the exact mask it saw for each actionable harness tick."""

    def __init__(
        self,
        player: str,
        policy: Any,
        tick: Callable[[], int],
        masks: dict[int, tuple[str, str, str]],
    ) -> None:
        self._player = player
        self._policy = policy
        self._tick = tick
        self._masks = masks

    def reset(self, seed: int) -> None:
        self._policy.reset(seed)

    def act(self, observation: dict[str, Any]) -> dict[str, int]:
        mask = observation["action_mask"]
        tick = self._tick()
        if tick in self._masks:
            raise AssertionError(f"more than one action mask captured for tick {tick}")
        self._masks[tick] = (self._player, _encode_mask(mask["path"]), _encode_mask(mask["target"]))
        return self._policy.act(observation)


class RetreatAgent:
    """Choose the legal path that maximizes distance from the nearest visible enemy."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: dict[str, Any]) -> dict[str, int]:
        state = observation["observation"]
        position = (state["self"]["position"]["q"], state["self"]["position"]["r"])
        side = state["self"]["unit_id"].split("_", 1)[0]
        enemies = [
            (unit["position"]["q"], unit["position"]["r"])
            for unit in state["visible_units"]
            if unit["side"] != side
        ]
        if not enemies:
            return {"path": 0, "target": 0}
        legal_paths = [path for path, allowed in enumerate(observation["action_mask"]["path"]) if allowed]
        path = max(
            legal_paths,
            key=lambda candidate: (
                min(distance(_end(position, candidate), enemy) for enemy in enemies),
                -candidate,
            ),
        )
        return {"path": path, "target": 0}


def _current_activation(state: StepState) -> str:
    overlay = state.get("overlay")
    if not isinstance(overlay, dict):
        raise AssertionError("Crane Reach fixture state is missing its overlay")
    activation = decode_overlay(overlay)["current_activation"]
    if not isinstance(activation, str):
        raise AssertionError("actionable Crane Reach fixture state is missing its current activation")
    return activation


def _legality(
    recording_name: str,
    opening: StepState,
    states: list[StepState],
    masks: dict[int, tuple[str, str, str]],
) -> dict[str, Any]:
    """Build the compact fixture-only legality shape from recorded and live-only frames."""
    opening_player, opening_path, opening_target = masks.pop(0)
    opening_activation = _current_activation(opening)
    if opening_player != opening_activation:
        raise AssertionError("opening action mask does not belong to the opening activation")
    entries: list[dict[str, Any]] = [
        {
            "opening": opening,
            "current_activation": opening_activation,
            "path": opening_path,
            "target": opening_target,
        }
    ]
    for state in states:
        # A call made at harness tick N acts from the state recorded at tick N - 1. Dead AEC
        # steps therefore leave no entry, and each remaining entry is genuinely actionable.
        captured = masks.pop(state["tick"] + 1, None)
        if captured is None:
            continue
        player, path, target = captured
        activation = _current_activation(state)
        if player != activation:
            raise AssertionError(f"tick {state['tick']} mask belongs to {player}, expected {activation}")
        entries.append(
            {
                "tick": state["tick"],
                "current_activation": activation,
                "path": path,
                "target": target,
            }
        )
    if masks:
        raise AssertionError(f"unmatched action masks: {sorted(masks)}")
    return {"version": 1, "recording": recording_name, "entries": entries}


def _attribution(count: int) -> dict[str, PlayerAttribution]:
    return {
        f"player_{index}": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}
        for index in range(count)
    }


def _write_fixture(
    *,
    output_dir: Path,
    recording_name: str,
    legality_name: str,
    recording_id: str,
    seed: int,
    overrides: dict[str, Any],
    policy: Callable[[], Any],
) -> None:
    parameters = resolve_parameters(ENTRY.meta, overrides)
    count = 6 if parameters["seat_plan"] == "skirmish" else 40
    masks: dict[int, tuple[str, str, str]] = {}
    with tempfile.TemporaryDirectory() as tmp:
        episode_ref: list[Episode] = []
        players = {
            f"player_{index}": AgentPlayer(
                MaskingAgent(f"player_{index}", policy(), lambda: episode_ref[0].tick, masks)
            )
            for index in range(count)
        }
        episode = Episode(
            ENTRY,
            players,
            seed=seed,
            parameters=parameters,
            store=FolderRecordingStore(tmp),
            recording_id=recording_id,
            player_attribution=_attribution(count),
            clock=ManualClock(),
        )
        episode_ref.append(episode)
        try:
            episode.start()
            opening = episode.opening_state()
            if opening is None:
                raise AssertionError("Crane Reach must publish a turn-based opening state")
            while not episode.done:
                episode.advance()
        finally:
            episode.close()

        source = Path(tmp) / recording_id / "recording.jsonl"
        states = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines()[1:]]
        legality = _legality(recording_name, opening, states, masks)
        recording_dest = output_dir / recording_name
        legality_dest = output_dir / legality_name
        shutil.copyfile(source, recording_dest)
        legality_dest.write_text(json.dumps(legality, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"wrote {recording_dest} ({len(states)} ticks)")
        print(f"wrote {legality_dest} ({len(legality['entries'])} actionable frames)")


def generate(output_dir: Path = FIXTURES_DIR) -> None:
    """Write both deterministic fixture pairs to ``output_dir``."""
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_fixture(
        output_dir=output_dir,
        recording_name="crane-reach-skirmish-recording.jsonl",
        legality_name="crane-reach-skirmish-legality.json",
        recording_id="crane-reach-skirmish-fixture",
        seed=4,
        overrides={},
        policy=NaiveAgent,
    )
    _write_fixture(
        output_dir=output_dir,
        recording_name="crane-reach-army-recording.jsonl",
        legality_name="crane-reach-army-legality.json",
        recording_id="crane-reach-army-fixture",
        seed=4,
        overrides={
            "seat_plan": "army",
            "field_extent": 10,
            "terrain": True,
            "unit_abilities": True,
            "capture_zones": 3,
            "round_cap": 150,
        },
        policy=RetreatAgent,
    )


def main() -> int:
    generate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
