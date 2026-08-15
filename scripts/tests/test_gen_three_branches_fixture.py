"""Deterministic semantic checks for the Three Branches renderer fixture."""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gen_three_branches_fixture as fixture  # noqa: E402
from _fixture_common import FIXTURES_DIR  # noqa: E402


def _sample() -> tuple[dict[str, object], list[dict[str, object]]]:
    header: dict[str, object] = {
        "environment": "three_branches",
        "players": {"player_0": {}, "player_1": {}, "player_2": {}},
    }
    characters = [
        {
            "id": "player_0",
            "moved": 0.0,
            "expression": {"type": "wave", "target": "none"},
        },
        {"id": "player_1", "moved": 0.2, "expression": {"type": "none", "target": "none"}},
        {"id": "player_2", "moved": 0.3, "expression": {"type": "none", "target": "none"}},
    ]
    states: list[dict[str, object]] = [
        {
            "overlay": {"characters": characters, "terminal": False},
            "messages": [{"from": "player_0", "to": "player_1", "text": "hello"}],
        },
        {
            "overlay": {"characters": characters, "terminal": True},
            "messages": [],
        },
    ]
    return header, states


def test_semantic_checker_accepts_behavior_without_pinning_ticks_or_text() -> None:
    header, states = _sample()
    fixture.assert_fixture_properties(header, states)

    states[0]["messages"] = [{"from": "player_0", "to": None, "text": "hello"}]
    fixture.assert_fixture_properties(header, states)


@pytest.mark.parametrize(
    "player_ids",
    [
        ("player_1", "player_2"),
        ("player_0", "player_2"),
        ("player_0", "player_01"),
        ("player_0", "visitor"),
        ("player_1", "player_0"),
    ],
)
def test_semantic_checker_rejects_noncanonical_header_rosters(player_ids: tuple[str, ...]) -> None:
    header, states = _sample()
    header["players"] = dict.fromkeys(player_ids, {})

    with pytest.raises(AssertionError, match="contiguous canonical player_0"):
        fixture.assert_fixture_properties(header, states)


@pytest.mark.parametrize(
    "character_ids",
    [
        ("player_0", "player_1"),
        ("player_0", "player_1", "player_1"),
        ("player_1", "player_0", "player_2"),
        ("visitor", "player_1", "player_2"),
        ("player_0", "player_01", "player_2"),
    ],
)
def test_semantic_checker_rejects_overlay_roster_drift(character_ids: tuple[str, ...]) -> None:
    header, states = _sample()
    records = copy.deepcopy(states[0]["overlay"]["characters"])  # type: ignore[index]
    changed = []
    for index, character_id in enumerate(character_ids):
        record = copy.deepcopy(records[min(index, len(records) - 1)])
        record["id"] = character_id
        changed.append(record)
    states[0]["overlay"]["characters"] = changed  # type: ignore[index]

    with pytest.raises(AssertionError, match="exactly match the header roster"):
        fixture.assert_fixture_properties(header, states)


@pytest.mark.parametrize(
    ("endpoint", "value"),
    [
        ("from", None),
        ("from", "visitor"),
        ("from", "player_01"),
        ("to", "npc_0"),
        ("to", "player_3"),
    ],
)
def test_semantic_checker_rejects_invalid_message_endpoints(endpoint: str, value: object) -> None:
    header, states = _sample()
    states[0]["messages"][0][endpoint] = value  # type: ignore[index]

    with pytest.raises(AssertionError, match="message (sender|recipient)"):
        fixture.assert_fixture_properties(header, states)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ("movement", "never moved"),
        ("wave", "never waved"),
        ("speech", "recorded player_0 speech"),
        ("terminal", "terminal state"),
    ],
)
def test_semantic_checker_reports_missing_fixture_behavior(change: str, message: str) -> None:
    header, states = _sample()
    changed = copy.deepcopy(states)
    if change == "movement":
        for state in changed:
            state["overlay"]["characters"][2]["moved"] = 0.0  # type: ignore[index]
    elif change == "wave":
        for state in changed:
            state["overlay"]["characters"][0]["expression"]["type"] = "none"  # type: ignore[index]
    elif change == "speech":
        changed[0].pop("messages")
    else:
        changed[-1]["overlay"]["terminal"] = False  # type: ignore[index]

    with pytest.raises(AssertionError, match=message):
        fixture.assert_fixture_properties(header, changed)


def test_checked_in_fixture_has_the_required_semantics() -> None:
    fixture.inspect_recording(FIXTURES_DIR / fixture.FIXTURE_NAME)


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_recording_reader_rejects_non_finite_json_numbers(tmp_path: Path, constant: str) -> None:
    path = tmp_path / "recording.jsonl"
    path.write_text(
        '{"environment":"three_branches","players":{"player_0":{},"player_1":{}}}\n'
        f'{{"overlay":{{"characters":[],"terminal":true}},"value":{constant}}}\n',
        encoding="utf-8",
    )

    with pytest.raises(AssertionError, match="not strict JSON.*non-finite"):
        fixture.inspect_recording(path)
