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


def test_targeted_message_routes_to_its_recipient_only():
    router = _router()
    accepted = router.validate_outgoing("player_0", [{"to": "player_2", "text": "hi partner"}])
    router.deliver(accepted, tick=3)
    assert router.drain("player_2") == [
        {"from": "player_0", "to": "player_2", "text": "hi partner", "tick": 3}
    ]
    # Nobody else received it.
    for other in ("player_0", "player_1", "player_3"):
        assert router.drain(other) == []


def test_broadcast_reaches_everyone_except_the_sender():
    router = _router()
    accepted = router.validate_outgoing("player_1", [{"to": None, "text": "table!"}])
    router.deliver(accepted, tick=5)
    assert router.drain("player_1") == []  # the sender never receives its own broadcast
    for other in ("player_0", "player_2", "player_3"):
        assert router.drain(other) == [{"from": "player_1", "to": None, "text": "table!", "tick": 5}]


def test_drain_clears_the_inbox():
    router = _router()
    router.deliver(router.validate_outgoing("player_0", [{"to": "player_1", "text": "one"}]), tick=1)
    assert router.drain("player_1")  # non-empty
    assert router.drain("player_1") == []  # cleared


def test_from_is_stamped_over_anything_the_agent_set():
    router = _router()
    accepted = router.validate_outgoing("player_0", [{"from": "player_3", "to": "player_1", "text": "spoof"}])
    assert accepted == [{"from": "player_0", "to": "player_1", "text": "spoof"}]


def test_none_or_empty_batch_is_silent(capsys):
    router = _router()
    assert router.validate_outgoing("player_0", None) == []
    assert router.validate_outgoing("player_0", []) == []
    assert capsys.readouterr().err == ""


def test_non_list_batch_is_dropped_with_a_diagnostic(capsys):
    router = _router()
    assert router.validate_outgoing("player_0", {"to": None, "text": "x"}) == []
    assert "non-list batch" in capsys.readouterr().err


def test_string_batch_is_dropped_not_iterated_as_chars(capsys):
    router = _router()
    assert router.validate_outgoing("player_0", "hello") == []
    assert "non-list batch" in capsys.readouterr().err


def test_unknown_recipient_is_dropped(capsys):
    router = _router()
    assert router.validate_outgoing("player_0", [{"to": "player_9", "text": "x"}]) == []
    assert "unknown recipient" in capsys.readouterr().err


def test_self_target_is_dropped(capsys):
    router = _router()
    assert router.validate_outgoing("player_0", [{"to": "player_0", "text": "x"}]) == []
    assert "to itself" in capsys.readouterr().err


def test_non_string_text_is_dropped(capsys):
    router = _router()
    assert router.validate_outgoing("player_0", [{"to": None, "text": 42}]) == []
    assert "non-string text" in capsys.readouterr().err


def test_bool_text_is_dropped(capsys):
    router = _router()
    # bool is an int subclass; it must not slip through the str check.
    assert router.validate_outgoing("player_0", [{"to": None, "text": True}]) == []
    assert "non-string text" in capsys.readouterr().err


def test_second_message_to_same_recipient_is_dropped(capsys):
    router = _router()
    accepted = router.validate_outgoing(
        "player_0",
        [{"to": "player_1", "text": "first"}, {"to": "player_1", "text": "second"}],
    )
    assert accepted == [{"from": "player_0", "to": "player_1", "text": "first"}]
    assert "second message to player_1" in capsys.readouterr().err


def test_second_broadcast_is_dropped(capsys):
    router = _router()
    accepted = router.validate_outgoing(
        "player_0", [{"to": None, "text": "one"}, {"to": None, "text": "two"}]
    )
    assert accepted == [{"from": "player_0", "to": None, "text": "one"}]
    assert "second broadcast" in capsys.readouterr().err


def test_one_message_per_recipient_plus_one_broadcast_is_allowed():
    router = _router()
    accepted = router.validate_outgoing(
        "player_0",
        [
            {"to": "player_1", "text": "to one"},
            {"to": "player_2", "text": "to two"},
            {"to": None, "text": "to all"},
        ],
    )
    assert len(accepted) == 3


def test_cap_counts_code_points_emoji_costs_one():
    # An astral-plane character is one code point; a cap of three admits three emoji and rejects four.
    router = _router(cap=3)
    assert router.validate_outgoing("player_0", [{"to": None, "text": "😀😀😀"}]) == [
        {"from": "player_0", "to": None, "text": "😀😀😀"}
    ]


