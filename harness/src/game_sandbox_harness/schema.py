"""Load the packaged schema and validate payloads against it.

The canonical schema lives under ``schema/`` at the repository root. ``scripts/generate.py``
copies byte-identical bytes into ``schema_data/`` in this package, so editable dev
installs, built wheels inside session containers, and CI all read the same files. We
validate directly against those files rather than against generated models, so there is
zero drift between the contract and the validator by construction.
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

#: The single integer schema version this harness produces and accepts.
SCHEMA_VERSION = 1

_STEP_STATE_FILE = "step-state.schema.json"
_RECORDING_HEADER_FILE = "recording-header.schema.json"


class SchemaValidationError(ValueError):
    """Raised when a payload fails validation against its schema."""


def _load_schema(filename: str) -> dict[str, Any]:
    data = (
        resources.files("game_sandbox_harness.schema_data")
        .joinpath(filename)
        .read_text(encoding="utf-8")
    )
    return json.loads(data)


def _build_validator(filename: str) -> Draft202012Validator:
    schema = _load_schema(filename)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


# Validators are compiled once per process. If per-step validation ever shows up in a
# profile, fastjsonschema can replace the implementation behind these same functions.
_step_validator = _build_validator(_STEP_STATE_FILE)
_header_validator = _build_validator(_RECORDING_HEADER_FILE)


def _validate(validator: Draft202012Validator, payload: Any, label: str) -> None:
    # jsonschema types iter_errors as an untyped overload, so pyright cannot narrow it;
    # we re-assert the documented return type here.
    errors: list[ValidationError] = sorted(
        validator.iter_errors(payload),  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
        key=lambda e: list(e.absolute_path),
    )
    if errors:
        first = errors[0]
        location = "/".join(str(p) for p in first.absolute_path) or "<root>"
        raise SchemaValidationError(f"{label} invalid at {location}: {first.message}")


def validate_step(payload: Any) -> None:
    """Validate a per-step state object, raising :class:`SchemaValidationError` on failure."""
    _validate(_step_validator, payload, "step state")


def validate_header(payload: Any) -> None:
    """Validate a recording header, raising :class:`SchemaValidationError` on failure."""
    _validate(_header_validator, payload, "recording header")
