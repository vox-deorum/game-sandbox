"""Generate the semantic Three Branches frontend recording fixture.

The fixture uses the production harness and the environment's current default parameters. Its
agents keep fresh local entropy, so validity is expressed as observable properties rather than
byte identity.

Run from the repository root with: ``uv run python scripts/gen_three_branches_fixture.py``.
"""

from __future__ import annotations

import json
import math
import re
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, cast

from _fixture_common import FIXTURES_DIR
from game_sandbox_harness.environment import resolve_layout, resolve_parameters
from game_sandbox_harness.recording.local import FolderRecordingStore
from game_sandbox_harness.session import AgentPlayer, run_episode
from game_sandbox_harness.state import PlayerAttribution
from three_branches import ENTRY
from three_branches.naive import Agent as NaiveAgent
from three_branches.scripted_visitor import Agent as ScriptedVisitorAgent

FIXTURE_NAME = "three-branches-recording.jsonl"
ATTEMPTS = 5
_PLAYER_ID = re.compile(r"player_(0|[1-9][0-9]*)\Z")


def _mapping(value: object) -> Mapping[str, Any]:
    return cast("Mapping[str, Any]", value) if isinstance(value, Mapping) else {}


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant {value}")


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"non-finite JSON number {value}")
    return number


def _states(path: Path) -> tuple[Mapping[str, Any], list[Mapping[str, Any]]]:
    """Read one recording without depending on its current configured day length."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines:
        raise AssertionError("Three Branches fixture recording is empty")
    decoded: list[object] = []
    for line_number, line in enumerate(lines, start=1):
        try:
            # Python's JSON decoder normally accepts NaN and infinities even though browsers and
            # the JSON standard reject them. The fixture crosses that browser boundary.
            decoded.append(json.loads(line, parse_constant=_reject_constant, parse_float=_finite_float))
        except (json.JSONDecodeError, ValueError) as error:
            raise AssertionError(f"fixture line {line_number} is not strict JSON: {error}") from error
    if not all(isinstance(item, Mapping) for item in decoded):
        raise AssertionError("Three Branches fixture lines must be JSON objects")
    objects = cast("list[Mapping[str, Any]]", decoded)
    return objects[0], objects[1:]


def assert_fixture_properties(header: Mapping[str, Any], states: Sequence[Mapping[str, Any]]) -> None:
    """Check the broad renderer and chat behavior that makes a recording useful."""
    if header.get("environment") != "three_branches":
        raise AssertionError("fixture header must name three_branches")
    players = _mapping(header.get("players"))
    player_ids = tuple(players)
    expected_player_ids = tuple(f"player_{index}" for index in range(len(player_ids)))
    if (
        len(player_ids) < 2
        or not all(_PLAYER_ID.fullmatch(player_id) for player_id in player_ids)
        or player_ids != expected_player_ids
    ):
        raise AssertionError(
            "fixture player roster must be contiguous canonical player_0 through player_n in order"
        )
    cast_player_ids = set(player_ids[1:])
    if not states:
        raise AssertionError("fixture needs recorded states")

    moved_players: set[str] = set()
    visitor_waved = False
    messages: list[tuple[int, Mapping[str, Any]]] = []
    for state_index, state in enumerate(states):
        overlay = _mapping(state.get("overlay"))
        characters = overlay.get("characters")
        if not isinstance(characters, Sequence) or isinstance(characters, str | bytes):
            raise AssertionError(f"fixture state {state_index} must carry an overlay character roster")
        character_records = tuple(_mapping(character) for character in characters)
        character_ids = tuple(character.get("id") for character in character_records)
        if character_ids != player_ids:
            raise AssertionError(
                f"fixture state {state_index} overlay character ids must exactly match the header roster"
            )
        for character in character_records:
            character_id = character["id"]
            moved = character.get("moved")
            if character_id in cast_player_ids and isinstance(moved, int | float) and moved > 0:
                moved_players.add(cast(str, character_id))
            expression = _mapping(character.get("expression"))
            if character_id == "player_0" and expression.get("type") == "wave":
                visitor_waved = True
        raw_messages = state.get("messages")
        if raw_messages is None:
            continue
        if not isinstance(raw_messages, Sequence) or isinstance(raw_messages, str | bytes):
            raise AssertionError(f"fixture state {state_index} messages must be a sequence")
        for raw_message in raw_messages:
            if not isinstance(raw_message, Mapping):
                raise AssertionError(f"fixture state {state_index} messages must be objects")
            message = cast("Mapping[str, Any]", raw_message)
            if "from" not in message or message.get("from") not in players:
                raise AssertionError(f"fixture state {state_index} message sender must be in the roster")
            if "to" not in message or (message.get("to") is not None and message.get("to") not in players):
                raise AssertionError(
                    f"fixture state {state_index} message recipient must be in the roster or null"
                )
            messages.append((state_index, message))

    missing = sorted(cast_player_ids - moved_players)
    if missing:
        raise AssertionError(f"fixture cast players never moved: {', '.join(missing)}")
    if not visitor_waved:
        raise AssertionError("fixture player_0 never waved")

    recorded_speech = any(
        message.get("from") == "player_0"
        and (message.get("to") is None or message.get("to") in players)
        and isinstance(message.get("text"), str)
        for _, message in messages
    )
    if not recorded_speech:
        raise AssertionError("fixture needs recorded player_0 speech")

    final_overlay = _mapping(states[-1].get("overlay"))
    if final_overlay.get("terminal") is not True:
        raise AssertionError("fixture must run to the configured terminal state")


def inspect_recording(path: Path) -> None:
    """Validate a recorded fixture through the pure semantic checker."""
    header, states = _states(path)
    assert_fixture_properties(header, states)


def _players() -> tuple[dict[str, AgentPlayer], dict[str, PlayerAttribution]]:
    parameters = resolve_parameters(ENTRY.meta)
    player_ids = resolve_layout(ENTRY.meta, parameters).players
    # Each player receives a separate policy object so one villager's entropy and chat state cannot
    # leak into another villager's decisions.
    players = {
        player_id: AgentPlayer(ScriptedVisitorAgent() if player_id == "player_0" else NaiveAgent())
        for player_id in player_ids
    }
    attribution: dict[str, PlayerAttribution] = {
        player_id: {
            "kind": "agent",
            "builtin_name": "scripted_visitor" if player_id == "player_0" else "naive",
            "label": "Scripted visitor" if player_id == "player_0" else "Naive",
        }
        for player_id in player_ids
    }
    return players, attribution


def generate(output_dir: Path = FIXTURES_DIR) -> Path:
    """Generate a valid seed-zero recording and atomically replace the destination."""
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / FIXTURE_NAME
    failures: list[str] = []
    for attempt in range(1, ATTEMPTS + 1):
        try:
            # Keeping the temporary recording beside its destination makes the final replace atomic
            # on Windows as well as POSIX filesystems.
            with tempfile.TemporaryDirectory(dir=output_dir, prefix=".three-branches-fixture-") as tmp:
                root = Path(tmp)
                recording_id = f"three-branches-fixture-{attempt}"
                players, attribution = _players()
                result = run_episode(
                    ENTRY,
                    players,
                    seed=0,
                    parameters=resolve_parameters(ENTRY.meta),
                    store=FolderRecordingStore(root),
                    recording_id=recording_id,
                    player_attribution=attribution,
                )
                source = root / recording_id / "recording.jsonl"
                inspect_recording(source)
                source.replace(destination)
                print(f"wrote {destination} ({result.ticks} ticks, reason={result.reason})")
                return destination
        except Exception as error:  # noqa: BLE001 - retries summarize entropy-sensitive misses
            failures.append(f"attempt {attempt}: {error}")
    joined = "; ".join(failures)
    raise AssertionError(f"could not generate a useful Three Branches fixture: {joined}")


def main() -> int:
    generate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
