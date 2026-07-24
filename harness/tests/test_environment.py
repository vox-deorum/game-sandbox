"""Environment metadata serialization and entry-point discovery."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from game_sandbox_harness.environment import (
    EnvironmentEntry,
    EnvironmentLookupError,
    EnvironmentMeta,
    EnvParameter,
    EnvParameterChoice,
    EnvParameterValueError,
    discover_environments,
    effective_parameters,
    load_environment,
    resolve_parameters,
)


def _meta() -> EnvironmentMeta:
    return EnvironmentMeta(
        env_id="demo",
        display_name="Demo",
        description="A demo environment.",
        min_slots=1,
        max_slots=1,
        human_slots=("player_0",),
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
    meta = _meta()
    blob = json.dumps(meta.to_json())
    parsed = json.loads(blob)
    assert parsed["env_id"] == "demo"
    assert parsed["human_slots"] == ["player_0"]  # tuple serialized as a JSON array
    assert parsed["human_timeout_ms"] is None
    assert parsed["pace_interval_ms"] == 50
    assert parsed["seat_order_matters"] is False
    assert parsed["view_interval_ms"] is None  # defaulted, present in the serialized shape
    assert parsed["live_interval_ms"] is None  # defaulted, present in the serialized shape
    assert parsed["parameters"][0]["name"] == "seats"


def test_flappy_bird_is_discoverable():
    found = discover_environments()
    assert "flappy_bird" in found
    entry = found["flappy_bird"]
    assert entry.meta.env_id == "flappy_bird"
    assert entry.meta.human_slots == ("player_0",)
    # The metadata is serialisable end to end.
    json.dumps(entry.meta.to_json())


def test_load_environment_unknown_id_raises():
    with pytest.raises(EnvironmentLookupError, match="no environment registered as 'nope'"):
        load_environment("nope")


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
        if raw["name"] == "seats":
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
    return EnvironmentMeta(
        **{
            **_meta().__dict__,
            "min_slots": 1,
            "max_slots": 4,
            "parameters": tuple(declarations),
        }
    )


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

    # The synthesized `seats` declaration is compared against the fixture's hand-written copy, so the
    # bounds and the `max_slots` default are pinned by the shared file rather than only by the code
    # that produces them. `_fixture_meta` drops the fixture entry and sets min_slots/max_slots, so this
    # really exercises the synthesis.
    seats_fixture = next(raw for raw in fixture["declarations"] if raw["name"] == "seats")
    assert declarations["seats"].to_json() == seats_fixture

    for case in fixture["resolution_cases"]:
        assert resolve_parameters(meta, *case["layers"]) == case["values"]

    # Python raises on a rejected entry where TypeScript collects it as an issue; the shared file names
    # the same rejected entries and each side asserts rejection in its own terms.
    for case in fixture["rejection_cases"]:
        with pytest.raises(EnvParameterValueError):
            resolve_parameters(meta, case["layer"])


def test_parameter_declarations_reject_reserved_names_and_invalid_shapes():
    with pytest.raises(ValueError, match="reserved"):
        EnvironmentMeta(
            **{
                **_meta().__dict__,
                "parameters": (EnvParameter("seats", "Seats", "No.", "int", 1, min=1, max=1),),
            }
        )
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
