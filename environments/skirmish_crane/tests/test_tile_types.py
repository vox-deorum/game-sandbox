"""Regression tests for the shared tile-type source and its validation."""

from __future__ import annotations

from typing import Any

import pytest

from skirmish_crane.ascii_runner import _TILE_MARKS
from skirmish_crane.hexes import Tile
from skirmish_crane.tile_types import (
    FEATURE_SCATTER,
    FEATURES,
    TERRAIN_SCATTER,
    TERRAINS,
    TILE_CODES,
    load,
)


def _document() -> dict[str, Any]:
    """A small valid document, so each test can break exactly one rule."""
    return {
        "terrains": {
            "grass": {"passable": True, "move_cost": 1},
            "void": {"passable": False, "move_cost": 0},
        },
        "features": {
            "none": {"move_cost_delta": 0, "entry_damage": 0},
            "bog": {"move_cost_delta": 1, "entry_damage": 1},
        },
        "scatter": {
            "terrain": {"die": 4, "default": "grass", "rolls": []},
            "feature": {
                "die": 4,
                "default": "none",
                "rolls": [{"roll": 0, "value": "bog", "requires_parameter": "swamps"}],
            },
        },
        "tile_codes": {"grass": {"none": "g", "bog": "b"}, "void": {"none": "v"}},
    }


def test_a_valid_document_loads_into_the_declared_tables() -> None:
    types = load(_document())
    assert types.terrains["grass"].move_cost == 1
    assert types.features["bog"].entry_damage == 1
    assert types.codes == {("grass", "none"): "g", ("grass", "bog"): "b", ("void", "none"): "v"}


def test_a_gated_scatter_value_needs_its_parameter() -> None:
    feature = load(_document()).feature_scatter
    assert feature.value_for(0, {"swamps": True}) == "bog"
    assert feature.value_for(0, {"swamps": False}) == "none"
    # A roll matching no entry always takes the default.
    assert feature.value_for(3, {"swamps": True}) == "none"


@pytest.mark.parametrize(
    ("break_it", "message"),
    (
        (lambda doc: doc["tile_codes"]["grass"].update(bog="g"), "repeat a character"),
        (lambda doc: doc["tile_codes"]["grass"].update(fen="x"), "undeclared feature"),
        (lambda doc: doc["tile_codes"]["grass"].pop("bog"), "every terrain and feature pairing"),
        (lambda doc: doc["tile_codes"]["void"].update(bog="x"), "every terrain and feature pairing"),
        (lambda doc: doc["tile_codes"]["grass"].update(bog="bb"), "one character"),
        (
            lambda doc: doc["scatter"]["feature"]["rolls"].append({"roll": 9, "value": "bog"}),
            "outside its die",
        ),
        (
            lambda doc: doc["scatter"]["feature"]["rolls"].append({"roll": 0, "value": "none"}),
            "repeats a roll",
        ),
        (lambda doc: doc["scatter"]["terrain"]["rolls"].append({"roll": 1, "value": "void"}), "passable"),
        (lambda doc: doc["scatter"]["feature"].update(default="fen"), "is not declared"),
        (lambda doc: doc["features"].pop("none"), "none feature"),
    ),
)
def test_a_malformed_document_is_rejected(break_it: Any, message: str) -> None:
    document = _document()
    break_it(document)
    with pytest.raises(ValueError, match=message):
        load(document)


def test_the_shipped_registry_pins_the_ruleset_numbers() -> None:
    assert TERRAINS["grass"].move_cost == 1 and TERRAINS["grass"].passable
    assert TERRAINS["hill"].move_cost == 2 and TERRAINS["hill"].passable
    assert not TERRAINS["water"].passable and not TERRAINS["void"].passable
    assert FEATURES["none"].move_cost_delta == 0
    assert FEATURES["forest"].move_cost_delta == 1
    assert FEATURES["marsh"].move_cost_delta == 2
    # Wasteland prices nothing in movement and takes its toll in hit points instead.
    assert FEATURES["waste"].move_cost_delta == 0
    assert FEATURES["waste"].entry_damage == 2
    assert all(feature.entry_damage == 0 for name, feature in FEATURES.items() if name != "waste")


def test_the_shipped_registry_scatters_each_kind_at_one_in_twenty() -> None:
    assert TERRAIN_SCATTER.die == 20 and TERRAIN_SCATTER.default == "grass"
    assert [(entry.roll, entry.value) for entry in TERRAIN_SCATTER.rolls] == [(0, "hill")]
    assert FEATURE_SCATTER.die == 20 and FEATURE_SCATTER.default == "none"
    assert [(entry.roll, entry.value) for entry in FEATURE_SCATTER.rolls] == [
        (0, "forest"),
        (1, "marsh"),
        (2, "waste"),
    ]
    # Only wasteland waits on a season parameter.
    assert [entry.value for entry in FEATURE_SCATTER.rolls if entry.requires_parameter] == ["waste"]


def test_every_passable_pairing_has_a_code_and_an_ascii_glyph() -> None:
    expected = {
        (terrain, feature)
        for terrain, properties in TERRAINS.items()
        for feature in (FEATURES if properties.passable else ("none",))
    }
    assert set(TILE_CODES) == expected
    assert TILE_CODES["grass", "waste"] == "s"
    assert TILE_CODES["hill", "waste"] == "S"
    assert set(_TILE_MARKS) == set(TILE_CODES.values())


def test_tiles_read_their_properties_from_the_registry() -> None:
    assert Tile().move_cost == 1
    assert Tile("hill").move_cost == 2
    assert Tile("grass", "waste").move_cost == 1
    assert Tile("grass", "waste").entry_damage == 2
    assert Tile("grass", "forest").entry_damage == 0
    assert not Tile("water").passable
    with pytest.raises(ValueError, match="impassable"):
        _ = Tile("void").move_cost
