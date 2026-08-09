"""Focused physics pins for the fixture collision world."""

from __future__ import annotations

import pymunk
import pytest

from three_branches.engine import Day, DayConfig, Order
from three_branches.fixture import FIXTURE_VILLAGE
from three_branches.geometry import add, heading_vector
from three_branches.physics import Physics
from three_branches.rules import PROFILE


def _physics(positions: dict[str, tuple[float, float]]) -> Physics:
    return Physics(FIXTURE_VILLAGE, positions)


def _place(day: Day, character_id: str, position: tuple[float, float]) -> None:
    day.characters[character_id].position = position
    day.physics.bodies[character_id].position = position


def test_speed_zero_character_is_static_and_a_mover_slides_to_a_stop() -> None:
    physics = _physics({"mover": (40.0, 25.0), "stander": (41.0, 25.0)})
    result = physics.step({"mover": (1.0, 0.0), "stander": (0.0, 0.0)}, {"stander"})
    assert result["stander"] == pytest.approx((41.0, 25.0))
    assert 40.0 < result["mover"][0] < 40.3


def test_equal_mass_movers_share_contact_and_slide_along_a_prop_face() -> None:
    pair = _physics({"left": (40.0, 25.0), "right": (41.0, 25.0)})
    result = pair.step({"left": (1.0, 0.0), "right": (-1.0, 0.0)}, set())
    assert result["left"][0] > 40.1
    assert result["right"][0] < 40.9
    sliding = _physics({"mover": (39.0, 30.0)})
    result = sliding.step({"mover": (1.0, 1.0)}, set())["mover"]
    assert result[0] > 39.2
    assert result[1] < 30.9


def test_maximum_speed_does_not_tunnel_through_a_prop_or_water_bank() -> None:
    prop = _physics({"mover": (40.0, 30.0)})
    assert prop.step({"mover": (0.0, 1.0)}, set())["mover"][1] < 30.9
    bank = _physics({"mover": (46.0, 40.0)})
    assert bank.step({"mover": (1.0, 0.0)}, set())["mover"][0] < 47.2


@pytest.mark.parametrize(
    ("blocked", "clear"),
    (
        ((0.44, 50.0), (0.46, 50.0)),
        ((4.56, 65.0), (4.54, 65.0)),
        ((47.06, 40.0), (47.04, 40.0)),
        # The bell's northeast corner: inside the corner wedge a sharp inflated rectangle would
        # over-block, just past the true rounded corner the physics circle test allows.
        ((16.55, 29.55), (16.6, 29.6)),
    ),
)
def test_body_clear_matches_physics_segment_radius(
    blocked: tuple[float, float], clear: tuple[float, float]
) -> None:
    physics = _physics({})
    assert not FIXTURE_VILLAGE.body_clear(blocked)
    assert physics.space.point_query_nearest(blocked, PROFILE.body_radius, pymunk.ShapeFilter()) is not None
    assert FIXTURE_VILLAGE.body_clear(clear)
    assert physics.space.point_query_nearest(clear, PROFILE.body_radius, pymunk.ShapeFilter()) is None


def test_decks_pass_motion_while_boundaries_and_walls_confine_it() -> None:
    bridge = FIXTURE_VILLAGE.bridges[0]
    forward = heading_vector(bridge.heading)
    start = add(bridge.position, forward, -bridge.span / 2 + 0.5)
    deck = _physics({"mover": start})
    assert deck.step({"mover": forward}, set())["mover"] == pytest.approx(add(start, forward))
    boundary = _physics({"mover": (0.5, 10.0)})
    assert boundary.step({"mover": (-1.0, 0.0)}, set())["mover"][0] >= 0.35
    wall = _physics({"mover": (8.0, 60.0)})
    assert wall.step({"mover": (0.0, 1.0)}, set())["mover"][1] < 62.2
    doorway = _physics({"mover": (8.0, 63.0)})
    assert doorway.step({"mover": (0.0, -1.0)}, set())["mover"][1] < 62.2


def test_day_samples_ground_speed_once_and_wraps_heading_360() -> None:
    day = Day(DayConfig(cast_size=5))
    _place(day, "visitor", (10.0, 10.0))
    orders = {character_id: day.default_order(character_id) for character_id in day.character_order}
    orders["visitor"] = Order(heading=360, speed=1.0)
    day.step(orders)
    assert day.characters["visitor"].heading == 0
    assert day.characters["visitor"].moved == pytest.approx(0.5, abs=0.03)


def test_non_finite_orders_degrade_to_the_stand_still_default() -> None:
    day = Day(DayConfig(cast_size=5))
    before = day.characters["visitor"].position
    heading = day.characters["visitor"].heading
    orders = {character_id: day.default_order(character_id) for character_id in day.character_order}
    orders["visitor"] = Order(heading=float("nan"), speed=float("inf"))
    day.step(orders)
    assert day.characters["visitor"].heading == heading
    assert day.characters["visitor"].position == pytest.approx(before)
    assert day.characters["visitor"].moved == pytest.approx(0)


def test_default_orders_hold_position_and_keep_the_current_heading() -> None:
    day = Day(DayConfig(cast_size=5))
    before = day.characters["visitor"].position
    day.step({character_id: day.default_order(character_id) for character_id in day.character_order})
    assert day.characters["visitor"].position == pytest.approx(before)
    assert day.characters["visitor"].moved == pytest.approx(0)


@pytest.mark.parametrize(
    ("position", "expected"),
    (((10.0, 25.0), 1.0), ((45.0, 90.0), 0.75), ((10.0, 10.0), 0.5), ((14.0, 47.0), 0.5)),
)
def test_each_passable_ground_class_sets_its_documented_speed(
    position: tuple[float, float], expected: float
) -> None:
    day = Day(DayConfig(cast_size=5))
    _place(day, "visitor", position)
    orders = {character_id: day.default_order(character_id) for character_id in day.character_order}
    orders["visitor"] = Order(heading=0, speed=1)
    day.step(orders)
    assert day.characters["visitor"].moved == pytest.approx(expected, abs=0.05)
