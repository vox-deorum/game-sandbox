"""Turn-authoritative messaging bookkeeping for external (human) players.

An agent chats whenever its turn comes up, so the session loop can hand its batch straight to the
:class:`~game_sandbox_harness.chat.ChatRouter`. A human cannot: the browser composes against a
state it has already been shown, and that frame arrives over a socket that races the loop. So a
human turn needs three things the agent path does not, and this module owns all three:

* Announcing an opportunity. Each published state names the next external actor, the recipients
  the environment allows it, and the recipient selected by default.
* Admitting a frame. A queued frame carries the tick it was composed against. Only the current
  announced tick and, for one drain, the immediately preceding announced tick are admitted, so a
  frame that raced the previous drain survives while an older one does not.
* Applying the announced policy. A frame is validated against exactly the choices its opportunity
  published, not against whatever the environment would answer now.

Keeping this beside the step loop rather than inside it means the tick window and the policy cache
are read and written in one place, so an accepted frame can never be governed by a policy the
sender was not shown.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, cast

from .chat import ChatRouter, diag
from .environment import ChatPolicy
from .state import ChatOptions, Message

#: How many announced ticks stay admissible for one sender. The newest is the live opportunity; the
#: one before it is the single-drain grace that covers a frame which raced the previous drain.
_ADMISSIBLE_TICKS = 2


@dataclass(frozen=True)
class _AnnouncedOpportunity:
    """One published compose tick paired with the policy the external player was shown."""

    tick: int
    policy: ChatPolicy


class ExternalChatCoordinator:
    """Owns the announced opportunities, their policies, and the admission rule for one episode.

    Constructed only when messaging is enabled, alongside the router it validates through. The
    environment is passed per call rather than held, because the episode creates it in ``start``
    and replaces nothing afterwards.
    """

    def __init__(self, router: ChatRouter) -> None:
        self._router = router
        self._announced: dict[str, tuple[_AnnouncedOpportunity, ...]] = {}

    def announce(self, env: Any, sender: str, tick: int) -> ChatOptions:
        """Publish one external actor's messaging choices and open its opportunity at ``tick``.

        The caller has already established that ``sender`` is the next external actor and is still
        live. The resolved policy is cached here so the drain that consumes this opportunity
        enforces exactly the choices published with it.
        """
        opportunities = self._announced.get(sender, ())
        if opportunities and opportunities[-1].tick == tick:
            policy = opportunities[-1].policy
        else:
            policy = self._router.policy_from(env, sender)
            announced = _AnnouncedOpportunity(tick=tick, policy=policy)
            self._announced[sender] = (*opportunities, announced)[-_ADMISSIBLE_TICKS:]
        return {
            "sender": sender,
            "target_recipients": list(policy.target_recipients),
            "default_recipient": policy.default_recipient,
        }

    def drain(self, current_player: str, queued: object) -> list[Message]:
        """Admit this turn's queued frames and validate them under their announced policy.

        Returns the accepted messages, already stamped with their sender. Every rejection is dropped
        with a stderr diagnostic, matching how agent output is handled.
        """
        frames = self._admitted_frames(current_player, queued)
        return self._router.validate_outgoing_items(current_player, frames)

    def _admitted_frames(
        self,
        current_player: str,
        queued: object,
    ) -> list[tuple[dict[str, object], ChatPolicy]]:
        """Pair admitted frames with their published policies, then close the grace window."""
        if not isinstance(queued, list):
            diag(f"chat: external player {current_player} returned a non-list queue; dropping it")
            return []
        opportunities = self._announced.get(current_player, ())
        policies = {opportunity.tick: opportunity.policy for opportunity in opportunities}
        admissible_ticks = tuple(policies)
        # The preceding opportunity is good for this drain only. A frame that misses two drains is
        # stale even when the sender has composed nothing newer.
        if opportunities:
            self._announced[current_player] = opportunities[-1:]
        admitted: list[tuple[dict[str, object], ChatPolicy]] = []
        for raw_frame in cast("list[object]", queued):
            if not isinstance(raw_frame, Mapping):
                diag(f"chat: external player {current_player} queued a non-object frame; dropping it")
                continue
            frame = cast("Mapping[str, object]", raw_frame)
            sender = frame.get("player")
            if sender != current_player:
                diag(
                    f"chat: dropping spoofed or inactive external sender {sender!r}; "
                    f"current player is {current_player!r}"
                )
                continue
            tick = frame.get("tick")
            if tick not in policies:
                diag(
                    f"chat: dropping stale external message for {current_player!r} "
                    f"at tick {tick!r}; expected one of {admissible_ticks!r}"
                )
                continue
            item = {"to": frame.get("to"), "text": frame.get("text")}
            admitted.append((item, policies[cast("int", tick)]))
        return admitted
