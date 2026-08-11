"""Focused checks for configurable Three Branches accessory generation."""

from __future__ import annotations

import itertools
import math
from functools import cache
from types import SimpleNamespace

import pytest

import three_branches.generation as generation
from three_branches.generation import accessories as accessory_generation
from three_branches.generation import build_village
from three_branches.generation.accessories import RoadArc
from three_branches.generation.config import GENERATION_CONFIG
from three_branches.generation.validation import _Fill
from three_branches.generation.walker import _unit
from three_branches.geometry import (
    add,
    distance,
    distance_to_rectangle,
    heading_vector,
    polyline_distance,
    rectangle_corners,
    segments_intersect,
    subtract,
)
from three_branches.layout import Polyline, Prop
from three_branches.rules import PROFILE

BATCH_SEEDS = (0, 1, 2, 3, 5, 7, 11, 17)


class _ScriptedRng:
    """A small RNG double that makes candidate scheduling assertions exact."""

    def __init__(self, random_values: list[float], uniform_values: list[float] = ()) -> None:
        self._random_values = iter(random_values)
        self._uniform_values = iter(uniform_values)

    def random(self) -> float:
        return next(self._random_values)

    def uniform(self, _low: float, _high: float) -> float:
        return next(self._uniform_values)

    def randint(self, low: int, high: int) -> int:
        assert (low, high) == GENERATION_CONFIG.accessories.pine.companions
        return high


def test_road_arc_projects_onto_segments_and_returns_local_frames() -> None:
    arc = RoadArc.of(((0.0, 0.0), (10.0, 0.0), (10.0, 20.0)))

    assert arc.total == pytest.approx(30.0)
    assert arc.nearest((12.0, 10.0)) == pytest.approx(20.0)
    assert arc.nearest((-3.0, -4.0)) == pytest.approx(0.0)

    point, tangent, normal = arc.frame(15.0)
    assert point == pytest.approx((10.0, 5.0))
    assert tangent == pytest.approx((0.0, 1.0))
    assert normal == pytest.approx((-1.0, 0.0))
    assert arc.frame(500.0)[0] == pytest.approx((10.0, 20.0))


def test_lanterns_follow_market_schedule_and_try_the_opposite_side_once() -> None:
    class Placer:
        def __init__(self) -> None:
            self.attempts: list[tuple[float, float]] = []
            self.banked: list[tuple[str, tuple[float, float]]] = []

        def stretch_wet(self, _point: tuple[float, float], _room: float) -> bool:
            return False

        def rect_clear(
            self,
            center: tuple[float, float],
            _footprint: tuple[float, float],
            _rotation: float,
            **_kwargs: float,
        ) -> bool:
            self.attempts.append(center)
            return len(self.attempts) != 1

        def witness_for(
            self, center: tuple[float, float], *_args: object, **_kwargs: object
        ) -> tuple[float, float]:
            return center

        def bank(
            self, token: str, center: tuple[float, float], _rotation: float, _witness: tuple[float, float]
        ) -> None:
            self.banked.append((token, center))

    placer = Placer()
    network = SimpleNamespace(road=Polyline(((0.0, 50.0), (100.0, 50.0)), 4.0))
    sites = SimpleNamespace(market=(34.0, 50.0))

    accessory_generation._lanterns(_ScriptedRng([0.0]), placer, network, sites)

    attempted_x = [center[0] for center in placer.attempts]
    assert attempted_x == pytest.approx((6.0, 6.0, 20.0, 27.0, 34.0, 41.0, 48.0, 55.0, 69.0, 83.0))
    assert placer.attempts[0][1] > 50.0
    assert placer.attempts[1][1] < 50.0
    assert [center[0] for _token, center in placer.banked] == pytest.approx(
        (6.0, 20.0, 27.0, 34.0, 41.0, 48.0, 55.0, 69.0, 83.0)
    )
    assert [center[1] > 50.0 for _token, center in placer.banked[:3]] == [False, False, True]


