"""Game Sandbox session harness.

Stage 1 ships the cross-boundary contract pieces: schema validation, typed state
builders, and the recording store. The session loop and environments arrive in
later stages.
"""

from game_sandbox_harness.schema import (
    SCHEMA_VERSION,
    SchemaValidationError,
    validate_header,
    validate_step,
)
from game_sandbox_harness.state import (
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
    "SCHEMA_VERSION",
    "SchemaValidationError",
    "validate_header",
    "validate_step",
    "AgentStep",
    "Message",
    "RecordingHeader",
    "StepState",
    "StepTiming",
    "build_agent_step",
    "build_header",
    "build_step_state",
]
