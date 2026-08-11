"""Pins for the Three Branches shared rules data and validation."""

from __future__ import annotations

from typing import Any

import pytest

from three_branches.prop_types import PROP_TYPES, fixed_prop_count
from three_branches.prop_types import load as load_props
from three_branches.rules import DAY_TICKS, EMOTES, GROUND_BY_TOKEN, OFF_PHASE, PHASES, PROFILE
from three_branches.rules import load as load_rules


def _rules_document() -> dict[str, Any]:
    return {
        "emotes": ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
        "ground": [
            {"token": "road", "code": "r", "speed": 1.0},
            {"token": "water", "code": "w", "speed": 0.0, "impassable": True},
        ],
        "profile": {
            "body_radius": 0.4,
            "vision_degrees": 120,
            "vision_range": 12,
            "hearing_range": 6,
            "talk_range": 3,
            "shout_range": 15,
            "prop_reach": 1.5,
            "running_threshold": 0.5,
        },
        "phases": [{"name": "dawn", "start": 1, "end": 4}],
        "off_phase": "day",
        "day_ticks": 4,
    }


def _props_document() -> dict[str, Any]:
    return {
        "props": [
            {
                "token": "bench",
                "title": "Bench",
                "activity": "sitting",
                "states": ["occupied", "empty"],
                "start": "empty",
                "transition": {"kind": "occupancy"},
                "footprint": {"width": 1.6, "depth": 0.5},
                "count": 1,
                "district": "plaza",
            }
        ]
    }


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda doc: doc["emotes"].__setitem__(1, "one"), "emotes must be unique"),
        (lambda doc: doc["emotes"].pop(), "exactly nine"),
        (
            lambda doc: doc["ground"].append({"token": "field", "code": "r", "speed": 0.5}),
            "ground codes must be unique",
        ),
        (lambda doc: doc["ground"][0].update(speed=0), "ground speed must be positive"),
        (lambda doc: doc["ground"][0].update(speed=float("nan")), "ground speed must be positive"),
        (lambda doc: doc["phases"][0].update(start=2), "contiguous"),
        (lambda doc: doc.update(day_ticks=5), "end at day_ticks"),
    ],
)
def test_rules_loader_rejects_malformed_documents(change: Any, message: str) -> None:
    document = _rules_document()
    change(document)
    with pytest.raises(ValueError, match=message):
        load_rules(document)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda doc: doc["props"][0].update(token="not-a-token"), "snake_case"),
        (lambda doc: doc["props"][0]["states"].append("empty"), "states must be unique"),
        (lambda doc: doc["props"][0].update(start="missing"), "one of the states"),
        (lambda doc: doc["props"][0]["states"].insert(0, "reserved"), "exactly two states"),
        (lambda doc: doc["props"][0].update(start="occupied"), "second, resting state"),
        (lambda doc: doc["props"][0]["transition"].update(ticks=1), "exactly"),
        (lambda doc: doc["props"][0].update(transition={"kind": "timed"}), "exactly"),
        (lambda doc: doc["props"][0]["footprint"].update(width=0), "footprint width must be positive"),
        (
            lambda doc: doc["props"][0]["footprint"].update(width=float("inf")),
            "footprint width must be positive",
        ),
        (lambda doc: doc["props"][0].update(count=0), "prop count must be a positive integer"),
        (lambda doc: doc["props"][0].update(count=None), "prop count must be a positive integer"),
    ],
)
def test_prop_loader_rejects_malformed_documents(change: Any, message: str) -> None:
    document = _props_document()
    change(document)
    with pytest.raises(ValueError, match=message):
        load_props(document)


def test_prop_loader_allows_only_lantern_to_have_a_variable_count() -> None:
    document = _props_document()
    document["props"][0].update(token="lantern", count=None)

    assert load_props(document)[0].count is None

    document["props"][0]["count"] = 1
    with pytest.raises(ValueError, match="lantern count must be null"):
        load_props(document)


def test_the_shipped_rules_pin_the_ruleset_tables() -> None:
    assert EMOTES == ("wave", "nod", "shake_head", "point", "laugh", "shrug", "startle", "sleep", "sweep")
    assert {name: ground.speed for name, ground in GROUND_BY_TOKEN.items()} == {
        "road": 1.0,
        "open": 0.75,
        "field": 0.5,
        "reeds": 0.5,
        "water": 0.0,
    }
    assert GROUND_BY_TOKEN["water"].impassable
    assert PROFILE.body_radius == 0.4
    assert (PROFILE.vision_degrees, PROFILE.vision_range, PROFILE.hearing_range) == (120.0, 12.0, 6.0)
    assert (PROFILE.talk_range, PROFILE.shout_range, PROFILE.prop_reach, PROFILE.running_threshold) == (
        3.0,
        15.0,
        1.5,
        0.5,
    )
    assert [(phase.name, phase.start, phase.end) for phase in PHASES] == [
        ("dawn", 1, 120),
        ("morning", 121, 480),
        ("midday", 481, 720),
        ("evening", 721, 960),
        ("night", 961, 1200),
    ]
    assert OFF_PHASE == "day" and DAY_TICKS == 1200


def test_the_shipped_props_pin_the_ruleset_and_village_tables() -> None:
    assert [
        (
            prop.token,
            prop.title,
            prop.activity,
            prop.states,
            prop.start,
            prop.transition.kind,
            prop.transition.ticks,
            prop.footprint.width,
            prop.footprint.depth,
            prop.count,
        )
        for prop in PROP_TYPES
    ] == [
        (
            "stall",
            "Market stall",
            "tending the stall",
            ("open", "closed"),
            "closed",
            "toggle",
            None,
            1.5,
            1.5,
            5,
        ),
        (
            "lantern",
            "Lantern post",
            "lighting",
            ("lit", "unlit"),
            "unlit",
            "toggle",
            None,
            0.6,
            0.6,
            None,
        ),
        ("bench", "Bench", "sitting", ("occupied", "empty"), "empty", "occupancy", None, 1.6, 0.5, 5),
        (
            "shrine",
            "Roadside shrine",
            "tending the shrine",
            ("tended", "untended"),
            "untended",
            "timed",
            300,
            1.5,
            1.5,
            2,
        ),
        ("board", "Notice board", "reading the board", ("none",), "none", "none", None, 0.6, 0.6, 1),
        (
            "plot",
            "Garden plot",
            "tending the plot",
            ("tended", "overgrown"),
            "overgrown",
            "timed",
            600,
            4.0,
            3.0,
            5,
        ),
        (
            "hearth",
            "Inn hearth",
            "tending the hearth",
            ("lit", "unlit"),
            "unlit",
            "toggle",
            None,
            0.6,
            0.6,
            1,
        ),
        (
            "repair_bench",
            "Repair bench",
            "working the bench",
            ("busy", "idle"),
            "idle",
            "occupancy",
            None,
            1.6,
            0.5,
            1,
        ),
        ("pump", "Well pump", "working the pump", ("flowing", "idle"), "idle", "timed", 10, 0.6, 0.6, 1),
        (
            "bell",
            "Beacon bell",
            "ringing the bell",
            ("ringing", "silent"),
            "silent",
            "timed",
            40,
            0.6,
            0.6,
            1,
        ),
    ]
    assert fixed_prop_count(PROP_TYPES[0]) == 5
    with pytest.raises(ValueError, match="variable count"):
        fixed_prop_count(PROP_TYPES[1])