def test_pines_use_one_candidate_from_each_selected_scatter_cell(monkeypatch: pytest.MonkeyPatch) -> None:
    candidates: list[tuple[float, float]] = []
    monkeypatch.setattr(accessory_generation, "WORLD_SIZE", 40.0)
    monkeypatch.setattr(accessory_generation, "_road_stations", lambda *_args: (10.0,))
    monkeypatch.setattr(
        accessory_generation,
        "_pine_anchor",
        lambda _rng, _placer, candidate: candidates.append(candidate),
    )
    network = SimpleNamespace(road=Polyline(((0.0, 10.0), (40.0, 10.0)), 4.0))

    accessory_generation._pines(
        _ScriptedRng([0.1, 0.2, 0.3, 0.9, 0.2, 0.5, 0.6, 0.8]),
        object(),
        network,
    )

    assert candidates == [(10.0, pytest.approx(14.8)), (4.0, 6.0), (30.0, 12.0)]


def test_pine_anchor_adds_the_configured_optional_companions() -> None:
    class Placer:
        def __init__(self) -> None:
            self.pines = []
            self.groups: list[tuple[tuple[float, float], tuple[tuple[float, float], ...]]] = []

        def pine_clear(self, point: tuple[float, float], group: tuple[tuple[float, float], ...] = ()) -> bool:
            self.groups.append((point, group))
            return True

    placer = Placer()
    rng = _ScriptedRng([0.0], [1.8, 0.0, 1.8, 180.0, 1.8, 90.0, 1.8, 270.0])

    accessory_generation._pine_anchor(rng, placer, (50.0, 50.0))

    assert len(placer.pines) == 1 + GENERATION_CONFIG.accessories.pine.companions[1]
    assert placer.pines[1].position == pytest.approx((51.8, 50.0))
    assert placer.pines[2].position == pytest.approx((48.2, 50.0))
    assert placer.groups[1][1] == ((50.0, 50.0),)
    assert placer.groups[2][1] == ((50.0, 50.0), placer.pines[1].position)


