"""Tests for the shared pygame renderers extracted into ``local_play``.

Cards flow through the shared :class:`~local_play.render_cards.CardTableRenderer` as semantic
``{"suit", "rank"}`` objects (face rank ``2..14``); drawing reads ``suit``/``rank`` straight off the
object, and :func:`~local_play.render_cards.card_key` is the one place a card collapses to a stable,
hashable engine id (``0..51``), used only for map/set identity (legal sets, matching a card across
frames). These tests pin that ``card_key`` agrees with *both* concrete rules engines' encoding
(Hearts and Spades) across the whole deck via the shared codec, that the concrete renderers really
subclass the shared base (the guarantee the extraction rests on), and that each game's
near-identical geometry stays a class-attribute hook rather than a copied-and-averaged method.
"""

from __future__ import annotations

import hearts.render as hearts_render
import spades.render as spades_render
from hearts import rules as hearts_rules
from hearts.render import HeartsRenderer
from local_play import card_utils
from local_play.render_base import PygameRenderer
from local_play.render_cards import CardTableRenderer, card_key
from spades import rules as spades_rules
from spades.render import SpadesRenderer


def test_both_renderers_subclass_the_shared_card_table():
    assert issubclass(CardTableRenderer, PygameRenderer)
    assert issubclass(HeartsRenderer, CardTableRenderer)
    assert issubclass(SpadesRenderer, CardTableRenderer)


def test_card_key_recovers_the_engine_id_for_every_card_in_both_rules_engines():
    # card_key is the renderer's one hashable card identity, built from the semantic object; it must
    # round-trip back to the same engine id both rules engines already agree on for the whole deck.
    for rules in (hearts_rules, spades_rules):
        assert CardTableRenderer.NUM_PLAYERS == rules.NUM_PLAYERS
        assert CardTableRenderer.CLUBS == rules.CLUBS
        assert CardTableRenderer.DIAMONDS == rules.DIAMONDS
        assert CardTableRenderer.SPADES == rules.SPADES
        assert CardTableRenderer.HEARTS == rules.HEARTS
        for card in range(rules.NUM_CARDS):
            assert card_key(card_utils.card_to_obj(card)) == card


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
