"""Game Sandbox session harness.

Stage 1 shipped the cross-boundary contract pieces: schema validation, typed state builders,
and the recording store. Stage 2 adds the session loop and its surrounding machinery — the
agent interface, the manifest loader, the environment metadata and registry, the injectable
clock, and ``run_episode`` with its player bindings and action sources. Stage 3 factors the loop
into an ``Episode`` whose ``step_once`` both ``run_episode`` and the live container runner drive.
Environments live in a separate package discovered through entry points; the harness never
imports them.
"""

from .agent import (
    AgentBase,
    has_chat,
    has_learn,
    is_agent,
)
from .clock import Clock, ManualClock, SystemClock
from .environment import (
    ENTRY_POINT_GROUP,
    EnvironmentEntry,
    EnvironmentLookupError,
    EnvironmentMeta,
    EnvParameter,
    EnvParameterChoice,
    EnvParameterValueError,
    ParameterValue,
    PlayerBounds,
    ResolvedLayout,
    ResolvedSeat,
    SeatPlan,
    SeatPlans,
    discover_environments,
    effective_parameters,
    load_environment,
    resolve_layout,
    resolve_parameters,
)
from .manifest import (
    Manifest,
    ManifestError,
    load_agent,
    load_manifest,
)
from .schema import (
    SCHEMA_VERSION,
    SchemaValidationError,
    validate_header,
    validate_step,
)
from .session import (
    ActionSource,
    AgentPlayer,
    Episode,
    EpisodeResult,
    ExternalPlayer,
    NoopSource,
    ScriptedSource,
    run_episode,
)
from .state import (
    AgentStep,
    Message,
    RecordingHeader,
    StepState,
    StepTiming,
    build_agent_step,
    build_header,
    build_step_state,
)

__all__ = [
    # schema
    "SCHEMA_VERSION",
    "SchemaValidationError",
    "validate_header",
    "validate_step",
    # state
    "AgentStep",
    "Message",
    "RecordingHeader",
    "StepState",
    "StepTiming",
    "build_agent_step",
    "build_header",
    "build_step_state",
    # agent
    "AgentBase",
    "is_agent",
    "has_learn",
    "has_chat",
    # clock
    "Clock",
    "SystemClock",
    "ManualClock",
    # environment
    "ENTRY_POINT_GROUP",
    "ParameterValue",
    "EnvParameterChoice",
    "EnvParameter",
    "EnvParameterValueError",
    "EnvironmentMeta",
    "PlayerBounds",
    "SeatPlan",
    "SeatPlans",
    "ResolvedSeat",
    "ResolvedLayout",
    "EnvironmentEntry",
    "EnvironmentLookupError",
    "discover_environments",
    "load_environment",
    "effective_parameters",
    "resolve_parameters",
    "resolve_layout",
    # manifest
    "Manifest",
    "ManifestError",
    "load_manifest",
    "load_agent",
    # session
    "ActionSource",
    "AgentPlayer",
    "ExternalPlayer",
    "NoopSource",
    "ScriptedSource",
    "Episode",
    "EpisodeResult",
    "run_episode",
]
