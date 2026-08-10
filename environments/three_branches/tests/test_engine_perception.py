"""Sight, hearing, reeds, bell, and phase pins."""

from __future__ import annotations

from dataclasses import replace

from three_branches.engine import CharacterState, Day, DayConfig
from three_branches.fixture import FIXTURE_VILLAGE
from three_branches.perception import can_see, can_see_prop


def _place(day: Day, character_id: str, position: tuple[float, float], heading: float = 0.0) -> None:
    state = day.characters[character_id]
    state.position = position
    state.heading = heading
    day.physics.bodies[character_id].position = position


def test_cone_and_hearing_apply_their_distinct_ranges() -> None:
    day = Day(DayConfig(cast_size=5), FIXTURE_VILLAGE)
    _place(day, "npc_0", (30.0, 60.0), 0)
    _place(day, "npc_1", (36.0, 60.0))
    _place(day, "npc_2", (30.0, 67.0))
    perception = day.perception("npc_0")
    assert [character.id for character in perception.seen] == ["npc_1"]
    assert [character.id for character in perception.nearby] == ["npc_1"]
    _place(day, "npc_1", (36.0, 60.0))
    assert "npc_1" in [character.id for character in day.perception("npc_0").nearby]
    _place(day, "npc_1", (36.01, 60.0))
    assert "npc_1" not in [character.id for character in day.perception("npc_0").nearby]
    _place(day, "npc_1", (36.0, 70.392304845))
    assert "npc_1" in [character.id for character in day.perception("npc_0").seen]


def test_walls_block_sight_and_a_doorway_does_not() -> None:
    day = Day(DayConfig(cast_size=5), FIXTURE_VILLAGE)
    _place(day, "npc_0", (8.0, 65.0), 270)
    _place(day, "npc_1", (8.0, 60.0))
    assert "npc_1" in [character.id for character in day.perception("npc_0").seen]
    _place(day, "npc_1", (12.0, 65.0))
    assert "npc_1" not in [character.id for character in day.perception("npc_0").seen]
    assert "npc_1" not in [character.id for character in day.perception("npc_0").nearby]


def test_reeds_hide_a_character_unless_the_observer_is_in_the_same_bank() -> None:
    day = Day(DayConfig(cast_size=5), FIXTURE_VILLAGE)
    _place(day, "npc_0", (14.0, 47.0), 0)
    _place(day, "npc_1", (16.0, 46.0))
    _place(day, "npc_2", (30.0, 47.0))
    assert "npc_1" in [character.id for character in day.perception("npc_0").seen]
    assert "npc_1" not in [character.id for character in day.perception("npc_2").seen]
    layout = replace(
        FIXTURE_VILLAGE,
        reed_banks=(
            ((10.0, 10.0), (14.0, 10.0), (14.0, 14.0), (10.0, 14.0)),
            ((15.0, 10.0), (19.0, 10.0), (19.0, 14.0), (15.0, 14.0)),
        ),
    )
    observer = CharacterState("observer", (12.0, 12.0), 0)
    target = CharacterState("target", (16.0, 12.0), 0)
    assert not can_see(layout, observer, target)


def test_bell_is_global_and_daynight_phases_follow_the_rules_table() -> None:
    day = Day(DayConfig(cast_size=5, daynight=True), FIXTURE_VILLAGE)
    day.prop_states["bell_0"] = "ringing"
    perception = day.perception("visitor")
    assert perception.bell
    assert any(prop.id == "bell_0" for prop in perception.props)
    assert perception.phase == "dawn"
    day.tick = 961
    assert day.phase == "night"
    assert Day(DayConfig(cast_size=5, daynight=False), FIXTURE_VILLAGE).phase == "day"


def test_prop_visibility_uses_the_same_cone_and_wall_rules_as_people() -> None:
    day = Day(DayConfig(cast_size=5), FIXTURE_VILLAGE)
    _place(day, "npc_0", (30.0, 32.0), 0)
    assert "stall_0" in [prop.id for prop in day.perception("npc_0").props]
    _place(day, "npc_0", (8.0, 65.0), 0)
    assert "bell_0" not in [prop.id for prop in day.perception("npc_0").props]


def test_reeds_do_not_conceal_props() -> None:
    layout = replace(
        FIXTURE_VILLAGE,
        props=(replace(FIXTURE_VILLAGE.props[0], position=(16.0, 46.0)), *FIXTURE_VILLAGE.props[1:]),
    )
    observer = CharacterState("observer", (26.0, 47.0), 180)
    prop = layout.props[0]
    assert not can_see(layout, observer, prop)
    assert can_see_prop(layout, observer, prop)
    day = Day(DayConfig(cast_size=5), layout)
    _place(day, "npc_0", observer.position, observer.heading)
    assert prop.id in [seen.id for seen in day.perception("npc_0").props]