def test_over_cap_message_is_dropped(capsys):
    router = _router(cap=3)
    assert router.validate_outgoing("player_0", [{"to": None, "text": "😀😀😀😀"}]) == []
    err = capsys.readouterr().err
    assert "4 code points over the cap of 3" in err


def test_non_object_item_is_dropped(capsys):
    router = _router()
    assert router.validate_outgoing("player_0", ["not an object"]) == []
    assert "non-object message" in capsys.readouterr().err


def test_inactive_senders_and_recipients_are_dropped(capsys):
    router = _router()
    router.set_active(("player_0", "player_1"))
    assert router.validate_outgoing("player_2", [{"to": "player_0", "text": "late"}]) == []
    assert router.validate_outgoing("player_0", [{"to": "player_2", "text": "late"}]) == []
    diagnostics = capsys.readouterr().err
    assert "inactive sender" in diagnostics
    assert "inactive recipient" in diagnostics


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


def test_broadcast_without_an_environment_hook_reaches_every_other_active_player():
    router = _router()
    messages = router.validate_outgoing("player_0", [{"to": None, "text": "hello"}])
    router.deliver(messages, tick=1, env=object())
    assert router.drain("player_1")
    assert router.drain("player_2")
    assert router.drain("player_3")


def test_broadcast_hook_limits_delivery_and_is_resolved_once_per_sender():
    calls: list[str] = []

    class Ring:
        def broadcast_recipients(self, sender: str) -> tuple[str, ...]:
            calls.append(sender)
            return ("player_2",)

    router = _router()
    messages = router.validate_outgoing(
        "player_0", [{"to": None, "text": "one"}, {"to": "player_1", "text": "direct"}]
    )
    router.deliver(messages, tick=1, env=Ring())
    assert calls == ["player_0"]
    assert router.drain("player_2") == [{"from": "player_0", "to": None, "text": "one", "tick": 1}]
    assert router.drain("player_1") == [{"from": "player_0", "to": "player_1", "text": "direct", "tick": 1}]
    assert router.drain("player_3") == []


@pytest.mark.parametrize(
    ("declared", "diagnostic"),
    [
        ("player_1", "not a sequence"),
        (("player_1", "player_1"), "same recipient twice"),
        (("player_0",), "sender as one of its own"),
        (("player_9",), "unknown recipient"),
        ((1,), "non-string recipient"),
    ],
)
def test_invalid_broadcast_hook_falls_back_to_the_default_audience(declared, diagnostic, capsys):
    class Broken:
        def broadcast_recipients(self, sender: str):
            return declared

    router = _router()
    messages = router.validate_outgoing("player_0", [{"to": None, "text": "fallback"}])
    router.deliver(messages, tick=1, env=Broken())
    assert diagnostic in capsys.readouterr().err
    assert all(router.drain(player) for player in ("player_1", "player_2", "player_3"))


def test_raising_broadcast_hook_falls_back_and_inactive_audience_members_are_silently_filtered(capsys):
    class Raising:
        def broadcast_recipients(self, sender: str):
            raise RuntimeError("broken")

    router = _router()
    router.set_active(("player_0", "player_1"))
    messages = router.validate_outgoing("player_0", [{"to": None, "text": "fallback"}])
    router.deliver(messages, tick=1, env=Raising())
    assert "broadcast recipients failed" in capsys.readouterr().err
    assert router.drain("player_1")


def test_an_empty_valid_broadcast_audience_delivers_nothing():
    class Empty:
        def broadcast_recipients(self, sender: str) -> tuple[str, ...]:
            return ()

    router = _router()
    messages = router.validate_outgoing("player_0", [{"to": None, "text": "quiet"}])
    router.deliver(messages, tick=1, env=Empty())
    assert all(router.drain(player) == [] for player in ("player_1", "player_2", "player_3"))


def test_a_policy_naming_an_inactive_recipient_is_filtered_rather_than_voided(capsys):
    """An environment naming a departed player must not have its whole policy widened to the default."""
    router = _router()
    router.set_active(("player_0", "player_1"))
    policy = router.validate_policy(
        "player_0",
        {"target_recipients": ("player_1", "player_2"), "default_recipient": "player_2"},
    )
    # player_2 is gone, so it leaves the list, and the default it held falls back to broadcast. The
    # surviving restriction still excludes player_3, which the default policy would have permitted.
    assert policy.target_recipients == ("player_1",)
    assert policy.default_recipient is None
    assert capsys.readouterr().err == ""
    assert router.validate_outgoing("player_0", [{"to": "player_3", "text": "nope"}], policy) == []