def test_optional_accessories_fall_back_without_redrawing_required_layers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"terrain": 0, "sites": 0, "network": 0, "accessories": 0, "validated": 0}

    class Accessories:
        def layout_parts(
            self, include_pines: bool, include_lanterns: bool
        ) -> tuple[tuple[str, ...], tuple[str, ...], tuple[object, ...]]:
            props = ("mandatory",) + (("lantern",) if include_lanterns else ())
            scenery = ("mandatory_scenery",) + (("pine",) if include_pines else ())
            return props, scenery, ()

    def terrain_layer(_rng: object) -> tuple[str, tuple[str, ...], tuple[object, ...], tuple[object, ...]]:
        calls["terrain"] += 1
        return "terrain", ("channel",), (), ()

    def sites_layer(_rng: object, _terrain: object, _water: object) -> str:
        calls["sites"] += 1
        return "sites"

    network = SimpleNamespace(road="road", footpaths=(), bridges=(), buildings=(), spawn="spawn")

    def network_layer(_rng: object, _terrain: object, _water: object, _sites: object) -> SimpleNamespace:
        calls["network"] += 1
        return network

    def accessories_layer(*_args: object) -> Accessories:
        calls["accessories"] += 1
        return Accessories()

    def layout_factory(**kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(**kwargs)

    def validated(layout: SimpleNamespace, _witnesses: tuple[object, ...]) -> bool:
        calls["validated"] += 1
        return layout.props == ("mandatory",)

    monkeypatch.setattr(generation, "_terrain_layer", terrain_layer)
    monkeypatch.setattr(generation, "_sites_layer", sites_layer)
    monkeypatch.setattr(generation, "_network_layer", network_layer)
    monkeypatch.setattr(generation, "_accessories_layer", accessories_layer)
    monkeypatch.setattr(
        generation,
        "_Water",
        SimpleNamespace(of=lambda channels: SimpleNamespace(channels=channels)),
    )
    monkeypatch.setattr(generation, "Layout", layout_factory)
    monkeypatch.setattr(generation, "_validated", validated)

    layout = generation.build_village(9)

    assert calls == {"terrain": 1, "sites": 1, "network": 1, "accessories": 1, "validated": 3}
    assert layout.props == ("mandatory",)
    assert layout.scenery == ("mandatory_scenery",)


@cache
def _village(seed: int):
    return build_village(seed)


def _reachable_fill(layout):
    """Build the same connected map used by validation, independently of prop witnesses."""
    fill = _Fill(layout)
    stitches: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for building in layout.buildings:
        outward = _unit(subtract(building.doorway.position, building.center))
        outside = add(building.doorway.position, outward, 0.8)
        inside = add(building.doorway.position, outward, -0.8)
        outside_cell = fill.attach(outside)
        inside_cell = fill.attach(inside)
        assert fill.line_clear(outside, inside)
        assert outside_cell is not None and inside_cell is not None
        stitches.setdefault(outside_cell, []).append(inside_cell)
        stitches.setdefault(inside_cell, []).append(outside_cell)
    for bridge in layout.bridges:
        forward = heading_vector(bridge.heading)
        near = add(bridge.position, forward, -bridge.span / 2.0)
        far = add(bridge.position, forward, bridge.span / 2.0)
        near_cell = fill.attach(near)
        far_cell = fill.attach(far)
        assert fill.line_clear(near, far)
        assert near_cell is not None and far_cell is not None
        stitches.setdefault(near_cell, []).append(far_cell)
        stitches.setdefault(far_cell, []).append(near_cell)
    seed = fill.attach(layout.spawn)
    assert seed is not None
    fill.flood(seed, stitches)
    return fill


def _has_reachable_witness(fill: _Fill, prop: Prop) -> bool:
    start = min(prop.footprint) / 2.0 + PROFILE.body_radius + 0.06
    radius = start
    while radius <= PROFILE.prop_reach - 0.02:
        for step in range(16):
            angle = math.tau * step / 16.0
            point = add(prop.position, (math.cos(angle), math.sin(angle)), radius)
            if (
                distance_to_rectangle(point, prop.position, *prop.footprint, prop.rotation)
                < PROFILE.body_radius
            ):
                continue
            if fill.connected(point):
                return True
        radius += 0.1
    return False


@pytest.mark.parametrize("seed", BATCH_SEEDS)
def test_generated_accessories_clear_each_other_and_stay_reachable(seed: int) -> None:
    layout = _village(seed)
    props = layout.props
    scenery = layout.scenery

    for first, second in itertools.combinations(props, 2):
        first_corners = rectangle_corners(first.position, *first.footprint, first.rotation)
        second_corners = rectangle_corners(second.position, *second.footprint, second.rotation)
        assert not any(
            segments_intersect(first_edge, second_edge)
            for first_edge, second_edge in itertools.product(
                zip(first_corners, (*first_corners[1:], first_corners[0]), strict=True),
                zip(second_corners, (*second_corners[1:], second_corners[0]), strict=True),
            )
        )
        assert all(
            distance_to_rectangle(corner, second.position, *second.footprint, second.rotation) > 1e-6
            for corner in first_corners
        )
        assert all(
            distance_to_rectangle(corner, first.position, *first.footprint, first.rotation) > 1e-6
            for corner in second_corners
        )
    for prop in props:
        for item in scenery:
            assert (
                distance_to_rectangle(item.position, prop.position, *prop.footprint, prop.rotation)
                >= item.radius - 1e-6
            )
    for first, second in itertools.combinations(scenery, 2):
        assert distance(first.position, second.position) >= first.radius + second.radius - 1e-6

    lanterns = [prop for prop in props if prop.type == "lantern"]
    arc = RoadArc.of(layout.road.points)
    for lantern in lanterns:
        assert polyline_distance(lantern.position, layout.road.points) >= layout.road.width / 2.0
        assert (
            GENERATION_CONFIG.accessories.lantern.end_margin - 1e-6
            <= arc.nearest(lantern.position)
            <= (arc.total - GENERATION_CONFIG.accessories.lantern.end_margin + 1e-6)
        )
    for pine in (item for item in scenery if item.type == "pine"):
        for path in (layout.road, *layout.footpaths):
            assert (
                polyline_distance(pine.position, path.points)
                >= path.width / 2.0 + pine.radius + GENERATION_CONFIG.accessories.pine.path_edge_gap - 1e-6
            )

    fill = _reachable_fill(layout)
    assert all(_has_reachable_witness(fill, prop) for prop in props)
