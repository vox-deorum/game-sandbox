"""The strict compact replay codec for Days at Three Branches."""

from __future__ import annotations

from copy import deepcopy

import pytest

from three_branches.engine import Day, DayConfig, Expression
from three_branches.env import ThreeBranchesEnv
from three_branches.overlay import OVERLAY_VERSION, decode_overlay, encode_overlay, extract_overlay


def _orders(day: Day) -> dict[str, object]:
    return {character_id: day.default_order(character_id) for character_id in day.character_order}


def _overlay(*, cast_size: int = 5, daynight: bool = False) -> dict[str, object]:
    return encode_overlay(Day(DayConfig(cast_size=cast_size, daynight=daynight)))


def test_overlay_round_trips_to_friendly_meters_words_and_derived_state() -> None:
    day = Day(DayConfig(cast_size=5, daynight=True))
    day.characters["npc_0"].expression = Expression("wave")
    day.prop_states["bell_0"] = "ringing"

    compact = encode_overlay(day)
    decoded = decode_overlay(compact)

    assert compact["v"] == OVERLAY_VERSION
    assert len(compact["d"]["c"]) == 6
    assert all(len(record) == 13 for record in compact["d"]["c"])
    assert len(compact["d"]["p"]) == 31
    assert decoded["characters"][0]["expression"] == "wave"
    assert decoded["characters"][-1]["id"] == "visitor"
    assert decoded["village"]["props"][0]["position"] == {"x": 32.0, "y": 32.0}
    assert decoded["village"]["ground"][25][0] == "road"
    assert decoded["bell"] is True
    assert decoded["phase"] == "dawn"
    assert decoded["terminal"] is False


@pytest.mark.parametrize("cast_size", (5, 10))
def test_decoder_accepts_the_two_supported_cast_sizes(cast_size: int) -> None:
    decoded = decode_overlay(_overlay(cast_size=cast_size))

    assert len(decoded["characters"]) == cast_size + 1


def test_static_layout_is_identical_in_every_frame_and_env_extraction_uses_live_day() -> None:
    env = ThreeBranchesEnv(seat_plan="cast_5")
    env.reset(seed=7)
    first = extract_overlay(env)
    actions = {
        player_id: {"heading": float(env.day.characters["visitor"].heading), "speed": 0.0, "action": 0}
        for player_id in env.agents
    }
    env.step(actions)
    second = extract_overlay(env)

    assert first["s"] == second["s"]
    assert first["d"]["t"] == 1
    assert second["d"]["t"] == 2


def test_mutating_an_encoded_static_layout_does_not_change_later_frames() -> None:
    day = Day(DayConfig(cast_size=5))
    first = encode_overlay(day)
    first["s"]["r"] = "changed"

    second = encode_overlay(day)

    assert second["s"]["r"] != "changed"


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda value: value.update(extra=None), "unexpected fields"),
        (lambda value: value["d"].update(c=value["d"]["c"][:-1]), "roster order"),
        (lambda value: value["d"]["c"].__setitem__(0, "short"), "13 characters"),
        (lambda value: value["d"].update(p="z" * 31), "prop state"),
        (lambda value: value["s"]["g"].__setitem__(0, "o00"), "ground row"),
        (lambda value: value["d"].update(t=1199, z="1"), "terminal flag"),
        (lambda value: value["s"].update(a="10"), "cast size"),
        (
            lambda value: value["d"]["c"].__setitem__(
                0, value["d"]["c"][0][:9] + "2t" + value["d"]["c"][0][11:]
            ),
            "movement",
        ),
    ],
)
def test_decoder_rejects_malformed_keys_counts_records_ranges_grid_and_terminal(
    mutate: object, message: str
) -> None:
    compact = deepcopy(_overlay())
    mutate(compact)
    with pytest.raises(ValueError, match=message):
        decode_overlay(compact)


def test_decoder_rejects_use_expression_target_and_holder_conflicts() -> None:
    compact = deepcopy(_overlay())
    record = compact["d"]["c"][0]
    compact["d"]["c"][0] = record[:11] + "a" + "z"
    with pytest.raises(ValueError, match="use target"):
        decode_overlay(compact)

    compact = deepcopy(_overlay())
    for index in (0, 1):
        record = compact["d"]["c"][index]
        compact["d"]["c"][index] = record[:11] + "a0"
    with pytest.raises(ValueError, match="multiple holders"):
        decode_overlay(compact)

    compact = deepcopy(_overlay())
    record = compact["d"]["c"][0]
    compact["d"]["c"][0] = record[:9] + "01" + "a0"
    with pytest.raises(ValueError, match="movement"):
        decode_overlay(compact)


def test_decoder_rejects_out_of_range_headings() -> None:
    compact = deepcopy(_overlay())
    record = compact["d"]["c"][0]
    compact["d"]["c"][0] = record[:6] + "zzz" + record[9:]
    with pytest.raises(ValueError, match="outside"):
        decode_overlay(compact)


def test_tick_1200_has_a_nonterminal_frame_then_a_terminal_frame() -> None:
    day = Day(DayConfig(cast_size=5))
    for _ in range(1199):
        day.step(_orders(day))
    nonterminal = decode_overlay(encode_overlay(day))
    day.step(_orders(day))
    terminal = decode_overlay(encode_overlay(day))
    assert nonterminal["tick"] == terminal["tick"] == 1200
    assert nonterminal["terminal"] is False
    assert terminal["terminal"] is True
