"""The pure rules engine for four-player partnership Spades.

This module is the single source of truth for bidding, card legality, and scoring. Like the
Hearts engine it is deliberately dependency-free (it imports only the standard library), so the
same rules can drive the PettingZoo environment, a reference bot, and tests without dragging in
``pettingzoo`` or ``numpy``. Everything is expressed over the fixed
integer card encoding below, which downstream code relies on verbatim.

Card encoding (fixed, identical to Hearts): a card is an int ``0..51`` with
``card = suit * 13 + rank``. Suits are ``0=clubs, 1=diamonds, 2=spades, 3=hearts`` and ranks run
``0=2 .. 8=10, 9=J, 10=Q, 11=K, 12=A``. So ``2♣ == 0`` and ``A♠ == 38``. Players are ints ``0..3``
and the next player clockwise is ``(player + 1) % 4``.

Action encoding (the ``Discrete(66)`` combined space, shared with the env): actions ``0..51`` are
cards, and action ``52 + k`` is a bid of ``k`` (``0..13``, where ``0`` is nil). Which subset is
legal depends on the phase (only bids during bidding, only cards during play), and is what
:func:`legal_actions` returns.

Partnerships: players ``0`` and ``2`` are one team, players ``1`` and ``3`` the other, so a player's
team is ``player % 2``. One hand per episode: a bidding round (player 0 first), then thirteen tricks
(player 0 leads).
"""

from __future__ import annotations

import importlib
import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any


