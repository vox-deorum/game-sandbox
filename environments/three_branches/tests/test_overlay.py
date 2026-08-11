"""The strict compact replay codec for Days at Three Branches."""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import replace

import pytest

from three_branches.engine import Day, DayConfig, Expression
from three_branches.env import ThreeBranchesEnv
from three_branches.fixture import FIXTURE_VILLAGE
from three_branches.overlay import (
    OVERLAY_VERSION,
    decode_overlay,
    encode_overlay,
    encode_overlay_static,
    extract_overlay,
    extract_overlay_static,
)


def _orders(day: Day) -> dict[str, object]:
    return {character_id: day.default_order(character_id) for character_id in day.character_order}


def _overlay(*, cast_size: int = 5, daynight: bool = False) -> tuple[dict[str, object], dict[str, object]]:
    day = Day(DayConfig(cast_size=cast_size, daynight=daynight), FIXTURE_VILLAGE)
    return encode_overlay(day), encode_overlay_static(day)


def _layout_with_lantern_count(count: int):
    stalls = FIXTURE_VILLAGE.props[:5]
    lantern = FIXTURE_VILLAGE.props[5]
    lanterns = tuple(replace(lantern, id=f"lantern_{index}") for index in range(count))
    return replace(FIXTURE_VILLAGE, props=(*stalls, *lanterns, *FIXTURE_VILLAGE.props[14:]))


def test_overlay_round_trips_to_friendly_meters_words_and_derived_state() -> None:
    day = Day(DayConfig(cast_size=5, daynight=True), FIXTURE_VILLAGE)
    day.characters["npc_0"].expression = Expression("wave")
    day.prop_states["bell_0"] = "ringing"

    compact = encode_overlay(day)
    static = encode_overlay_static(day)
    decoded = decode_overlay(compact, static)

    assert compact["v"] == OVERLAY_VERSION
    assert set(compact) == {"v", "d"}
    assert static["v"] == OVERLAY_VERSION
    assert set(static) == {"v", "s"}
    assert len(compact["d"]["c"]) == 6
    assert all(len(record) == 14 for record in compact["d"]["c"])
    assert len(compact["d"]["p"]) == len(FIXTURE_VILLAGE.props)
    assert static["s"]["q"] == "05090502010501010101"
    assert decoded["characters"][0]["expression"] == "wave"
    assert decoded["characters"][-1]["id"] == "visitor"
    assert decoded["village"]["props"][0]["position"] == {"x": 32.0, "y": 32.0}
    assert decoded["village"]["ground"][25][0] == "road"
    assert decoded["bell"] is True
    assert decoded["phase"] == "dawn"
    assert decoded["terminal"] is False


@pytest.mark.parametrize("cast_size", (5, 10))
def test_decoder_accepts_the_two_supported_cast_sizes(cast_size: int) -> None:
    compact, static = _overlay(cast_size=cast_size)
    decoded = decode_overlay(compact, static)

    assert len(decoded["characters"]) == cast_size + 1


def test_static_layout_is_separate_from_every_frame_and_env_extraction_uses_live_day() -> None:
    env = ThreeBranchesEnv(seat_plan="cast_5")
    env.reset(seed=7)
    static = extract_overlay_static(env)
    first = extract_overlay(env)
    actions = {
        player_id: {"heading": float(env.day.characters["visitor"].heading), "speed": 0.0, "action": 0}
        for player_id in env.agents
    }
    env.step(actions)
    second = extract_overlay(env)

    assert extract_overlay_static(env) == static
    assert set(static) == {"v", "s"}
    assert "s" not in first
    assert "s" not in second
    assert first["d"]["t"] == 1
    assert second["d"]["t"] == 2


def test_overlay_uses_the_static_lantern_count_for_variable_rosters_and_states() -> None:
    layout = _layout_with_lantern_count(2)
    day = Day(DayConfig(cast_size=5), layout)
    compact = encode_overlay(day)
    static = encode_overlay_static(day)
    decoded = decode_overlay(compact, static)

    assert static["s"]["q"] == "05020502010501010101"
    assert len(compact["d"]["p"]) == len(layout.props)
    assert [prop["id"] for prop in decoded["village"]["props"] if prop["type"] == "lantern"] == [
        "lantern_0",
        "lantern_1",
    ]


def test_overlay_supports_use_targets_above_base36_one_character_range() -> None:
    day = Day(DayConfig(cast_size=5), _layout_with_lantern_count(15))
    day.characters["npc_0"].expression = Expression("use", "bell_0")
    compact = encode_overlay(day)
    static = encode_overlay_static(day)

    assert compact["d"]["c"][0][-2:] == "10"
    assert decode_overlay(compact, static)["characters"][0]["target"] == "bell_0"


