"""The Hearts oracle follows one legal completion and falls back on terminal failures."""

from __future__ import annotations

from types import SimpleNamespace

import agent
import pytest
from openai import OpenAIError
from sandbox.cards import CLUBS, HEARTS, SPADES, play


def _observation(legal: list[dict[str, int]]) -> dict:
    mask = [0] * 52
    for card in legal:
        mask[play(card)] = 1
    return {
        "action_mask": mask,
        "observation": {
            "seat": 2,
            "hand": tuple(legal),
            "current_trick": (
                {"seat": 0, "card": {"suit": CLUBS, "rank": 10}},
                {"seat": 1, "card": {"suit": CLUBS, "rank": 4}},
            ),
            "trick_leader": 0,
            "led_suit": CLUBS,
            "hearts_broken": 1,
            "scores": [0, 4, 8, 0],
        },
    }


class _Completions:
    def __init__(self, *, content: str | None = None, error: OpenAIError | None = None) -> None:
        self.content = content
        self.error = error
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        message = SimpleNamespace(content=self.content)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _install_client(monkeypatch: pytest.MonkeyPatch, completions: _Completions) -> None:
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    seen: list[int] = []

    def openai(*, max_retries: int):
        seen.append(max_retries)
        assert max_retries == 0
        return client

    monkeypatch.setattr(agent, "OpenAI", openai)


def test_backend_recovered_success_is_one_client_visible_response(monkeypatch: pytest.MonkeyPatch):
    legal = [
        {"suit": CLUBS, "rank": 2},
        {"suit": CLUBS, "rank": 11},
        {"suit": SPADES, "rank": 12},
    ]
    # The backend pipeline separately proves its retry sequence. At the oracle boundary, a retryable
    # upstream failure that recovered is one ordinary successful response to one SDK call.
    completions = _Completions(content="I choose q OF spades.")
    _install_client(monkeypatch, completions)
    monkeypatch.setenv("OPENAI_MODEL", "small")

    assert agent.Agent().act(_observation(legal)) == play({"suit": SPADES, "rank": 12})
    assert len(completions.calls) == 1
    assert completions.calls[0]["model"] == "small"
    assert completions.calls[0]["stream"] is False
    assert "Legal: 2 of clubs | J of clubs | Q of spades" in completions.calls[0]["messages"][0]["content"]


@pytest.mark.parametrize(
    ("content", "case"),
    [
        ("Play A of hearts", "illegal card"),
        ("2 of clubs or Q of spades", "ambiguous cards"),
        ("A of hearts or 2 of clubs", "illegal and legal cards"),
        ("I cannot decide", "no card"),
        (None, "missing content"),
    ],
)
def test_malformed_completion_uses_lowest_legal_fallback(
    monkeypatch: pytest.MonkeyPatch, content: str | None, case: str
):
    del case
    legal = [{"suit": HEARTS, "rank": 2}, {"suit": CLUBS, "rank": 2}, {"suit": CLUBS, "rank": 9}]
    _install_client(monkeypatch, _Completions(content=content))

    assert agent.Agent().act(_observation(legal)) == play({"suit": CLUBS, "rank": 2})


@pytest.mark.parametrize(
    "message",
    [
        "budget_exceeded: token budget exhausted",
        "invalid_request: non-retryable upstream error",
        "upstream_timeout: retries exhausted",
    ],
)
def test_terminal_openai_errors_use_lowest_legal_fallback(monkeypatch: pytest.MonkeyPatch, message: str):
    legal = [{"suit": SPADES, "rank": 7}, {"suit": HEARTS, "rank": 3}]
    completions = _Completions(error=OpenAIError(message))
    _install_client(monkeypatch, completions)

    assert agent.Agent().act(_observation(legal)) == play({"suit": HEARTS, "rank": 3})
    assert len(completions.calls) == 1
