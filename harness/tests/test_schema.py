"""Validator behavior: valid passes, closed regions reject, the open overlay accepts anything."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from game_sandbox_harness.environment import ResolvedLayout, ResolvedSeat
from game_sandbox_harness.schema import (
    SchemaValidationError,
    validate_header,
    validate_step,
)
from game_sandbox_harness.state import build_agent_step, build_header, build_step_state

SINGLE_LAYOUT = ResolvedLayout("solo", (ResolvedSeat("seat_0", ("player_0",)),), 1, 1)


def _valid_state():
    return build_step_state(
        tick=0,
        agents={"player_0": build_agent_step(reward=1.0, score=1.0, decision_ms=2.5)},
        started_at=1_700_000_000_000,
        duration_ms=3.0,
    )


def test_valid_state_passes():
    validate_step(_valid_state())


def test_valid_header_passes():
    validate_header(
        build_header(
            environment="flappy",
            parameters={"players": 1, "pipe_gap": 100},
            seed=7,
            players={
                "player_0": {
                    "kind": "agent",
                    "builtin_name": "naive",
                    "label": "Naive agent",
                }
            },
            layout=SINGLE_LAYOUT,
        )
    )


@pytest.mark.parametrize(
    "seats",
    [
        {"seat_0": ["player_0"], "seat_1": ["player_0"]},
        {"seat_0": ["player_1"]},
    ],
)
def test_header_rejects_a_seat_partition_that_disagrees_with_players(seats: dict[str, list[str]]):
    header = build_header(
        environment="flappy",
        parameters={"players": 1, "pipe_gap": 100},
        players={
            "player_0": {
                "kind": "agent",
                "builtin_name": "naive",
                "label": "Naive agent",
            }
        },
        layout=SINGLE_LAYOUT,
    )
    header["seats"] = seats
    with pytest.raises(SchemaValidationError):
        validate_header(header)


def test_closed_region_rejects_unknown_top_level_field():
    state = _valid_state()
    state["bogus"] = True  # type: ignore[typeddict-unknown-key]
    with pytest.raises(SchemaValidationError):
        validate_step(state)


def test_closed_region_rejects_unknown_agent_field():
    state = _valid_state()
    state["agents"]["player_0"]["bogus"] = 1  # type: ignore[typeddict-unknown-key]
    with pytest.raises(SchemaValidationError):
        validate_step(state)


def test_overlay_accepts_arbitrary_content():
    state = _valid_state()
    state["overlay"] = {"pipes": [{"x": 100, "gap_y": 50}], "anything": [1, 2, 3]}
    validate_step(state)


def test_wrong_schema_version_rejected():
    state = _valid_state()
    state["schema_version"] = 2
    with pytest.raises(SchemaValidationError):
        validate_step(state)


def test_missing_required_agent_field_rejected():
    state = _valid_state()
    del state["agents"]["player_0"]["score"]  # type: ignore[misc]
    with pytest.raises(SchemaValidationError):
        validate_step(state)


def test_message_shape_validates():
    state = _valid_state()
    state["messages"] = [{"from": "player_0", "to": None, "text": "hi"}]
    validate_step(state)


def test_relocated_package_loads_packaged_schema_resources():
    """The copied student package must not retain the monorepo package name."""
    source = Path(__file__).parents[1] / "src" / "game_sandbox_harness"
    with TemporaryDirectory() as raw:
        root = Path(raw)
        package = root / "sandbox" / "harness"
        package.parent.mkdir()
        (package.parent / "__init__.py").write_text("", encoding="utf-8")
        shutil.copytree(source, package)
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from sandbox.harness.schema import validate_header; "
                "validate_header({'schema_version': 1, 'environment': 'fake', "
                "'parameters': {'players': 1}, 'seed': 1, "
                "'players': {'player_0': {'kind': 'agent', 'builtin_name': 'naive', "
                "'label': 'Naive agent'}}, "
                "'seats': {'seat_0': ['player_0']}, 'seat_plan': 'solo'})",
            ],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
        )
    assert result.returncode == 0, result.stderr
