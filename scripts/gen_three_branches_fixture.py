"""Generate the Days at Three Branches renderer recording and decoded sidecar.

The fixture runs the shipped cast_5 builtins through the real harness recording path without
pacing. Its sidecar keeps the Python overlay decoder's friendly result available to the renderer
agreement tests without repeating the static village in every selected frame.

Run from the repository root with: ``uv run python scripts/gen_three_branches_fixture.py``.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from _fixture_common import FIXTURES_DIR
from game_sandbox_harness.clock import ManualClock
from game_sandbox_harness.environment import preset_values, resolve_parameters
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, run_episode
from game_sandbox_harness.state import PlayerAttribution
from three_branches import ENTRY
from three_branches.env import make_env
from three_branches.layout import Layout
from three_branches.naive import Agent as Naive
from three_branches.overlay import decode_overlay
from three_branches.scripted_visitor import Agent as ScriptedVisitor

RECORDING_NAME = "three-branches-recording.jsonl"
SIDECAR_NAME = "three-branches-decoded.json"
RECORDING_ID = "three-branches-fixture"
SEED = 22
EXPECTED_STATE_COUNT = 1_200
GREETING_TICK = 105
GREETING = {"from": "player_0", "to": "player_2", "text": "A fine day for walking. How are you?"}


def _attribution() -> dict[str, PlayerAttribution]:
    return {
        "player_0": {
            "kind": "agent",
            "builtin_name": "scripted_visitor",
            "label": "Scripted visitor",
        },
        **{
            f"player_{index}": {"kind": "agent", "builtin_name": "naive", "label": "Naive"}
            for index in range(1, 6)
        },
    }


def _players() -> dict[str, AgentPlayer]:
    return {
        "player_0": AgentPlayer(ScriptedVisitor()),
        **{f"player_{index}": AgentPlayer(Naive()) for index in range(1, 6)},
    }


def _point(point: tuple[float, float]) -> dict[str, float]:
    return {"x": point[0], "y": point[1]}


def _walls(layout: Layout) -> dict[str, list[list[dict[str, float]]]]:
    return {
        building_id: [[_point(start), _point(end)] for start, end in segments]
        for building_id, segments in layout.building_walls.items()
    }


def _expression_targets(decoded: Mapping[str, Any]) -> tuple[tuple[str, str], ...]:
    characters = decoded["characters"]
    if not isinstance(characters, list):
        raise AssertionError("decoded overlay characters must be a list")
    return tuple((character["expression"], character["target"]) for character in characters)


def _without_village(decoded: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in decoded.items() if key != "village"}


def _assert_fixture_content(states: list[dict[str, Any]], decoded_states: list[dict[str, Any]]) -> None:
    """Keep the renderer fixture useful as the builtins evolve."""
    cast = [f"npc_{index}" for index in range(5)]
    positions = {character_id: [] for character_id in cast}
    walking_started = {character_id: False for character_id in cast}
    stalled = False
    visitor_waved = False

    for decoded in decoded_states:
        characters = {character["id"]: character for character in decoded["characters"]}
        for character_id in cast:
            character = characters[character_id]
            position = character["position"]
            positions[character_id].append((position["x"], position["y"]))
            if character["moved"] > 0:
                walking_started[character_id] = True
            elif walking_started[character_id]:
                stalled = True
        visitor_waved = visitor_waved or characters["visitor"]["expression"] == "wave"

    unmoved = [character_id for character_id, path in positions.items() if len(set(path)) == 1]
    if unmoved:
        raise AssertionError(f"fixture naive cast members did not move: {', '.join(unmoved)}")
    if not stalled:
        raise AssertionError("fixture must contain a naive collision stall after walking starts")
    if not visitor_waved:
        raise AssertionError("fixture must contain a visitor wave")

    greeting_state = next((state for state in states if state.get("tick") == GREETING_TICK), None)
    if greeting_state is None or greeting_state.get("messages") != [GREETING]:
        raise AssertionError(f"fixture must contain the pinned visitor greeting at tick {GREETING_TICK}")


def _opening(parameters: Mapping[str, Any]) -> tuple[dict[str, Any], Layout]:
    """Extract the unrecorded reset frame and the village layout the recorded day replays."""
    environment = make_env(parameters)
    try:
        environment.reset(seed=SEED)
        overlay_extractor = ENTRY.overlay
        if overlay_extractor is None:
            raise AssertionError("Three Branches entry is missing its overlay extractor")
        overlay = overlay_extractor(environment)
        if overlay is None:
            raise AssertionError("Three Branches opening state is missing its overlay")
        return overlay, environment.day.layout
    finally:
        environment.close()


def _sidecar(
    header: Mapping[str, Any],
    states: list[dict[str, Any]],
    opening_overlay: Mapping[str, Any],
    layout: Layout,
) -> dict[str, Any]:
    static = header.get("overlay_static")
    if not isinstance(static, Mapping):
        raise AssertionError("Three Branches recording header is missing overlay static data")
    decoded_states = []
    for state in states:
        overlay = state.get("overlay")
        if not isinstance(overlay, Mapping):
            raise AssertionError("Three Branches recording state is missing its overlay")
        decoded_states.append(decode_overlay(overlay, static))

    _assert_fixture_content(states, decoded_states)

    if [state["tick"] for state in states] != list(range(EXPECTED_STATE_COUNT)):
        raise AssertionError("fixture recording must use zero-based replay frame indexes")
    ticks = [decoded["tick"] for decoded in decoded_states]
    if ticks != [*range(2, EXPECTED_STATE_COUNT + 1), EXPECTED_STATE_COUNT]:
        raise AssertionError("fixture recording must preserve the engine's opening and terminal frames")
    if not decoded_states[-1]["terminal"]:
        raise AssertionError("fixture recording must finish with a terminal frame")

    opening = decode_overlay(opening_overlay, static)
    if opening["tick"] != 1 or opening["terminal"]:
        raise AssertionError("fixture opening must be the nonterminal tick 1 reset state")

    selected = {0, len(decoded_states) - 1}
    previous: tuple[tuple[str, str], ...] | None = None
    for frame_index, decoded in enumerate(decoded_states):
        if decoded["tick"] % 100 == 0 or _expression_targets(decoded) != previous:
            selected.add(frame_index)
        previous = _expression_targets(decoded)

    first = decoded_states[0]
    frames = []
    for frame_index in sorted(selected):
        decoded = decoded_states[frame_index]
        frame = _without_village(decoded)
        frames.append({"frame_index": frame_index, **frame})
    return {
        "version": 1,
        "recording": RECORDING_NAME,
        "static": {"version": first["version"], "village": first["village"]},
        "opening": {"overlay": opening_overlay, "decoded": _without_village(opening)},
        "walls": _walls(layout),
        "frames": frames,
    }


def generate(output_dir: Path = FIXTURES_DIR) -> None:
    """Write the deterministic recording and its decoder-agreement sidecar."""
    output_dir.mkdir(parents=True, exist_ok=True)
    parameters = resolve_parameters(ENTRY.meta, preset_values(ENTRY.meta, "season_1"))
    opening_overlay, layout = _opening(parameters)
    with tempfile.TemporaryDirectory() as tmp:
        result = run_episode(
            ENTRY,
            _players(),
            seed=SEED,
            parameters=parameters,
            store=FolderRecordingStore(tmp),
            recording_id=RECORDING_ID,
            player_attribution=_attribution(),
            clock=ManualClock(),
        )
        source = Path(tmp) / RECORDING_ID / "recording.jsonl"
        lines = source.read_text(encoding="utf-8").splitlines()
        if result.ticks != EXPECTED_STATE_COUNT or len(lines) != EXPECTED_STATE_COUNT + 1:
            raise AssertionError("fixture recording must contain one header and 1,200 states")
        frames = [json.loads(line) for line in lines]
        header, states = frames[0], frames[1:]
        if not isinstance(header, dict) or not all(isinstance(state, dict) for state in states):
            raise AssertionError("fixture recording must contain JSON objects")
        shutil.copyfile(source, output_dir / RECORDING_NAME)

    sidecar = _sidecar(header, states, opening_overlay, layout)
    sidecar_path = output_dir / SIDECAR_NAME
    sidecar_path.write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {output_dir / RECORDING_NAME} ({EXPECTED_STATE_COUNT + 1} lines, seed={SEED})")
    print(f"wrote {sidecar_path} ({len(sidecar['frames'])} selected frames)")


def main() -> int:
    generate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
