"""Environment metadata serialization and entry-point discovery."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from game_sandbox_harness.environment import (
    BuiltinAgent,
    EnvironmentEntry,
    EnvironmentLookupError,
    EnvironmentMeta,
    EnvParameter,
    EnvParameterChoice,
    EnvParameterValueError,
    EnvPreset,
    PlayerBounds,
    SeatDeclaration,
    SeatPlan,
    SeatPlans,
    discover_environments,
    effective_parameters,
    load_environment,
    preset_values,
    resolve_layout,
    resolve_parameters,
)
from game_sandbox_harness.schema import validate_environment_meta

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "schema" / "fixtures"


def _meta() -> EnvironmentMeta:
    return EnvironmentMeta(
        env_id="demo",
        display_name="Demo",
        description="A demo environment.",
        stepping="sequential",
        builtin_agents=(BuiltinAgent("naive", "Naive"),),
        layout=PlayerBounds(1, 1),
        human_players=("player_0",),
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


def test_meta_to_json_round_trips():
    meta = replace(
        _meta(),
        pace_interval_ms=250,
        view_interval_ms=120,
        live_interval_ms=80,
        human_pause="playback",
        seat_order_matters=True,
    )
    blob = json.dumps(meta.to_json())
    parsed = json.loads(blob)
    validate_environment_meta(parsed)
    assert parsed["env_id"] == "demo"
    assert parsed["stepping"] == "sequential"
    assert parsed["builtin_agents"] == [{"name": "naive", "label": "Naive"}]
    assert parsed["human_players"] == ["player_0"]  # tuple serialized as a JSON array
    assert parsed["human_timeout_ms"] is None
    assert parsed["pace_interval_ms"] == 250
    assert parsed["view_interval_ms"] == 120
    assert parsed["live_interval_ms"] == 80
    assert parsed["human_pause"] == "playback"
    assert parsed["seat_order_matters"] is True
    assert parsed["parameters"][0]["name"] == "players"
    assert parsed["presets"] == []


def test_preset_serializes_llm_and_rejects_non_bool():
    preset = EnvPreset("llm_season", "LLM season", {}, llm=True)
    assert preset.to_json()["llm"] is True
    with pytest.raises(ValueError, match="llm must be a bool"):
        EnvPreset("bad", "Bad", {}, llm="yes")  # type: ignore[arg-type]


def test_preset_rejects_non_mapping_values():
    with pytest.raises(ValueError, match="values must be a parameter-value mapping"):
        EnvPreset("invalid", "Invalid", None)  # type: ignore[arg-type]


def test_meta_serializes_and_resolves_presets():
    meta = replace(
        _meta(),
        layout=PlayerBounds(1, 3),
        parameters=(EnvParameter("terrain", "Terrain", "Enables terrain.", "bool", False),),
        presets=(EnvPreset("duel", "Duel", {"players": 2, "terrain": True}),),
    )
    assert meta.to_json()["presets"] == [
        {"name": "duel", "title": "Duel", "values": {"players": 2, "terrain": True}, "llm": False}
    ]
    preset_layer = meta.presets[0].values
    assert resolve_parameters(meta, preset_layer) == {"players": 2, "terrain": True}
    # The explicit layer wins for terrain while the preset's non-default players value survives.
    assert resolve_parameters(meta, preset_layer, {"terrain": False}) == {
        "players": 2,
        "terrain": False,
    }


def test_preset_example_serializes_only_when_set():
    assert EnvPreset("duel", "Duel", {}, example="banner").to_json() == {
        "name": "duel",
        "title": "Duel",
        "values": {},
        "llm": False,
        "example": "banner",
    }
    assert "example" not in EnvPreset("duel", "Duel", {}).to_json()
    with pytest.raises(ValueError, match="preset example must be a non-empty string"):
        EnvPreset("duel", "Duel", {}, example="")


def test_meta_rejects_preset_llm_when_environment_declares_llm_false():
    with pytest.raises(ValueError, match=r"enables the LLM "):
        replace(_meta(), presets=(EnvPreset("duel", "Duel", {}, llm=True),))


def test_meta_accepts_preset_llm_when_environment_declares_llm_true():
    meta = replace(
        _meta(),
        llm=True,
        presets=(EnvPreset("duel", "Duel", {}, llm=True),),
    )
    assert meta.presets[0].llm is True


def test_preset_values_looks_up_by_name():
    meta = replace(
        _meta(),
        layout=PlayerBounds(1, 2),
        presets=(EnvPreset("duel", "Duel", {"players": 2}),),
    )
    assert preset_values(meta, "duel") == {"players": 2}
    with pytest.raises(ValueError) as error:
        preset_values(meta, "other")
    message = str(error.value)
    assert "other" in message
    assert "duel" in message


def test_meta_rejects_duplicate_preset_names():
    presets = (EnvPreset("duel", "Duel", {}), EnvPreset("duel", "Again", {}))
    with pytest.raises(ValueError, match="preset names must be unique"):
        replace(_meta(), presets=presets)


def test_meta_rejects_unknown_human_pause():
    with pytest.raises(ValueError, match="human_pause"):
        replace(_meta(), human_pause="unknown")  # type: ignore[arg-type]


@pytest.mark.parametrize("values", [{"players": 2}, {"unknown": True}])
def test_meta_rejects_presets_with_invalid_parameter_values(values: dict[str, object]):
    with pytest.raises(ValueError, match="invalid parameter values"):
        replace(_meta(), presets=(EnvPreset("invalid", "Invalid", values),))


def test_load_environment_unknown_id_raises():
    with pytest.raises(EnvironmentLookupError, match="no environment registered as 'nope'"):
        load_environment("nope")


def test_stepping_is_required_and_simultaneous_timing_is_coherent():
    values = dict(_meta().__dict__)
    values.pop("stepping")
    with pytest.raises(TypeError, match="stepping"):
        EnvironmentMeta(**values)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="sequential.*simultaneous"):
        replace(_meta(), stepping="unknown")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="pace_interval_ms"):
        replace(_meta(), stepping="simultaneous", pace_interval_ms=None)
    with pytest.raises(ValueError, match="positive"):
        replace(_meta(), stepping="simultaneous", pace_interval_ms=0)
    with pytest.raises(ValueError, match="human_timeout_ms"):
        replace(_meta(), stepping="simultaneous", human_timeout_ms=1000)


@pytest.mark.parametrize("pace_interval_ms", [1.5, True])
def test_sequential_pace_rejects_non_integer_wire_values(pace_interval_ms: object):
    with pytest.raises(ValueError, match="JSON-safe integer"):
        replace(_meta(), pace_interval_ms=pace_interval_ms)  # type: ignore[arg-type]


def test_discovery_rejects_name_envid_mismatch(monkeypatch):
    from game_sandbox_harness import environment as env_mod

    entry = EnvironmentEntry(meta=_meta(), make=lambda _parameters: None, default_action=lambda env, s: 0)

    class _FakeEP:
        name = "mismatch"  # != meta.env_id ("demo")

        def load(self):
            return entry

    monkeypatch.setattr(env_mod, "entry_points", lambda group: [_FakeEP()])
    with pytest.raises(ValueError, match="meta.env_id"):
        discover_environments()


def _fixture_meta() -> EnvironmentMeta:
    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "schema" / "fixtures" / "parameter-values.json").read_text()
    )
    declarations = []
    for raw in fixture["declarations"]:
        if raw["name"] == "players":
            continue
        choices = tuple(EnvParameterChoice(**choice) for choice in raw.get("choices", []))
        declarations.append(
            EnvParameter(
                name=raw["name"],
                title=raw["title"],
                description=raw["description"],
                type=raw["type"],
                default=raw["default"],
                min=raw.get("min"),
                max=raw.get("max"),
                choices=choices,
            )
        )
    return replace(_meta(), layout=PlayerBounds(1, 4), parameters=tuple(declarations))


def test_parameter_values_match_the_shared_cross_language_fixture():
    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "schema" / "fixtures" / "parameter-values.json").read_text()
    )
    meta = _fixture_meta()
    declarations = {parameter.name: parameter for parameter in effective_parameters(meta)}
    for case in fixture["validation_cases"]:
        declaration = declarations[case["name"]]
        if case["valid"]:
            assert declaration.validate_value(case["value"]) == case["normalized"]
        else:
            with pytest.raises(EnvParameterValueError):
                declaration.validate_value(case["value"])

    # The synthesized `players` declaration is compared against the fixture's hand-written copy, so the
    # bounds and the maximum default are pinned by the shared file rather than only by the code
    # that produces them. `_fixture_meta` drops the fixture entry and sets player bounds, so this
    # really exercises the synthesis.
    players_fixture = next(raw for raw in fixture["declarations"] if raw["name"] == "players")
    assert declarations["players"].to_json() == players_fixture

    for case in fixture["resolution_cases"]:
        assert resolve_parameters(meta, *case["layers"]) == case["values"]

    # Python raises on a rejected entry where TypeScript collects it as an issue; the shared file names
    # the same rejected entries and each side asserts rejection in its own terms.
    for case in fixture["rejection_cases"]:
        with pytest.raises(EnvParameterValueError):
            resolve_parameters(meta, case["layer"])


@pytest.mark.parametrize("name", ["players", "seat_plan"])
def test_parameter_declarations_reject_reserved_names(name):
    with pytest.raises(ValueError, match="reserved"):
        EnvParameter(name, "Layout", "No.", "string", "x")


def test_parameter_declarations_reject_invalid_shapes():
    with pytest.raises(ValueError, match="unique"):
        EnvParameter(
            "mode",
            "Mode",
            "Select.",
            "choice",
            "one",
            choices=(EnvParameterChoice("one", "One"), EnvParameterChoice("one", "Again")),
        )
    with pytest.raises(ValueError, match="choices"):
        EnvParameter("mode", "Mode", "Select.", "choice", "one", choices=("one",))  # type: ignore[arg-type]
    float_parameter = EnvParameter("weight", "Weight", "Value.", "float", 1.0, min=0.0, max=2.0)
    with pytest.raises(EnvParameterValueError):
        float_parameter.validate_value(10**1000)


def test_builtin_agents_require_a_unique_naive_baseline_and_valid_entries():
    with pytest.raises(ValueError, match="at least one"):
        replace(_meta(), builtin_agents=())
    with pytest.raises(ValueError, match="first builtin"):
        replace(_meta(), builtin_agents=(BuiltinAgent("cautious", "Cautious"),))
    with pytest.raises(ValueError, match="unique"):
        replace(
            _meta(),
            builtin_agents=(BuiltinAgent("naive", "Naive"), BuiltinAgent("naive", "Again")),
        )
    with pytest.raises(ValueError, match="snake_case"):
        BuiltinAgent("Not snake", "Naive")
    with pytest.raises(ValueError, match="non-empty"):
        BuiltinAgent("naive", "")


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


def _resolved_layout_json(meta: EnvironmentMeta, parameters: dict[str, object]) -> dict[str, object]:
    layout = resolve_layout(meta, parameters)  # type: ignore[arg-type]
    return {
        "plan_key": layout.plan_key,
        "seats": [
            {
                "seat_id": seat.seat_id,
                "players": list(seat.players),
                "restricted_builtin": seat.restricted_builtin,
            }
            for seat in layout.seats
        ],
        "player_count": layout.player_count,
        "seat_count": layout.seat_count,
    }


def test_layout_values_match_the_shared_cross_language_fixture():
    fixture = json.loads((FIXTURES_DIR / "layout-values.json").read_text(encoding="utf-8"))

    for case in fixture["valid"]:
        meta = replace(
            _meta(),
            layout=_layout_from_fixture(case["meta"]["layout"]),
            human_players=tuple(case["meta"]["human_players"]),
        )
        assert _resolved_layout_json(meta, case["parameters"]) == case["layout"], case["name"]

    for case in fixture["invalid"]:
        raw_layout = case["layout"]
        layout = (
            _layout_from_fixture(raw_layout)
            if (
                raw_layout.get("kind") == "player_bounds"
                and set(raw_layout) == {"kind", "min", "max"}
                or raw_layout.get("kind") == "seat_plans"
                and set(raw_layout) == {"kind", "plans"}
            )
            else raw_layout
        )
        with pytest.raises(ValueError):
            replace(_meta(), layout=layout)  # type: ignore[arg-type]