def test_mutating_an_encoded_static_layout_does_not_change_later_frames() -> None:
    day = Day(DayConfig(cast_size=5), FIXTURE_VILLAGE)
    first = encode_overlay_static(day)
    first["s"]["r"] = "changed"

    second = encode_overlay_static(day)

    assert second["s"]["r"] != "changed"


def test_split_overlay_is_canonical_and_deterministic() -> None:
    day = Day(DayConfig(cast_size=5), FIXTURE_VILLAGE)

    first = (encode_overlay_static(day), encode_overlay(day))
    second = (encode_overlay_static(day), encode_overlay(day))

    assert first == second
    assert all("s" not in frame for frame in (first[1], second[1]))
    for value in (*first, *second):
        encoded = json.dumps(value, allow_nan=False, sort_keys=True, separators=(",", ":"))
        assert json.loads(encoded) == value


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda compact, static: compact.update(extra=None), "unexpected fields"),
        (lambda compact, static: compact["d"].update(c=compact["d"]["c"][:-1]), "roster order"),
        (lambda compact, static: compact["d"]["c"].__setitem__(0, "short"), "14 characters"),
        (lambda compact, static: compact["d"].update(p="z" * len(compact["d"]["p"])), "prop state"),
        (lambda compact, static: static["s"].update(q="bad"), "prop counts"),
        (lambda compact, static: static["s"].update(q="?" + static["s"]["q"][1:]), "prop count"),
        (lambda compact, static: static["s"].update(q="04090502010501010101"), "fixed prop count"),
        (lambda compact, static: static["s"]["p"].pop(), "pose count"),
        (lambda compact, static: static["s"].update(q="05zz0502010501010101"), "cannot exceed 1295"),
        (lambda compact, static: static["s"]["g"].__setitem__(0, "o00"), "ground row"),
        (lambda compact, static: compact["d"].update(t=1199, z="1"), "terminal flag"),
        (lambda compact, static: static["s"].update(a="10"), "cast size"),
        (
            lambda compact, static: compact["d"]["c"].__setitem__(
                0, compact["d"]["c"][0][:9] + "2t" + compact["d"]["c"][0][11:]
            ),
            "movement",
        ),
    ],
)
def test_decoder_rejects_malformed_keys_counts_records_ranges_grid_and_terminal(
    mutate: object, message: str
) -> None:
    compact, static = map(deepcopy, _overlay())
    mutate(compact, static)
    with pytest.raises(ValueError, match=message):
        decode_overlay(compact, static)


def test_decoder_rejects_use_expression_target_and_holder_conflicts() -> None:
    compact, static = map(deepcopy, _overlay())
    record = compact["d"]["c"][0]
    compact["d"]["c"][0] = record[:11] + "a" + "zz"
    with pytest.raises(ValueError, match="use target"):
        decode_overlay(compact, static)

    compact, static = map(deepcopy, _overlay())
    for index in (0, 1):
        record = compact["d"]["c"][index]
        compact["d"]["c"][index] = record[:11] + "a00"
    with pytest.raises(ValueError, match="multiple holders"):
        decode_overlay(compact, static)

    compact, static = map(deepcopy, _overlay())
    record = compact["d"]["c"][0]
    compact["d"]["c"][0] = record[:9] + "01" + "a00"
    with pytest.raises(ValueError, match="movement"):
        decode_overlay(compact, static)


def test_decoder_rejects_out_of_range_headings() -> None:
    compact, static = map(deepcopy, _overlay())
    record = compact["d"]["c"][0]
    compact["d"]["c"][0] = record[:6] + "zzz" + record[9:]
    with pytest.raises(ValueError, match="outside"):
        decode_overlay(compact, static)


def test_decoder_requires_split_version_one_static_data() -> None:
    compact, static = _overlay()

    with pytest.raises(ValueError, match="static data is required"):
        decode_overlay(compact)
    with pytest.raises(ValueError, match="must not contain static"):
        decode_overlay({"v": OVERLAY_VERSION, "s": static["s"], "d": compact["d"]}, static)
    with pytest.raises(ValueError, match="dynamic frame has an unsupported version"):
        decode_overlay({"v": 2, "d": compact["d"]}, static)
    with pytest.raises(ValueError, match="static data has an unsupported version"):
        decode_overlay(compact, {"v": 2, "s": static["s"]})


def test_tick_1200_has_a_nonterminal_frame_then_a_terminal_frame() -> None:
    day = Day(DayConfig(cast_size=5), FIXTURE_VILLAGE)
    for _ in range(1199):
        day.step(_orders(day))
    static = encode_overlay_static(day)
    nonterminal = decode_overlay(encode_overlay(day), static)
    day.step(_orders(day))
    terminal = decode_overlay(encode_overlay(day), static)
    assert nonterminal["tick"] == terminal["tick"] == 1200
    assert nonterminal["terminal"] is False
    assert terminal["terminal"] is True