def _shared_card_utils() -> Any:
    """Return the shared :mod:`card_utils` under whichever name this file runs as.

    One source syncs into two layouts: :mod:`local_play.card_utils` inside the environments package,
    ``sandbox.card_utils`` in a composed template. A :class:`ModuleNotFoundError` naming the absent
    candidate is swallowed; one naming a real dependency is re-raised. This keeps the pure engine
    dependency-free while sharing one card encoding.
    """
    for candidate in ("local_play.card_utils", "sandbox.card_utils"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError as exc:
            missing = exc.name or ""
            if missing == candidate or candidate.startswith(f"{missing}."):
                continue
            raise
    raise ModuleNotFoundError("no shared card_utils found (tried local_play.card_utils, sandbox.card_utils)")


if TYPE_CHECKING:  # pyright sees the real module; this branch never executes at runtime
    from local_play import card_utils as _cu
else:
    _cu = _shared_card_utils()

#: Suit ids, deck size, and the suit/rank codec, re-exported from the shared codec (identical to
#: Hearts) so both engines and every reader share one encoding, comparing on the rank *index* (``0..12``).
NUM_CARDS = _cu.NUM_CARDS
CLUBS = _cu.CLUBS
DIAMONDS = _cu.DIAMONDS
SPADES = _cu.SPADES
HEARTS = _cu.HEARTS
suit_of = _cu.suit_of
rank_of = _cu.rank_of

#: Number of players at the table.
NUM_PLAYERS = 4
#: Cards dealt to each player.
HAND_SIZE = 13
#: Tricks played in a full hand.
NUM_TRICKS = 13

#: Bids run 0..13 (fourteen distinct bids); a bid of 0 is nil.
NUM_BIDS = HAND_SIZE + 1
#: The bid meaning "I will take zero tricks", worth ±100 to the bidder, scored separately.
NIL_BID = 0
#: The flat stake a nil rides for, win or lose. No blind/double nil is offered, so it is fixed.
NIL_STAKE = 100

#: The combined action space is ``Discrete(52 + 14)``: cards 0..51, then bids as ``52 + k``.
BID_OFFSET = NUM_CARDS
ACTION_SPACE_SIZE = NUM_CARDS + NUM_BIDS


def team_of(player: int) -> int:
    """Return the partnership id (``0`` for players 0 & 2, ``1`` for players 1 & 3) of ``player``."""
    return player % 2


def team_players(team: int) -> tuple[int, int]:
    """Return the two players making up ``team``: ``(0, 2)`` for team 0, ``(1, 3)`` for team 1."""
    return (team, team + 2)


def bid_to_action(bid: int) -> int:
    """Encode a bid of ``bid`` tricks (``0..13``) as its action-space integer ``52 + bid``."""
    return BID_OFFSET + bid


def action_is_bid(action: int) -> bool:
    """Return whether ``action`` names a bid (``>= 52``) rather than a card (``0..51``)."""
    return action >= BID_OFFSET


def action_to_bid(action: int) -> int:
    """Decode a bid action ``52 + k`` back to the bid ``k``. Caller ensures it is a bid action."""
    return action - BID_OFFSET


@dataclass
class SpadesState:
    """The full mutable game state for one hand of Spades.

    ``hands`` are kept sorted ascending. ``bids`` holds each player's bid, ``-1`` until that player has
    bid; the hand is in its bidding phase while any entry is ``-1`` (see :func:`in_bidding`), and in
    its play phase once all four are set. ``current_trick`` holds ``(player, card)`` pairs in play
    order and is empty between tricks. ``tricks_won`` counts the tricks each player has taken, which
    is all scoring needs (a set nil's tricks count for its partnership, so per-player counts suffice).
    """

    hands: list[list[int]]
    bids: list[int] = field(default_factory=lambda: [-1, -1, -1, -1])
    current_trick: list[tuple[int, int]] = field(default_factory=list)
    trick_leader: int = 0
    turn: int = 0
    spades_broken: bool = False
    tricks_played: int = 0
    tricks_won: list[int] = field(default_factory=lambda: [0, 0, 0, 0])
    last_trick: list[tuple[int, int]] | None = None
    last_trick_winner: int | None = None


def deal(rng: random.Random) -> SpadesState:
    """Shuffle a fresh deck with ``rng`` and deal a new hand. Player 0 bids first and leads first.

    The fixed player-0-first convention (pinned by a test) lets the scheduler, examples, and e2e
    journeys rely on the same player opening the bidding and the play every hand.
    """
    deck = list(range(NUM_CARDS))
    rng.shuffle(deck)
    hands = [sorted(deck[player * HAND_SIZE : (player + 1) * HAND_SIZE]) for player in range(NUM_PLAYERS)]
    return SpadesState(
        hands=hands,
        bids=[-1, -1, -1, -1],
        current_trick=[],
        trick_leader=0,
        turn=0,
        spades_broken=False,
        tricks_played=0,
        tricks_won=[0, 0, 0, 0],
        last_trick=None,
        last_trick_winner=None,
    )


# -- phase -----------------------------------------------------------------------------------


def in_bidding(state: SpadesState) -> bool:
    """Return whether the hand is still in the bidding round (some player has not yet bid)."""
    return -1 in state.bids


def led_suit(state: SpadesState) -> int | None:
    """Return the suit led in the current trick, or ``None`` if no card has been played yet."""
    if not state.current_trick:
        return None
    return suit_of(state.current_trick[0][1])


# -- bidding ---------------------------------------------------------------------------------


def legal_bids(state: SpadesState, player: int) -> list[int]:
    """Return the bids ``player`` may make: every value ``0..13`` is always legal, nil included.

    There is no blind or double nil (every bid is made with the hand in view), so the legal set
    never depends on the hand, only on the phase (this is meaningful only during bidding).
    """
    return list(range(NUM_BIDS))


def suggested_bid(hand: list[int]) -> int:
    """Return a deterministic, never-nil trick estimate for ``hand`` (a defensive timeout default).

    A simple high-card-and-length count: high spades and off-suit aces are near-certain tricks,
    guarded off-suit kings usually are, and every spade beyond a holding of three tends to win by
    length. Floored at ``1`` so a timeout never silently commits a partnership to a nil, and capped
    at ``13``. Pure function of the hand, so the same hand always yields the same bid.
    """
    estimate = 0
    spades = [card for card in hand if suit_of(card) == SPADES]
    # High spades (Q, K, A) are strong winners; extra length beyond three tends to score too.
    estimate += sum(1 for card in spades if rank_of(card) >= 10)
    estimate += max(0, len(spades) - 3)
    # Off-suit aces are tricks; a king with at least one guard usually survives to win.
    for suit in (CLUBS, DIAMONDS, HEARTS):
        suited = [card for card in hand if suit_of(card) == suit]
        estimate += sum(1 for card in suited if rank_of(card) == 12)
        estimate += sum(1 for card in suited if rank_of(card) == 11 and len(suited) >= 2)
    return max(1, min(HAND_SIZE, estimate))


def place_bid(state: SpadesState, bid: int) -> None:
    """Record ``bid`` as the bid of ``state.turn`` and advance the bidding, or open play.

    Bids are placed in player order 0→1→2→3; once the fourth is in, the hand enters its play phase
    with player 0 leading the first trick. The caller is expected to have validated legality; the
    assertions below are defensive guards, not the primary check.
    """
    player = state.turn
    assert in_bidding(state), "bidding is over"
    assert state.bids[player] == -1, ("already bid", player)
    assert 0 <= bid <= HAND_SIZE, ("bid out of range", bid)

    state.bids[player] = bid
    if player == NUM_PLAYERS - 1:
        # The last player has bid: play begins, player 0 leads.
        state.turn = 0
        state.trick_leader = 0
    else:
        state.turn = player + 1


# -- play ------------------------------------------------------------------------------------


def legal_plays(state: SpadesState, player: int) -> list[int]:
    """Return the sorted list of cards ``player`` may legally play right now (play phase only).

    Enforces following the led suit when able, and the spades-not-led-until-broken lead
    restriction with its all-spades escape valve, so the result is never empty for a player that
    still holds cards.
    """
    hand = state.hands[player]
    if not hand:
        return []

    led = led_suit(state)
    if led is not None:
        # Must follow the led suit if able; otherwise anything in hand is fair game.
        same_suit = [card for card in hand if suit_of(card) == led]
        candidates = same_suit if same_suit else list(hand)
    else:
        # Leading: spades are barred until broken, unless the hand is nothing but spades.
        non_spades = [card for card in hand if suit_of(card) != SPADES]
        candidates = list(hand) if state.spades_broken or not non_spades else non_spades

    return sorted(candidates)


def lowest_legal_card(state: SpadesState, player: int) -> int:
    """Return the legal card with the lowest rank (ties broken by suit). The play-phase default."""
    return min(legal_plays(state, player), key=lambda card: (rank_of(card), suit_of(card)))


def trick_winner(trick: list[tuple[int, int]]) -> int:
    """Return the player that wins a completed ``trick``: highest spade, else highest card led.

    A trick is won by the highest spade played to it (spades are always trump); when no spade
    appears, by the highest card of the suit that was led.
    """
    led = suit_of(trick[0][1])
    spades = [pair for pair in trick if suit_of(pair[1]) == SPADES]
    if spades:
        return max(spades, key=lambda pair: rank_of(pair[1]))[0]
    return max(
        (pair for pair in trick if suit_of(pair[1]) == led),
        key=lambda pair: rank_of(pair[1]),
    )[0]


def play_card(state: SpadesState, card: int) -> None:
    """Apply ``card`` as the play of ``state.turn``, resolving the trick when it completes.

    The caller is expected to have validated legality; the assertion below is a defensive guard.
    Playing any spade breaks spades for the rest of the hand.
    """
    player = state.turn
    assert not in_bidding(state), "still bidding"
    assert card in legal_plays(state, player), (player, card)

    state.hands[player].remove(card)
    state.current_trick.append((player, card))
    if suit_of(card) == SPADES:
        state.spades_broken = True

    if len(state.current_trick) == NUM_PLAYERS:
        winner = trick_winner(state.current_trick)
        state.tricks_won[winner] += 1
        state.last_trick = list(state.current_trick)
        state.last_trick_winner = winner
        state.current_trick = []
        state.trick_leader = winner
        state.turn = winner
        state.tricks_played += 1
    else:
        state.turn = (state.turn + 1) % NUM_PLAYERS


# -- the combined action view (both phases) --------------------------------------------------


def legal_actions(state: SpadesState, player: int) -> list[int]:
    """Return the legal action-space integers for ``player`` on turn, in either phase.

    During bidding this is every bid encoded as ``52 + k``; during play it is the legal cards
    (already ``0..51``). This is the single source the env's action mask and both renderers read,
    so nothing downstream re-derives legality.
    """
    if in_bidding(state):
        return [bid_to_action(bid) for bid in legal_bids(state, player)]
    return legal_plays(state, player)


def is_legal_action(state: SpadesState, player: int, action: int) -> bool:
    """Return whether ``action`` (a card or a ``52 + k`` bid) is legal for ``player`` right now."""
    return action in legal_actions(state, player)


def resolve_auto_action(state: SpadesState, player: int) -> int:
    """Return the action a timeout applies for ``player``: a never-nil suggested bid, or lowest card.

    During bidding it resolves to :func:`suggested_bid` (encoded as a bid action), which is never
    nil, because nil is a deliberate gamble no timeout should impose on a partnership. During play
    it resolves to the lowest legal card, matching the Hearts timeout default.
    """
    if in_bidding(state):
        return bid_to_action(suggested_bid(state.hands[player]))
    return lowest_legal_card(state, player)


def is_terminal(state: SpadesState) -> bool:
    """Return whether all 13 tricks have been played."""
    return state.tricks_played == NUM_TRICKS


# -- scoring ---------------------------------------------------------------------------------


def team_score(bids: list[int], tricks_won: list[int], team: int) -> int:
    """Return ``team``'s single-hand score from the final ``bids`` and per-player ``tricks_won``.

    Standard single-hand partnership scoring, with the variant choices this engine pins:

    * The team's contract is the sum of its partners' **non-nil** bids. Making it (team tricks at
      least the contract) scores ten points per bid trick plus one per overtrick (bag); failing it
      scores minus ten per bid trick.
    * A nil is scored per bidder on top: a made nil (that player took zero tricks) earns 100, a set
      nil loses 100. A set nil's tricks still count toward the partnership's trick total, so they
      count toward making the contract and toward bags under the normal rules (they help make the
      contract when it is otherwise reachable, but a contract left short is still set); the nil
      penalty is charged separately. When both partners bid nil the contract is zero and trivially
      made, so every trick either takes lands as a bag beside the nil penalties.

    The ten-bag penalty is deliberately omitted: it only bites across accumulated hands, and an
    episode is a single hand.
    """
    players = team_players(team)
    contract = sum(bids[player] for player in players if bids[player] > NIL_BID)
    team_tricks = sum(tricks_won[player] for player in players)

    # Made (team tricks at least the contract): ten per bid trick, plus one per overtrick (bag).
    # Set: minus ten per bid trick.
    made = team_tricks >= contract
    base = 10 * contract + (team_tricks - contract) if made else -10 * contract

    nil = 0
    for player in players:
        if bids[player] == NIL_BID:
            nil += NIL_STAKE if tricks_won[player] == 0 else -NIL_STAKE

    return base + nil


def hand_team_scores(state: SpadesState) -> list[int]:
    """Return ``[team 0 score, team 1 score]`` from the current bids and tricks won.

    Final once the hand is terminal; during play it is a running projection (the score as if the
    hand ended now), mirroring the running-penalty precedent in the Hearts engine.
    """
    return [team_score(state.bids, state.tricks_won, team) for team in range(2)]


def leaderboard_scores(state: SpadesState) -> list[int]:
    """Return the per-player leaderboard score (higher is better): the player's team hand score.

    Both partners share their team's raw score by construction: a player is ranked by how its team
    fared, and the browser game-over standings ranks players by this, mirroring the raw negated-penalty
    precedent in ``hearts.rules``. Team scores reach into the hundreds in both directions (the floor
    is minus 260, both partners bidding 13), so these are int16-range values, not the int8 that
    suffices for Hearts penalties.
    """
    scores = hand_team_scores(state)
    return [scores[team_of(player)] for player in range(NUM_PLAYERS)]
