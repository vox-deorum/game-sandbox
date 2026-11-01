"""The message router and single validation point: routing, delivery, and every rejection.

Pure units on :class:`~game_sandbox_harness.chat.ChatRouter`, with ``capsys`` asserting the stderr
diagnostic on every drop. The cap is counted in Unicode code points, pinned with an astral-plane
fixture so an emoji costs one.
"""

from __future__ import annotations

import pytest

from game_sandbox_harness.chat import ChatRouter

PLAYERS = ("player_0", "player_1", "player_2", "player_3")


def _router(cap: int | None = None) -> ChatRouter:
    return ChatRouter(PLAYERS, cap)


@pytest.mark.parametrize(
    ("sender", "batch", "tick", "inboxes"),
    [
        (
            "player_0",
            [{"from": "player_3", "to": "player_2", "text": "hi partner"}],
            3,
            {
                "player_0": [],
                "player_1": [],
                "player_2": [{"from": "player_0", "to": "player_2", "text": "hi partner", "tick": 3}],
                "player_3": [],
            },
        ),
        (
            "player_1",
            [{"from": "player_3", "to": None, "text": "table!"}],
            5,
            {
                "player_0": [{"from": "player_1", "to": None, "text": "table!", "tick": 5}],
                "player_1": [],
                "player_2": [{"from": "player_1", "to": None, "text": "table!", "tick": 5}],
                "player_3": [{"from": "player_1", "to": None, "text": "table!", "tick": 5}],
            },
        ),
    ],
)
def test_targeted_message_routes_to_its_recipient_only(sender, batch, tick, inboxes):
    router = _router()
    router.deliver(router.validate_outgoing(sender, batch), tick=tick)
    # The forged ``from`` is replaced with the real sender in every delivered payload.
    for player in PLAYERS:
        assert router.drain(player) == inboxes[player]
    # A second drain returns nothing: the first read cleared each inbox.
    for player in PLAYERS:
        assert router.drain(player) == []


def test_none_or_empty_batch_is_silent(capsys):
    router = _router()
    assert router.validate_outgoing("player_0", None) == []
    assert router.validate_outgoing("player_0", []) == []
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize(
    ("batch", "diagnostic"),
    [
        ({"to": None, "text": "x"}, "non-list batch"),
        ("hello", "non-list batch"),
        (["not an object"], "non-object message"),
        ([{"to": "player_9", "text": "x"}], "unknown recipient"),
        ([{"to": "player_0", "text": "x"}], "to itself"),
        ([{"to": None, "text": 42}], "non-string text"),
        ([{"to": None, "text": True}], "non-string text"),
    ],
)
def test_invalid_messages_are_dropped_with_a_diagnostic(batch, diagnostic, capsys):
    router = _router()
    assert router.validate_outgoing("player_0", batch) == []
    assert diagnostic in capsys.readouterr().err


def test_one_message_per_recipient_plus_one_broadcast_is_allowed(capsys):
    router = _router()
    accepted = router.validate_outgoing(
        "player_0",
        [
            {"from": "player_3", "to": "player_1", "text": "to one"},
            {"to": "player_1", "text": "again one"},
            {"to": "player_2", "text": "to two"},
            {"to": None, "text": "to all"},
            {"to": None, "text": "again all"},
        ],
    )
    assert accepted == [
        {"from": "player_0", "to": "player_1", "text": "to one"},
        {"from": "player_0", "to": "player_2", "text": "to two"},
        {"from": "player_0", "to": None, "text": "to all"},
    ]
    err = capsys.readouterr().err
    assert "second message to player_1" in err
    assert "second broadcast" in err

    # The limit resets for the next boundary and is independent for each sender.
    assert router.validate_outgoing("player_0", [{"to": "player_1", "text": "next boundary"}]) == [
        {"from": "player_0", "to": "player_1", "text": "next boundary"}
    ]
    assert router.validate_outgoing(
        "player_1",
        [{"to": "player_2", "text": "their boundary"}, {"to": "player_2", "text": "again"}],
    ) == [{"from": "player_1", "to": "player_2", "text": "their boundary"}]
    assert "second message to player_2" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("text", "accepted", "diagnostic"),
    [
        ("😀😀😀", [{"from": "player_0", "to": None, "text": "😀😀😀"}], ""),
        ("😀😀😀😀", [], "4 code points over the cap of 3"),
    ],
)
def test_cap_counts_code_points_emoji_costs_one(text, accepted, diagnostic, capsys):
    # An astral-plane character is one code point; a cap of three admits three emoji and rejects four.
    router = _router(cap=3)
    assert router.validate_outgoing("player_0", [{"to": None, "text": text}]) == accepted
    err = capsys.readouterr().err
    if diagnostic:
        assert diagnostic in err
    else:
        assert err == ""


@pytest.mark.parametrize(
    ("sender", "batch", "diagnostic"),
    [
        ("player_2", [{"to": "player_0", "text": "late"}], "inactive sender"),
        ("player_0", [{"to": "player_2", "text": "late"}], "inactive recipient"),
        ("player_9", [{"to": "player_0", "text": "late"}], "unknown sender"),
    ],
)
def test_inactive_senders_and_recipients_are_dropped(sender, batch, diagnostic, capsys):
    router = _router()
    router.set_active(("player_0", "player_1"))
    assert router.validate_outgoing(sender, batch) == []
    assert diagnostic in capsys.readouterr().err


