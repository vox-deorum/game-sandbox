"""Typed shapes and builders for the per-step state object and the recording header.

These TypedDicts mirror the JSON Schema field-for-field (snake_case throughout) and the
builders produce schema-valid payloads by construction. They are a thin construction
ergonomics layer; the schema in :mod:`game_sandbox_harness.schema` remains the single
source of truth, and the recording store validates on write regardless.
"""

from __future__ import annotations

from typing import Any, NotRequired, TypedDict

from game_sandbox_harness.schema import SCHEMA_VERSION


class StepTiming(TypedDict):
    """Wall-clock timing for a whole step."""

    started_at: int  # epoch milliseconds UTC
    duration_ms: float


class AgentTiming(TypedDict, total=False):
    """Per-agent timing. ``learn_ms`` and ``chat_ms`` may be added later additively."""

    decision_ms: float


class AgentStep(TypedDict):
    """Per-agent data for one step. ``observation`` and ``action`` are environment-specific."""

    observation: NotRequired[Any]
    action: NotRequired[Any]
    reward: float
    score: float
    timing: NotRequired[AgentTiming]


# ``from`` is a Python keyword, so Message must use the functional TypedDict form.
Message = TypedDict(
    "Message",
    {
        "from": str,
        "to": str | None,  # None means broadcast.
        "text": str,
    },
)


class StepState(TypedDict):
    """One per-step state object."""

    schema_version: int
    tick: int
    agents: dict[str, AgentStep]
    overlay: NotRequired[dict[str, Any]]
    messages: NotRequired[list[Message]]
    timing: StepTiming


class RecordingHeader(TypedDict):
    """Line 1 of a recording / first frame of a live stream."""

    schema_version: int
    environment: str
    created_at: NotRequired[str]
    seed: NotRequired[int]
    sidecars: NotRequired[list[Sidecar]]


class Sidecar(TypedDict):
    """A declared auxiliary file alongside a recording."""

    name: str
    path: str


def build_agent_step(
    *,
    reward: float,
    score: float,
    observation: Any = None,
    action: Any = None,
    decision_ms: float | None = None,
) -> AgentStep:
    """Build a per-agent step. ``observation``/``action`` default to absent when None."""
    step: AgentStep = {"reward": reward, "score": score}
    if observation is not None:
        step["observation"] = observation
    if action is not None:
        step["action"] = action
    if decision_ms is not None:
        step["timing"] = {"decision_ms": decision_ms}
    return step


def build_step_state(
    *,
    tick: int,
    agents: dict[str, AgentStep],
    started_at: int,
    duration_ms: float,
    overlay: dict[str, Any] | None = None,
    messages: list[Message] | None = None,
) -> StepState:
    """Build a per-step state object stamped with the current schema version."""
    state: StepState = {
        "schema_version": SCHEMA_VERSION,
        "tick": tick,
        "agents": agents,
        "timing": {"started_at": started_at, "duration_ms": duration_ms},
    }
    if overlay is not None:
        state["overlay"] = overlay
    if messages:
        state["messages"] = messages
    return state


def build_header(
    *,
    environment: str,
    created_at: str | None = None,
    seed: int | None = None,
    sidecars: list[Sidecar] | None = None,
) -> RecordingHeader:
    """Build a recording header stamped with the current schema version."""
    header: RecordingHeader = {
        "schema_version": SCHEMA_VERSION,
        "environment": environment,
    }
    if created_at is not None:
        header["created_at"] = created_at
    if seed is not None:
        header["seed"] = seed
    if sidecars is not None:
        header["sidecars"] = sidecars
    return header
