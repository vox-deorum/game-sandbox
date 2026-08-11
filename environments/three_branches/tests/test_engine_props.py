"""Prop selection, contention, holding, and data-driven transitions."""

from __future__ import annotations

from dataclasses import replace

from three_branches.engine import CharacterState, Day, DayConfig, Order
from three_branches.fixture import FIXTURE_VILLAGE
from three_branches.prop_use import resolve_uses


def _day() -> Day:
    return Day(DayConfig(cast_size=5), FIXTURE_VILLAGE)


def _place(day: Day, character_id: str, position: tuple[float, float]) -> None:
    day.characters[character_id].position = position
    day.physics.bodies[character_id].position = position


def _orders(day: Day, character_id: str, action: str = "none", speed: float = 0.0) -> dict[str, Order]:
    orders = {candidate: day.default_order(candidate) for candidate in day.character_order}
    orders[character_id] = Order(heading=day.characters[character_id].heading, speed=speed, action=action)
    return orders


def test_toggle_holds_without_retoggling_and_releases_without_resetting() -> None:
    day = _day()
    _place(day, "npc_0", (30.5, 32.0))
    day.step(_orders(day, "npc_0", "use"))
    assert day.characters["npc_0"].expression.target == "stall_0"
    assert day.prop_states["stall_0"] == "open"
    day.step(_orders(day, "npc_0", "use"))
    assert day.prop_states["stall_0"] == "open"
    day.step(_orders(day, "npc_0"))
    assert day.prop_holders["stall_0"] is None
    assert day.prop_states["stall_0"] == "open"


def test_nearest_selection_stillness_and_character_order_contention_are_pinned() -> None:
    day = _day()
    _place(day, "npc_0", (45.5, 50.0))
    _place(day, "npc_1", (45.5, 50.0))
    orders = _orders(day, "npc_1", "use")
    orders["npc_0"] = Order(speed=0, action="use")
    day.step(orders)
    assert day.prop_holders["pump_0"] == "npc_0"
    assert day.characters["npc_1"].expression.type == "none"
    day = _day()
    _place(day, "npc_0", (45.5, 50.0))
    day.step(_orders(day, "npc_0", "use", speed=0.1))
    assert day.characters["npc_0"].expression.type == "none"
    first, second, *remaining = FIXTURE_VILLAGE.props
    layout = replace(
        FIXTURE_VILLAGE,
        props=(replace(first, position=(10.0, 10.0)), replace(second, position=(13.0, 10.0)), *remaining),
    )
    characters = {"npc_0": CharacterState("npc_0", (11.5, 10.0), 0)}
    holders = {prop.id: None for prop in layout.props}
    resolution = resolve_uses(layout, characters, {"npc_0": Order(action="use")}, holders, ("npc_0",))
    assert resolution.targets == {"npc_0": "stall_0"}


def test_occupancy_and_timed_transitions_follow_the_catalog_counts() -> None:
    day = _day()
    _place(day, "npc_0", (41.5, 48.0))
    day.step(_orders(day, "npc_0", "use"))
    assert day.prop_states["bench_0"] == "occupied"
    day.step(_orders(day, "npc_0"))
    assert day.prop_states["bench_0"] == "empty"
    _place(day, "npc_0", (45.5, 50.0))
    day.step(_orders(day, "npc_0", "use"))
    assert day.prop_states["pump_0"] == "flowing"
    for _ in range(9):
        day.step(_orders(day, "npc_0"))
    assert day.prop_states["pump_0"] == "flowing"
    day.step(_orders(day, "npc_0"))
    assert day.prop_states["pump_0"] == "idle"


def test_stateless_board_can_be_held_without_changing_its_only_state() -> None:
    day = _day()
    _place(day, "npc_0", (37.0, 34.4))
    day.step(_orders(day, "npc_0", "use"))
    assert day.prop_holders["board_0"] == "npc_0"
    assert day.prop_states["board_0"] == "none"


def test_a_large_footprint_is_usable_at_its_near_edge_beyond_center_reach() -> None:
    day = _day()
    _place(day, "npc_0", (4.5, 69.0))

    day.step(_orders(day, "npc_0", "use"))

    assert day.prop_holders["plot_0"] == "npc_0"


def test_leaving_reach_releases_a_hold_and_timed_uses_refresh_their_counter() -> None:
    day = _day()
    _place(day, "npc_0", (45.5, 50.0))
    day.step(_orders(day, "npc_0", "use"))
    for _ in range(5):
        day.step(_orders(day, "npc_0", "use"))
    assert day.prop_timers["pump_0"] == 10
    _place(day, "npc_0", (40.0, 50.0))
    day.step(_orders(day, "npc_0", "use"))
    assert day.prop_holders["pump_0"] is None


def test_a_held_canonical_nearest_prop_does_not_fall_through_to_the_next_choice() -> None:
    first, second, *remaining = FIXTURE_VILLAGE.props
    layout = replace(
        FIXTURE_VILLAGE,
        props=(replace(first, position=(10.0, 10.0)), replace(second, position=(11.0, 10.0)), *remaining),
    )
    characters = {
        "npc_0": CharacterState("npc_0", (9.5, 10.0), 0),
        "npc_1": CharacterState("npc_1", (20.0, 20.0), 0),
    }
    holders = {prop.id: None for prop in layout.props}
    holders["stall_0"] = "npc_1"
    resolution = resolve_uses(
        layout,
        characters,
        {"npc_0": Order(action="use"), "npc_1": Order()},
        holders,
        ("npc_0", "npc_1"),
    )
    assert resolution.targets == {}


def test_all_shipped_timed_counts_revert_after_their_exact_unheld_ticks() -> None:
    cases = (
        ("pump_0", (45.5, 50.0), 10),
        ("bell_0", (16.0, 27.5), 40),
        ("shrine_0", (13.5, 33.0), 300),
        ("plot_0", (6.5, 68.5), 600),
    )
    for prop_id, position, ticks in cases:
        day = _day()
        _place(day, "npc_0", position)
        day.step(_orders(day, "npc_0", "use"))
        for _ in range(ticks - 1):
            day.step(_orders(day, "npc_0"))
        assert (
            day.prop_states[prop_id]
            != {
                "pump_0": "idle",
                "bell_0": "silent",
                "shrine_0": "untended",
                "plot_0": "overgrown",
            }[prop_id]
        )
        day.step(_orders(day, "npc_0"))
        assert (
            day.prop_states[prop_id]
            == {
                "pump_0": "idle",
                "bell_0": "silent",
                "shrine_0": "untended",
                "plot_0": "overgrown",
            }[prop_id]
        )


def test_day_runs_1200_transitions_while_the_terminal_observation_stays_at_tick_1200() -> None:
    day = _day()
    for _ in range(1200):
        day.step({character_id: day.default_order(character_id) for character_id in day.character_order})
    assert day.terminal
    assert day.tick == 1200
