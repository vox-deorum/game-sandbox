"""Pins for the closed-form rules geometry."""

from __future__ import annotations

import math

import pytest

from three_branches.geometry import (
    distance,
    distance_to_rectangle,
    distance_to_segment,
    heading_to,
    heading_vector,
    in_cone,
    point_in_polygon,
    point_in_rectangle,
    segments_intersect,
    wrap_heading,
)


@pytest.mark.parametrize(
    ("heading", "expected"),
    ((0, 0), (360, 0), (-90, 270), (721.5, 1.5)),
)
def test_headings_wrap_to_the_documented_turn_interval(heading: float, expected: float) -> None:
    assert wrap_heading(heading) == expected


def test_heading_vectors_and_headings_use_east_as_zero() -> None:
    assert heading_vector(0) == pytest.approx((1, 0))
    assert heading_vector(90) == pytest.approx((0, 1))
    assert heading_vector(180) == pytest.approx((-1, 0))
    assert heading_to((0, 0), (0, -1)) == 270
    assert heading_to((0, 0), (-1, 1)) == 135


def test_distance_and_segment_distance_include_endpoint_and_projection_cases() -> None:
    assert distance((0, 0), (3, 4)) == 5
    assert distance_to_segment((2, 3), (0, 0), (4, 0)) == 3
    assert distance_to_segment((-2, 1), (0, 0), (4, 0)) == pytest.approx(math.sqrt(5))
    assert distance_to_segment((3, 4), (0, 0), (0, 0)) == 5


def test_cone_edges_and_range_are_inclusive() -> None:
    observer = (0.0, 0.0)
    assert in_cone(observer, 0, (12, 0), 120, 12)
    assert in_cone(observer, 0, (6, 6 * math.sqrt(3)), 120, 12)
    assert not in_cone(observer, 0, (6, 6 * math.sqrt(3) + 0.01), 120, 12)
    assert not in_cone(observer, 0, (12.01, 0), 120, 12)
    assert in_cone(observer, 0, observer, 120, 12)


def test_segment_intersection_covers_crossing_touching_collinear_and_disjoint_cases() -> None:
    assert segments_intersect(((0, 0), (2, 2)), ((0, 2), (2, 0)))
    assert segments_intersect(((0, 0), (1, 0)), ((1, 0), (2, 0)))
    assert segments_intersect(((0, 0), (3, 0)), ((1, 0), (2, 0)))
    assert not segments_intersect(((0, 0), (1, 0)), ((2, 0), (3, 0)))
    assert not segments_intersect(((0, 0), (1, 0)), ((2, -1), (2, 1)))


def test_rectangle_distance_is_zero_inside_and_exact_at_edges_and_corners() -> None:
    assert distance_to_rectangle((0, 0), (0, 0), 2, 4) == 0
    assert distance_to_rectangle((2, 0), (0, 0), 2, 4) == 1
    assert distance_to_rectangle((2, 3), (0, 0), 2, 4) == pytest.approx(math.sqrt(2))
    assert distance_to_rectangle((0, 3), (0, 0), 2, 4, 90) == 2


def test_polygons_and_rotated_rectangles_include_their_boundaries() -> None:
    square = ((0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0))
    assert point_in_polygon((2, 2), square)
    assert point_in_polygon((4, 2), square)
    assert not point_in_polygon((4.1, 2), square)
    assert point_in_rectangle((0, 1), (0, 0), 2, 4, 90)
    assert not point_in_rectangle((2.1, 0), (0, 0), 2, 4, 90)
