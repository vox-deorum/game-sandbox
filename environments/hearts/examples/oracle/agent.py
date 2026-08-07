"""A Hearts example that asks the class LLM proxy to choose one legal card."""

from __future__ import annotations

import re

from dotenv import load_dotenv
from openai import OpenAI, OpenAIError
from sandbox.cards import (
    SUIT_NAMES,
    Card,
    HeartsObservation,
    card_name,
    current_trick,
    hearts_broken,
    legal_cards,
    my_player,
    play,
    rank_of,
    suit_of,
)

NAME = "oracle-hearts"

_CARD_PATTERN = re.compile(
    r"(?<!\w)(10|[2-9JQKA])\s+(?:of\s+)?(clubs|diamonds|spades|hearts)(?!\w)",
    re.IGNORECASE,
)
_RANKS = {str(rank): rank for rank in range(2, 11)} | {"J": 11, "Q": 12, "K": 13, "A": 14}
_SUITS = {name: suit for suit, name in enumerate(SUIT_NAMES)}


def _lowest(cards: list[Card]) -> Card:
    """Return the deterministic low-rank fallback, breaking ties by suit."""
    return min(cards, key=lambda card: (rank_of(card), suit_of(card)))


def _parse_choice(text: str, legal: list[Card]) -> Card | None:
    """Parse exactly one distinct legal card name from a completion."""
    choices: list[Card] = []
    for rank_text, suit_text in _CARD_PATTERN.findall(text):
        card: Card = {"suit": _SUITS[suit_text.lower()], "rank": _RANKS[rank_text.upper()]}
        if card not in choices:
            choices.append(card)
    return choices[0] if len(choices) == 1 and choices[0] in legal else None


def _prompt(observation: HeartsObservation, legal: list[Card]) -> str:
    """Build the compact legal-card and current-trick prompt."""
    trick = current_trick(observation)
    trick_text = ", ".join(f"player {player}: {card_name(card)}" for player, card in trick) or "empty"
    legal_text = " | ".join(card_name(card) for card in legal)
    return (
        "Choose one legal Hearts card. Reply only with its card name.\n"
        f"You are player {my_player(observation)}. Hearts broken: {hearts_broken(observation)}.\n"
        f"Trick: {trick_text}.\nLegal: {legal_text}"
    )


class Agent:
    """Use one model call per turn, with a legal deterministic fallback on terminal failure."""

    def __init__(self) -> None:
        load_dotenv()

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: HeartsObservation) -> int:
        legal = legal_cards(observation)
        fallback = _lowest(legal)
        try:
            # The backend owns retries. Disabling SDK retries keeps each turn to one logical
            # request and lets terminal backend errors reach the legal fallback immediately.
            response = OpenAI(max_retries=0).chat.completions.create(
                model="small",
                messages=[{"role": "user", "content": _prompt(observation, legal)}],
                stream=False,
            )
            content = response.choices[0].message.content
            chosen = _parse_choice(content or "", legal)
        except (OpenAIError, AttributeError, IndexError, TypeError):
            # Budget errors, non-retryable errors, and exhausted backend retries all arrive as
            # terminal SDK errors. A malformed success follows the same legal fallback below.
            chosen = None
        return play(chosen if chosen is not None else fallback)
