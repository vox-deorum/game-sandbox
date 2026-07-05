"""The message router and single validation point: routing, delivery, and every rejection.

Pure units on :class:`~game_sandbox_harness.chat.ChatRouter`, with ``capsys`` asserting the stderr
diagnostic on every drop. The cap is counted in Unicode code points, pinned with an astral-plane
fixture so an emoji costs one.
"""

from __future__ import annotations

from game_sandbox_harness.chat import ChatRouter

SLOTS = ("player_0", "player_1", "player_2", "player_3")


def _router(cap: int | None = None) -> ChatRouter:
    return ChatRouter(SLOTS, cap)


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
