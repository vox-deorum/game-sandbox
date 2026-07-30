"""Validator behavior: valid passes, closed regions reject, the open overlay accepts anything."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentMeta,
    PlayerBounds,
    ResolvedLayout,
    ResolvedSeat,
    SeatDeclaration,
    SeatPlan,
    SeatPlans,
    discover_environments,
)
from game_sandbox_harness.schema import (
    SchemaValidationError,
    validate_environment_meta,
    validate_header,
    validate_step,
)
from game_sandbox_harness.state import build_agent_step, build_header, build_step_state

SINGLE_LAYOUT = ResolvedLayout("solo", (ResolvedSeat("seat_0", ("player_0",)),), 1, 1)

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "schema" / "fixtures"


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


def _fixture_meta(*, layout: PlayerBounds | SeatPlans, human_players: tuple[str, ...]) -> EnvironmentMeta:
    """Build a minimal, otherwise-valid metadata object around one fixture layout."""
    return EnvironmentMeta(
        env_id="demo",
        display_name="Demo",
        description="A demo environment.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive"),),
        layout=layout,
        human_players=human_players,
        human_timeout_ms=None,
        recommended_episode_ticks=1000,
        pace_interval_ms=50,
        step_limit_ms=1000,
        episode_limit_ms=120_000,
        messaging=False,
        message_cap=None,
        llm=False,
        renderer="demo",
    )


def _layout_from_fixture(raw: dict[str, object]) -> PlayerBounds | SeatPlans:
    if raw["kind"] == "player_bounds":
        return PlayerBounds(min=raw["min"], max=raw["max"])  # type: ignore[arg-type]
    plans = tuple(
        SeatPlan(
            key=plan["key"],
            title=plan["title"],
            seats=tuple(
                SeatDeclaration(
                    players=tuple(seat["players"]),
                    restricted_builtin=seat.get("restricted_builtin"),
                )
                for seat in plan["seats"]
            ),
        )
        for plan in raw["plans"]  # type: ignore[union-attr]
    )
    return SeatPlans(plans)


def test_validate_environment_meta_accepts_every_discovered_environment():
    """The schema is a conformance check beside the dataclass, so real environments must pass it."""
    for entry in discover_environments().values():
        validate_environment_meta(entry.meta.to_json())


def test_validate_environment_meta_accepts_every_valid_layout_fixture():
    fixture = json.loads((FIXTURES_DIR / "layout-values.json").read_text(encoding="utf-8"))
    for case in fixture["valid"]:
        meta = _fixture_meta(
            layout=_layout_from_fixture(case["meta"]["layout"]),
            human_players=tuple(case["meta"]["human_players"]),
        )
        validate_environment_meta(meta.to_json())


# These fixture cases are rejected only by a cross-field rule: a seat plan's key uniqueness, its
# restricted-seat count, its player partition, or a restriction naming a declared builtin agent. None
# of that is expressible in a flat JSON Schema, so the generated schema does not catch it on its own;
# `EnvironmentMeta.__post_init__` and the TypeScript guard both still enforce every one of these. This
# schema validates shape, not every business rule, which is why it is a check beside the dataclass
# rather than a replacement for it.
_SEMANTIC_ONLY_INVALID_LAYOUT_CASES = frozenset(
    {
        "duplicate plan key",
        "gap",
        "nonzero start",
        "undeclared restricted builtin",
        "two restricted seats",
        "only restricted seat",
    }
)


def test_validate_environment_meta_rejects_structurally_invalid_layout_fixtures():
    fixture = json.loads((FIXTURES_DIR / "layout-values.json").read_text(encoding="utf-8"))
    base = discover_environments()["flappy_bird"].meta.to_json()
    for case in fixture["invalid"]:
        if case["name"] in _SEMANTIC_ONLY_INVALID_LAYOUT_CASES:
            continue
        payload = {**base, "layout": case["layout"]}
        with pytest.raises(SchemaValidationError):
            validate_environment_meta(payload)


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
