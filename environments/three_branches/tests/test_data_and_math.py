from __future__ import annotations

import json
from copy import deepcopy
from importlib import resources

import pytest

from three_branches.catalog import CATALOG
from three_branches.catalog import load as load_catalog
from three_branches.geometry import Circle, Rect, distance, nearest_point, point_in_cone, wrap
from three_branches.grid import Grid
from three_branches.rules import FRAME, RULES
from three_branches.rules import load as load_rules


def test_shipped_static_tables_match_the_ruleset() -> None:
    assert (FRAME.cells_x, FRAME.cells_y, FRAME.cell_size) == (100, 100, 1.0)
    assert tuple(ground.code for ground in RULES.grounds) == (
        "r",
        "p",
        "b",
        "g",
        "i",
        "d",
        "f",
        "e",
        "w",
        "x",
    )
    assert RULES.emotes == (
        "wave",
        "nod",
        "shake_head",
        "point",
        "laugh",
        "shrug",
        "startle",
        "sleep",
        "sweep",
    )
    assert RULES.day_ticks == 1200
    assert RULES.physics_substeps == 3
    assert [item.token for item in CATALOG.props] == [
        "stall",
        "lantern",
        "bench",
        "shrine",
        "board",
        "plot",
        "hearth",
        "repair_bench",
        "pump",
        "bell",
    ]


def test_loaders_reject_unknown_and_invalid_contract_data() -> None:
    rules = {
        "frame": {"cells_x": 2, "cells_y": 2, "cell_size": 1},
        "grounds": [
            {"code": "g", "name": "ground", "speed": 1, "passable": True, "blocks_sight": False},
            {"code": "x", "name": "wall", "speed": 0, "passable": False, "blocks_sight": True},
        ],
        "fill": "g",
        "emotes": [str(index) for index in range(9)],
        "profile": {
            "body_radius": 1,
            "vision_degrees": 1,
            "vision_range": 1,
            "hearing_range": 1,
            "prop_reach": 1,
        },
        "phases": [{"name": "day", "start": 1, "end": 1}],
        "off_phase": "day",
        "day_ticks": 1,
        "physics_substeps": 1,
    }
    bad_rules = deepcopy(rules)
    bad_rules["extra"] = True
    with pytest.raises(ValueError):
        load_rules(bad_rules)
    bad_rules = deepcopy(rules)
    bad_rules["grounds"][1]["code"] = "g"
    with pytest.raises(ValueError):
        load_rules(bad_rules)
    # Layout geometry reads a cell index as a metre coordinate, so any other scale is refused.
    bad_rules = deepcopy(rules)
    bad_rules["frame"]["cell_size"] = 2
    with pytest.raises(ValueError):
        load_rules(bad_rules)

    catalog = {"buildings": [], "props": [], "scenery": []}
    with pytest.raises(ValueError):
        load_catalog(catalog)
    # A transition needs exactly two states, which is what makes `active_state` the other one.
    shipped = json.loads(
        resources.files("three_branches").joinpath("catalog.json").read_text(encoding="utf-8")
    )
    bad_catalog = deepcopy(shipped)
    bad_catalog["props"][0]["states"] = [bad_catalog["props"][0]["start"]]
    with pytest.raises(ValueError):
        load_catalog(bad_catalog)


def test_the_grid_refuses_a_ground_code_the_rules_do_not_define() -> None:
    with pytest.raises(ValueError):
        Grid(FRAME, [["q"] * FRAME.cells_x for _ in range(FRAME.cells_y)])


def test_grid_conversion_flood_and_supercover() -> None:
    grid = Grid(FRAME, (("g",) * FRAME.cells_x for _ in range(FRAME.cells_y)))
    assert grid.cell_at((0.0, 0.0)) == (0, 0)
    assert grid.cell_at((99.999, 99.999)) == (99, 99)
    assert grid.cell_at((100.0, 2.0)) is None
    assert grid.center((4, 7)) == (4.5, 7.5)
    assert grid.flood((0, 0), lambda cell: cell[0] < 2 and cell[1] < 2) == {(0, 0), (1, 0), (0, 1), (1, 1)}
    assert grid.supercover((0.5, 0.5), (2.5, 2.5)) == (
        (0, 0),
        (1, 0),
        (0, 1),
        (1, 1),
        (2, 1),
        (1, 2),
        (2, 2),
    )
    # An integer endpoint travelling southwest is touched during a corner crossing.
    # It must finish the ray rather than allowing the traversal to step past it.
    assert grid.supercover((7.55, 64.5), (16.0, 56.0))[-1] == (16, 56)


def test_geometry_boundaries_and_nearest_shapes() -> None:
    assert wrap(360.0) == 0.0
    assert distance((0.0, 0.0), (3.0, 4.0)) == 5.0
    assert point_in_cone((0.0, 0.0), 0.0, (1.0, 1.7320508075688772), 120.0, 2.0)
    assert not point_in_cone((0.0, 0.0), 0.0, (-0.01, 0.0), 120.0, 2.0)
    assert nearest_point((4.0, 1.0), Rect(0.0, 0.0, 2.0, 2.0)) == (2.0, 1.0)
    assert nearest_point((3.0, 0.0), Circle(0.0, 0.0, 1.0)) == (1.0, 0.0)
