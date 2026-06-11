"""Public-facing environment metadata and the registry entry.

These types live in the harness, not the environments package, because the harness loop and
the Stage 3 container consume them while the environments package already depends on the
harness; putting them the other way round would be an import cycle. The harness itself never
imports the environments package or PettingZoo — environments are discovered through Python
entry points and their AEC envs are used duck-typed (hence the ``Any`` factory return).

:class:`EnvironmentMeta` is pure, serialisable data — the layer the backend serves to the
frontend verbatim. :class:`EnvironmentEntry` adds the non-serialisable hooks (the factory,
the default-action provider, the overlay extractor) and is what an environment registers.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from importlib.metadata import entry_points
from typing import Any

#: The entry-point group every environment registers its ``ENTRY`` under.
ENTRY_POINT_GROUP = "game_sandbox.environments"


@dataclass(frozen=True)
class EnvironmentMeta:
    """The serialisable public-facing metadata for one environment.

    Field-for-field the layer described in the environment spec. ``human_timeout_ms`` is
    ``None`` when a ``pace_interval_ms`` is set, because a set pace interval is itself the
    human deadline; ``pace_interval_ms`` is ``None`` for turn-based environments.
    """

    env_id: str
    display_name: str
    description: str
    min_slots: int
    max_slots: int
    human_slots: tuple[str, ...]
    human_timeout_ms: int | None
    recommended_episode_ticks: int
    pace_interval_ms: int | None
    step_limit_ms: int
    episode_limit_ms: int
    messaging: bool
    message_cap: int | None
    llm: bool
    renderer: str

    def to_json(self) -> dict[str, Any]:
        """Return the snake_case JSON-serialisable dict the backend serves verbatim."""
        return {
            "env_id": self.env_id,
            "display_name": self.display_name,
            "description": self.description,
            "min_slots": self.min_slots,
            "max_slots": self.max_slots,
            "human_slots": list(self.human_slots),
            "human_timeout_ms": self.human_timeout_ms,
            "recommended_episode_ticks": self.recommended_episode_ticks,
            "pace_interval_ms": self.pace_interval_ms,
            "step_limit_ms": self.step_limit_ms,
            "episode_limit_ms": self.episode_limit_ms,
            "messaging": self.messaging,
            "message_cap": self.message_cap,
            "llm": self.llm,
            "renderer": self.renderer,
        }


@dataclass(frozen=True)
class EnvironmentEntry:
    """A full environment registration: metadata plus the harness-facing hooks.

    - ``meta`` is the pure data above.
    - ``make`` is a zero-argument factory returning a fresh AEC env; the seed arrives at
      ``reset``, not here, so a factory can be called once per episode.
    - ``default_action`` returns the environment-provided legal action the loop applies on
      every timeout path for a slot (noop for Flappy Bird).
    - ``overlay`` optionally extracts the per-step overlay dict from a live env instance.
    """

    meta: EnvironmentMeta
    make: Callable[[], Any]
    default_action: Callable[[str], Any]
    overlay: Callable[[Any], dict[str, Any]] | None = None


class EnvironmentLookupError(LookupError):
    """Raised when an environment id is not registered as an installed entry point."""


def discover_environments() -> dict[str, EnvironmentEntry]:
    """Return every installed environment keyed by id, via the entry-point registry.

    Uses ``importlib.metadata`` so the harness never imports the environments package: the
    dependency arrow points one way (environments -> harness) and stays there.
    """
    found: dict[str, EnvironmentEntry] = {}
    for ep in entry_points(group=ENTRY_POINT_GROUP):
        entry = ep.load()
        if not isinstance(entry, EnvironmentEntry):
            raise TypeError(
                f"entry point {ep.name!r} in group {ENTRY_POINT_GROUP!r} loaded a "
                f"{type(entry).__name__}, expected EnvironmentEntry"
            )
        found[ep.name] = entry
    return found


def load_environment(env_id: str) -> EnvironmentEntry:
    """Return the installed environment registered under ``env_id``.

    Raises :class:`EnvironmentLookupError` naming the available ids when none matches.
    """
    found = discover_environments()
    try:
        return found[env_id]
    except KeyError:
        available = ", ".join(sorted(found)) or "(none installed)"
        raise EnvironmentLookupError(
            f"no environment registered as {env_id!r}; available: {available}"
        ) from None