def test_set_active_discards_the_inbox_of_a_player_that_left():
    router = _router()
    router.deliver(router.validate_outgoing("player_0", [{"to": "player_2", "text": "queued"}]), tick=0)
    router.set_active(("player_0", "player_1"))
    assert router.drain("player_2") == []
    # The players still active keep everything they were holding.
    router.deliver(router.validate_outgoing("player_0", [{"to": "player_1", "text": "kept"}]), tick=1)
    router.set_active(("player_0", "player_1"))
    assert router.drain("player_1") == [{"from": "player_0", "to": "player_1", "text": "kept", "tick": 1}]


def test_delivery_skips_a_recipient_that_left_on_this_transition():
    router = _router()
    accepted = router.validate_outgoing("player_0", [{"to": None, "text": "table!"}])
    router.set_active(("player_0", "player_1"))
    router.deliver(accepted, tick=2)
    assert router.drain("player_1") == [{"from": "player_0", "to": None, "text": "table!", "tick": 2}]
    for gone in ("player_2", "player_3"):
        assert router.drain(gone) == []


@pytest.mark.parametrize(
    ("active", "audience", "inboxes"),
    [
        (
            PLAYERS,
            ("player_2",),
            {
                "player_0": [],
                "player_1": [{"from": "player_0", "to": "player_1", "text": "direct", "tick": 1}],
                "player_2": [{"from": "player_0", "to": None, "text": "one", "tick": 1}],
                "player_3": [],
            },
        ),
        (
            PLAYERS,
            (),
            {
                "player_0": [],
                "player_1": [{"from": "player_0", "to": "player_1", "text": "direct", "tick": 1}],
                "player_2": [],
                "player_3": [],
            },
        ),
        (
            ("player_0", "player_1"),
            ("player_1", "player_2"),
            {
                "player_0": [],
                "player_1": [
                    {"from": "player_0", "to": None, "text": "one", "tick": 1},
                    {"from": "player_0", "to": "player_1", "text": "direct", "tick": 1},
                ],
                "player_2": [],
                "player_3": [],
            },
        ),
    ],
)
def test_broadcast_delivery_respects_the_live_audience(active, audience, inboxes, capsys):
    class Ring:
        def broadcast_recipients(self, sender: str) -> tuple[str, ...]:
            return audience

    router = _router()
    router.set_active(active)
    messages = router.validate_outgoing(
        "player_0", [{"to": None, "text": "one"}, {"to": "player_1", "text": "direct"}]
    )
    router.deliver(messages, tick=1, env=Ring())
    for player in PLAYERS:
        assert router.drain(player) == inboxes[player]
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize(
    ("declared", "diagnostic", "raises"),
    [
        ("player_1", "not a sequence", False),
        (("player_1", "player_1"), "same recipient twice", False),
        (("player_0",), "sender as one of its own", False),
        (("player_9",), "unknown recipient", False),
        ((1,), "non-string recipient", False),
        (None, "broadcast recipients failed", True),
    ],
)
def test_invalid_broadcast_hook_falls_back_to_the_default_audience(declared, diagnostic, raises, capsys):
    class Broken:
        def broadcast_recipients(self, sender: str):
            if raises:
                raise RuntimeError("broken")
            return declared

    router = _router()
    router.set_active(("player_0", "player_1", "player_2"))
    messages = router.validate_outgoing("player_0", [{"to": None, "text": "fallback"}])
    router.deliver(messages, tick=1, env=Broken())
    assert diagnostic in capsys.readouterr().err
    assert router.drain("player_0") == []
    assert router.drain("player_1") == [{"from": "player_0", "to": None, "text": "fallback", "tick": 1}]
    assert router.drain("player_2") == [{"from": "player_0", "to": None, "text": "fallback", "tick": 1}]
    assert router.drain("player_3") == []


def test_a_policy_naming_an_inactive_recipient_is_filtered_rather_than_voided(capsys):
    """An environment naming a departed player must not have its whole policy widened to the default."""
    router = _router()
    # player_3 stays active so a fallback to the default policy would visibly permit it.
    router.set_active(("player_0", "player_1", "player_3"))
    policy = router.validate_policy(
        "player_0",
        {"target_recipients": ("player_1", "player_2"), "default_recipient": "player_2"},
    )
    # player_2 is gone, so it leaves the list, and the default it held falls back to broadcast.
    assert policy.target_recipients == ("player_1",)
    assert policy.default_recipient is None
    assert capsys.readouterr().err == ""

    # player_3 is active but outside the surviving policy, so a direct message to it is disallowed.
    assert router.validate_outgoing("player_0", [{"to": "player_3", "text": "nope"}], policy) == []
    assert "policy-disallowed recipient" in capsys.readouterr().err

    accepted = router.validate_outgoing("player_0", [{"to": "player_1", "text": "still here"}], policy)
    router.deliver(accepted, tick=6)
    assert router.drain("player_0") == []
    assert router.drain("player_2") == []
    assert router.drain("player_3") == []
    assert router.drain("player_1") == [
        {"from": "player_0", "to": "player_1", "text": "still here", "tick": 6}
    ]
