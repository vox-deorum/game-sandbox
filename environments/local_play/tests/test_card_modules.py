"""Tests for the shared semantic-card codec, spaces, and rules-engine wiring.

The dependency-free codec round-trips every card while keeping engine rank indices separate from
semantic face values. The shared Gymnasium spaces accept the empty and populated sequences produced
by card environments. Hearts and Spades both import the same suit and rank functions.
"""

from __future__ import annotations

import pytest

from hearts import rules as hearts_rules
from local_play import card_spaces, card_utils, shared_modules
from spades import rules as spades_rules

# -- the shared codec ------------------------------------------------------------------------


def test_codec_round_trips_every_card():
    # Every one of the 52 cards survives card -> object -> card unchanged, and the semantic object is
    # always the platform shape: suit 0..3, face-value rank 2..14.
    for card in range(card_utils.NUM_CARDS):
        obj = card_utils.card_to_obj(card)
        assert obj["suit"] in range(card_utils.NUM_SUITS)
        assert 2 <= obj["rank"] <= 14
        assert card_utils.card_from_obj(obj) == card


def test_queen_of_spades_pins_both_rank_conventions():
    # The one example that pins engine index (10) against semantic face value (12) at once.
    queen = 36
    assert card_utils.suit_of(queen) == card_utils.SPADES == 2
    assert card_utils.rank_of(queen) == 10  # engine index the rules compare on
    assert card_utils.card_to_obj(queen) == {"suit": 2, "rank": 12}  # face value the agent sees
    assert card_utils.card_from_obj({"suit": 2, "rank": 12}) == queen


def test_suit_names_cover_every_suit():
    assert card_utils.SUIT_NAMES == ("clubs", "diamonds", "spades", "hearts")
    for card in range(card_utils.NUM_CARDS):
        assert card_utils.SUIT_NAMES[card_utils.suit_of(card)]


def test_rules_engines_keep_suit_and_rank_after_importing_shared_codec():
    # Both engines now re-export their suit/rank codec from card_utils; confirm the values did not
    # move: the same suit ids and the same engine rank index (queen still 10) for the whole deck.
    for rules in (hearts_rules, spades_rules):
        assert rules.suit_of is card_utils.suit_of
        assert rules.rank_of is card_utils.rank_of
        assert (rules.CLUBS, rules.DIAMONDS, rules.SPADES, rules.HEARTS) == (0, 1, 2, 3)
        assert rules.NUM_CARDS == card_utils.NUM_CARDS == 52
        for card in range(card_utils.NUM_CARDS):
            assert rules.suit_of(card) == card // 13
            assert rules.rank_of(card) == card % 13
    # The Hearts engine's landmark cards stay put under the shared codec.
    assert hearts_rules.suit_of(hearts_rules.QUEEN_OF_SPADES) == hearts_rules.SPADES
    assert hearts_rules.rank_of(hearts_rules.QUEEN_OF_SPADES) == 10


def test_shared_module_resolver_returns_the_local_modules():
    """The resolver preserves the cached module identities that callers re-export."""
    resolved_utils, resolved_spaces = shared_modules.resolve("card_utils", "card_spaces")
    assert resolved_utils is card_utils
    assert resolved_spaces is card_spaces


def test_shared_module_resolver_falls_back_only_for_a_missing_candidate(monkeypatch: pytest.MonkeyPatch):
    """A missing candidate falls through, while an unrelated dependency failure is preserved."""
    monkeypatch.setattr(shared_modules, "_PACKAGES", ("missing_shared", "local_play"))
    assert shared_modules.resolve("card_utils") == (card_utils,)

    def missing_dependency(_name: str):
        raise ModuleNotFoundError("No module named 'missing_dependency'", name="missing_dependency")

    monkeypatch.setattr(shared_modules.importlib, "import_module", missing_dependency)
    with pytest.raises(ModuleNotFoundError, match="missing_dependency"):
        shared_modules.resolve("card_utils")


def test_shared_module_resolver_preserves_an_internal_module_failure(monkeypatch: pytest.MonkeyPatch):
    """A missing child imported by a requested module is a real dependency failure."""

    def missing_internal(_name: str):
        raise ModuleNotFoundError(
            "No module named 'local_play.card_utils.internal'",
            name="local_play.card_utils.internal",
        )

    monkeypatch.setattr(shared_modules.importlib, "import_module", missing_internal)
    with pytest.raises(ModuleNotFoundError, match=r"local_play\.card_utils\.internal"):
        shared_modules.resolve("card_utils")


def test_shared_module_resolver_names_the_requested_modules_when_none_exist(monkeypatch: pytest.MonkeyPatch):
    """The final error explains both the requested helper and the checked layouts."""
    monkeypatch.setattr(shared_modules, "_PACKAGES", ("missing_one", "missing_two"))
    with pytest.raises(ModuleNotFoundError, match="card_utils.*missing_one.*missing_two"):
        shared_modules.resolve("card_utils")


# -- the shared spaces -----------------------------------------------------------------------


def test_card_space_accepts_face_values_and_rejects_engine_index():
    assert card_spaces.CARD.contains({"suit": 2, "rank": 12})  # queen of spades, face value
    assert card_spaces.CARD.contains({"suit": 0, "rank": 2})  # two of clubs
    assert card_spaces.CARD.contains({"suit": 3, "rank": 14})  # ace of hearts
    # Rank is a face value 2..14, so the engine index 0 (and any raw rank below 2) is out of space.
    assert not card_spaces.CARD.contains({"suit": 2, "rank": 0})


def test_hand_space_accepts_empty_and_populated_sequences():
    assert card_spaces.HAND.contains(())  # an exhausted hand is a valid empty sequence
    populated = tuple(card_utils.card_to_obj(c) for c in (0, 36, 51))
    assert card_spaces.HAND.contains(populated)


def test_trick_space_accepts_empty_and_populated_play_ordered_records():
    assert card_spaces.TRICK.contains(())  # between tricks
    trick = (
        {"player": 2, "card": card_utils.card_to_obj(0)},
        {"player": 3, "card": card_utils.card_to_obj(36)},
    )
    assert card_spaces.TRICK.contains(trick)


if __name__ == "__main__":  # pragma: no cover - convenience for a direct run
    raise SystemExit(pytest.main([__file__, "-q"]))
