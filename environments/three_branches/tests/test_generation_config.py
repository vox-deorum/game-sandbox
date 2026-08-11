"""Strict validation for the maintainer-owned village generation tuning."""

from __future__ import annotations

import copy
import json
from importlib import resources
from typing import Any

import pytest

from three_branches.generation.config import GENERATION_CONFIG, load_generation_config


def _document() -> dict[str, Any]:
    return json.loads(
        resources.files("three_branches").joinpath("generation.json").read_text(encoding="utf-8")
    )


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda doc: doc["accessories"]["pine"].pop("radius"), "exactly"),
        (lambda doc: doc["accessories"]["pine"].update(extra=1), "exactly"),
        (lambda doc: doc["accessories"]["pine"].update(radius=True), "positive finite number"),
        (lambda doc: doc["accessories"]["pine"].update(radius=float("inf")), "positive finite number"),
        (
            lambda doc: doc["accessories"]["pine"].update(companion_distance=[3, 2]),
            "must be ordered",
        ),
        (
            lambda doc: doc["accessories"]["pine"].update(scatter_probability=1.1),
            "between 0 and 1",
        ),
        (lambda doc: doc["accessories"]["prop"].update(tries=0), "positive integer"),
        (
            lambda doc: doc["network"].update(road_weights=[[-0.1, 0.2], [0.2, 0.4], [0.3, 0.5]]),
            "positive finite number",
        ),
        (
            lambda doc: doc["sites"].update(cluster_grid_start=90),
            "increasing start and stop",
        ),
        (
            lambda doc: doc["terrain"].update(reed_mouth_window_points=2),
            "bank windows must contain enough points",
        ),
        (
            lambda doc: doc["terrain"].update(bank_window_points=1),
            "bank windows must contain enough points",
        ),
        (
            lambda doc: doc["terrain"].update(bank_scan_end=3),
            "must preserve full bank windows",
        ),
        (
            lambda doc: doc["network"].update(water_reach_step=13),
            "must not exceed its limit",
        ),
        (
            lambda doc: doc["network"].update(crossing_min_normal_x=1.1),
            "must not exceed 1",
        ),
        (
            lambda doc: doc["network"].update(crossing_edge_margin=50),
            "leaves no crossing candidates",
        ),
        (
            lambda doc: doc["accessories"]["lantern"].update(market_spacing=0.5),
            "bounded candidate work",
        ),
        (
            lambda doc: doc["accessories"]["pine"].update(scatter_cell=4.9),
            "bounded candidate work",
        ),
    ],
)
def test_generation_loader_rejects_malformed_nested_tuning(change: Any, message: str) -> None:
    document = copy.deepcopy(_document())
    change(document)
    with pytest.raises(ValueError, match=message):
        load_generation_config(document)


def test_shipped_generation_tuning_uses_nested_accessory_groups() -> None:
    assert GENERATION_CONFIG.pipeline.max_redraws == 64
    assert GENERATION_CONFIG.accessories.pine.radius == 0.8
    assert GENERATION_CONFIG.accessories.lantern.spacing == 14.0
    assert GENERATION_CONFIG.accessories.lantern.market_spacing == 7.0
    assert GENERATION_CONFIG.accessories.pine.scatter_probability == 0.25
    assert GENERATION_CONFIG.accessories.pine.companions == (1, 4)
    assert GENERATION_CONFIG.accessories.stall.fallback_spacing == 7.0
    assert GENERATION_CONFIG.accessories.bench.road_edge_gap == 0.3
