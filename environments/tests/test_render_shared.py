"""Tests for the shared pygame renderers extracted into ``local_play``.

The shared :class:`~local_play.render_cards.CardTableRenderer` bakes in the canonical card encoding
as class defaults, so a card game inherits ``suit_of`` / ``rank_of`` and the suit ids for free.
These pin that those defaults actually agree with *both* concrete rules engines (Hearts and Spades)
across the whole deck, that the concrete renderers really subclass the shared base (the guarantee
the extraction rests on), and that each game's near-identical geometry stays a class-attribute hook
rather than a copied-and-averaged method.
"""

from __future__ import annotations

import hearts.render as hearts_render
import spades.render as spades_render
from hearts import rules as hearts_rules
from hearts.render import HeartsRenderer
from local_play.render_base import PygameRenderer
from local_play.render_cards import CardTableRenderer
from spades import rules as spades_rules
from spades.render import SpadesRenderer


def test_both_renderers_subclass_the_shared_card_table():
    assert issubclass(CardTableRenderer, PygameRenderer)
    assert issubclass(HeartsRenderer, CardTableRenderer)
    assert issubclass(SpadesRenderer, CardTableRenderer)


def test_codec_defaults_match_both_rules_engines():
    # The one encoding, restated once as the renderer's defaults; each game's rules engine is its
    # source of truth. If a future change touched one and not the other, this catches it card by card.
    for rules in (hearts_rules, spades_rules):
        assert CardTableRenderer.NUM_PLAYERS == rules.NUM_PLAYERS
        assert CardTableRenderer.CLUBS == rules.CLUBS
        assert CardTableRenderer.DIAMONDS == rules.DIAMONDS
        assert CardTableRenderer.SPADES == rules.SPADES
        assert CardTableRenderer.HEARTS == rules.HEARTS
        for card in range(rules.NUM_CARDS):
            assert CardTableRenderer.suit_of(card) == rules.suit_of(card)
            assert CardTableRenderer.rank_of(card) == rules.rank_of(card)


def test_rank_labels_cover_every_rank():
    assert len(CardTableRenderer.RANK_LABELS) == 13


def test_per_game_geometry_stays_a_class_attribute_hook():
    # Hearts keeps the shared defaults; Spades' taller badges and lower rows are overrides, never
    # averaged into the shared methods (a pixel-drift trap the extraction must avoid).
    assert (HeartsRenderer.NORTH_BADGE_Y, HeartsRenderer.OPPONENT_ROW_NORTH_Y) == (96, 150)
    assert (HeartsRenderer.BADGE_W, HeartsRenderer.BADGE_H) == (158, 56)
    assert (SpadesRenderer.NORTH_BADGE_Y, SpadesRenderer.OPPONENT_ROW_NORTH_Y) == (112, 166)
    assert (SpadesRenderer.BADGE_W, SpadesRenderer.BADGE_H) == (168, 62)


def test_frame_dimensions_are_shared_and_re_exported():
    # The 960x720 frame is one shared value; the module-level WIDTH/HEIGHT aliases (load-bearing for
    # the harness and test_spades.py) equal the inherited class attributes.
    assert HeartsRenderer.WIDTH == SpadesRenderer.WIDTH == CardTableRenderer.WIDTH == 960
    assert HeartsRenderer.HEIGHT == SpadesRenderer.HEIGHT == CardTableRenderer.HEIGHT == 720
    assert (hearts_render.WIDTH, hearts_render.HEIGHT) == (960, 720)
    assert (spades_render.WIDTH, spades_render.HEIGHT) == (960, 720)
