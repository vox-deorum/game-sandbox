"""Smoke test for the shared renderer in the composed template (``sandbox.*``) layout.

The Spades renderer reaches its shared base classes through a dual-name import: ``local_play.*`` in
the monorepo, ``sandbox.*`` here in a student's composed template. Nothing else in the template
exercises the renderer in the composed layout, so this is the only automated proof that
``sandbox.render_cards`` / ``sandbox.render_base`` and the relative ``sandbox.hidpi`` they pull in
resolve — and that the inherited card-table drawing plus the Spades-specific bid chips actually run
and produce a headless frame that hit-tests.
"""

from __future__ import annotations

from sandbox.card_utils import card_to_obj
from sandbox.env import make_env


def test_headless_render_produces_a_frame_and_hittests():
    env = make_env("rgb_array")
    try:
        env.reset(seed=0)

        # The frame comes back through the shared PygameRenderer._finish_frame tail.
        frame = env.render()
        assert frame is not None
        assert frame.shape == (720, 960, 3)
        assert str(frame.dtype) == "uint8"

        # A fresh hand is in its bidding round, so the centre well draws the clickable bid chips.
        # bid_action_at_pos is Spades' own hit-test; a round-trip proves it resolves in the
        # sandbox.* layout and maps a chip back to its 52 + k bid action.
        for bid in (0, 7, 13):
            rect = env._renderer.bid_rect(bid)
            assert rect is not None
            assert env._renderer.bid_action_at_pos(rect.center) == 52 + bid

        # card_rect / card_at_pos are inherited from the shared CardTableRenderer; a round-trip
        # proves the shared hand layout and hit-testing resolve in the sandbox.* layout. The
        # renderer deals in semantic card OBJECTS, while state.hands holds engine ints.
        card = card_to_obj(env.state.hands[0][0])
        rect = env._renderer.card_rect(card)
        assert rect is not None
        assert env._renderer.card_at_pos(rect.center) == card
    finally:
        env.close()
