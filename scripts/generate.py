"""Regenerate committed artifacts derived from schemas and environment sources.

One script refreshes every generated artifact, run as ``uv run python scripts/generate.py``:

1. The canonical JSON Schema files, emitted from the zod definitions (``schema/*.schema.json``).
2. Packaged schema copies in the Python harness (``harness/.../schema_data/``).
3. Golden fixtures written through the real recording store (``schema/fixtures/``).
4. Environment package metadata for the backend.

The zod definitions under ``schema/ts/src/schemas/`` are the source of truth for the wire
contract, so emission runs first and the packaged copies follow it. That ordering also keeps
the harness importable before the fixtures step imports it. CI runs this script and then checks
every generated target for changes, so an edit that was not regenerated fails the build.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys

from _envs import discover_environments, package_dirs
from _paths import (
    BACKEND_ENVIRONMENTS_JSON,
    BACKEND_GENERATED_DIR,
    ENVIRONMENTS_PYPROJECT,
    FIXTURES_DIR,
    HARNESS_SCHEMA_DATA,
    REPO_ROOT,
    SCHEMA_DIR,
    SCHEMA_FILES,
)


def copy_packaged_schema() -> None:
    """Copy the canonical schema files byte-for-byte into the harness package data."""
    HARNESS_SCHEMA_DATA.mkdir(parents=True, exist_ok=True)
    for name in SCHEMA_FILES:
        shutil.copyfile(SCHEMA_DIR / name, HARNESS_SCHEMA_DATA / name)
    print(f"  packaged schema -> {HARNESS_SCHEMA_DATA}")


def sync_environments_pyproject() -> None:
    """Regenerate environment entry points and wheel-package lists between owned markers."""
    discovered = discover_environments()
    entry_points = "\n".join(f'{env_id} = "{env_id}:ENTRY"' for env_id in discovered)
    packages = ", ".join(f'"{path.name}"' for path in package_dirs())
    replacements = {
        "# BEGIN GENERATED ENTRY POINTS": entry_points,
        "# BEGIN GENERATED WHEEL PACKAGES": f"packages = [{packages}]",
    }
    text = ENVIRONMENTS_PYPROJECT.read_text(encoding="utf-8")
    for begin, body in replacements.items():
        end = begin.replace("BEGIN", "END")
        start_index = text.find(begin)
        end_index = text.find(end)
        if start_index < 0 or end_index < 0 or end_index < start_index:
            raise RuntimeError(f"missing or malformed generated block {begin!r} in {ENVIRONMENTS_PYPROJECT}")
        content_start = start_index + len(begin)
        text = text[:content_start] + f"\n{body}\n" + text[end_index:]
    ENVIRONMENTS_PYPROJECT.write_text(text, encoding="utf-8", newline="\n")
    print(f"  environment packaging -> {ENVIRONMENTS_PYPROJECT}")


def emit_json_schema() -> None:
    """Render the canonical JSON Schema files from the zod definitions that define them."""
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    subprocess.run(
        [npm, "run", "generate", "--workspace", "@game-sandbox/schema"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    for name in SCHEMA_FILES:
        print(f"  json schema -> {SCHEMA_DIR / name}")


def generate_fixtures() -> None:
    """Write the golden recordings and parameter cases the TypeScript suite reads back.

    The valid fixtures go through the real FolderRecordingStore (validating on write), so
    they provably come from current Python code. The deliberately-broken bumped-version
    fixture is written raw, since the store would (correctly) refuse to produce it.
    """
    # Import the harness only after the packaged schema exists.
    from game_sandbox_harness.environment import ResolvedLayout, ResolvedSeat
    from game_sandbox_harness.recording.local import FolderRecordingStore
    from game_sandbox_harness.state import build_agent_step, build_header, build_step_state

    if FIXTURES_DIR.exists():
        shutil.rmtree(FIXTURES_DIR)
    store = FolderRecordingStore(FIXTURES_DIR)

    def step(tick: int):
        return build_step_state(
            tick=tick,
            agents={
                "player_0": build_agent_step(
                    reward=float(tick),
                    score=float(tick),
                    observation={"y": tick},
                    action=tick % 2,
                    decision_ms=0.5,
                )
            },
            started_at=1_700_000_000_000 + tick,
            duration_ms=1.0,
            overlay={"pipes": [{"x": 100 - tick, "gap_y": 50}]},
        )

    def header_with_seats(*, seats: dict[str, list[str]], seat_plan: str, **kwargs):
        resolved_seats = tuple(ResolvedSeat(seat_id, tuple(players)) for seat_id, players in seats.items())
        return build_header(
            **kwargs,
            layout=ResolvedLayout(
                seat_plan,
                resolved_seats,
                sum(len(seat.players) for seat in resolved_seats),
                len(resolved_seats),
            ),
        )

    # 1. A two-step recording that must parse into generated types with no casts. It carries a
    #    per-player attribution block so the generated `players` field is exercised by the read-back test.
    with store.create(
        "two-step",
        header_with_seats(
            environment="flappy",
            parameters={"players": 1, "pipe_gap": 100},
            seed=7,
            players={"player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}},
            seats={"seat_0": ["player_0"]},
            seat_plan="solo",
        ),
    ) as writer:
        writer.write_step(step(0))
        writer.write_step(step(1))

    # 2. Spades recordings for both declared plans. The partnership fixture also carries a
    #    `messages` array (one targeted, one broadcast) and a `chat_ms` timing field, so the
    #    TypeScript read-back test pins those generated fields without a cast.
    spades_players = {
        "player_0": {"kind": "agent", "submission_id": "submission-signaler", "label": "Signaler"},
        "player_1": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"},
        "player_2": {"kind": "agent", "submission_id": "submission-signaler", "label": "Signaler"},
        "player_3": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"},
    }
    spades_plans = (
        (
            "chatty",
            "partnership",
            {"seat_0": ["player_0", "player_2"], "seat_1": ["player_1", "player_3"]},
        ),
        (
            "chatty-solo",
            "solo",
            {
                "seat_0": ["player_0"],
                "seat_1": ["player_1"],
                "seat_2": ["player_2"],
                "seat_3": ["player_3"],
            },
        ),
    )
    for fixture_name, seat_plan, seats in spades_plans:
        with store.create(
            fixture_name,
            header_with_seats(
                environment="spades",
                parameters={"seat_plan": seat_plan},
                seed=7,
                players=spades_players,
                seats=seats,
                seat_plan=seat_plan,
            ),
        ) as writer:
            writer.write_step(
                build_step_state(
                    tick=0,
                    agents={
                        "player_0": build_agent_step(
                            reward=0.0,
                            score=0.0,
                            action=57,
                            decision_ms=0.5,
                            chat_ms=0.25,
                        )
                    },
                    started_at=1_700_000_000_000,
                    duration_ms=1.0,
                    messages=[
                        {"from": "player_0", "to": "player_2", "text": "strong:hearts"},
                        {"from": "player_0", "to": None, "text": "good luck"},
                    ],
                    # This compact schema fixture puts sent messages and the current designated
                    # human's chat policy on one synthetic state. A live episode publishes that
                    # current policy on every eligible state.
                    chat_options=(
                        {
                            "sender": "player_0",
                            "target_recipients": ["player_2", "player_1", "player_3"],
                            "default_recipient": "player_2",
                        }
                        if seat_plan == "partnership"
                        else None
                    ),
                )
            )

    # 3. A recording whose header declares an unknown sidecar that must load cleanly.
    with store.create(
        "unknown-sidecar",
        header_with_seats(
            environment="flappy",
            parameters={"players": 1, "pipe_gap": 100},
            seed=7,
            sidecars=[{"name": "future-telemetry", "path": "telemetry.jsonl"}],
            players={"player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}},
            seats={"seat_0": ["player_0"]},
            seat_plan="solo",
        ),
    ) as writer:
        writer.write_step(step(0))

    # 4. A bumped-version recording that must be rejected by a version-1 reader. Written
    #    raw because the store validates on write and would refuse schema_version 2.
    bumped_dir = FIXTURES_DIR / "bumped-version"
    bumped_dir.mkdir(parents=True, exist_ok=True)
    bumped_header = {
        "schema_version": 2,
        "environment": "flappy",
        "parameters": {"players": 1, "pipe_gap": 100},
        "players": {"player_0": {"kind": "agent", "builtin_name": "naive", "label": "Naive agent"}},
        "seats": {"seat_0": ["player_0"]},
        "seat_plan": "solo",
    }
    bumped_state = {
        "schema_version": 2,
        "tick": 0,
        "agents": {"player_0": {"reward": 0.0, "score": 0.0}},
        "timing": {"started_at": 1_700_000_000_000, "duration_ms": 1.0},
    }
    (bumped_dir / "recording.jsonl").write_text(
        json.dumps(bumped_header, separators=(",", ":"), sort_keys=True)
        + "\n"
        + json.dumps(bumped_state, separators=(",", ":"), sort_keys=True)
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    parameter_values = {
        "declarations": [
            {
                "name": "players",
                "title": "Players",
                "description": "Number of PettingZoo players in each game.",
                "type": "int",
                "default": 4,
                "min": 1,
                "max": 4,
            },
            {
                "name": "pipe_gap",
                "title": "Pipe gap",
                "description": "Vertical space between pipes.",
                "type": "int",
                "default": 100,
                "min": 1,
                "max": 9007199254740991,
            },
            {
                "name": "gravity",
                "title": "Gravity",
                "description": "Downward acceleration.",
                "type": "float",
                "default": 1.5,
                "min": 0.0,
                "max": 10.0,
            },
            {
                "name": "label",
                "title": "Label",
                "description": "A free-form label.",
                "type": "string",
                "default": "default",
            },
            {
                "name": "enabled",
                "title": "Enabled",
                "description": "Whether the option is active.",
                "type": "bool",
                "default": False,
            },
            {
                "name": "mode",
                "title": "Mode",
                "description": "One gameplay mode.",
                "type": "choice",
                "default": "normal",
                "choices": [
                    {"value": "easy", "label": "Easy"},
                    {"value": "normal", "label": "Normal"},
                    {"value": "hard", "label": "Hard"},
                ],
            },
            {
                "name": "powerups",
                "title": "Power-ups",
                "description": "Enabled power-ups.",
                "type": "multi_choice",
                "default": ["shield"],
                "choices": [
                    {"value": "shield", "label": "Shield"},
                    {"value": "boost", "label": "Boost"},
                    {"value": "magnet", "label": "Magnet"},
                ],
            },
        ],
        "validation_cases": [
            {"name": "players", "value": 1, "valid": True, "normalized": 1},
            {"name": "players", "value": 4, "valid": True, "normalized": 4},
            {"name": "players", "value": 5, "valid": False},
            {"name": "pipe_gap", "value": 9007199254740991, "valid": True, "normalized": 9007199254740991},
            {"name": "pipe_gap", "value": 9007199254740992, "valid": False},
            {"name": "pipe_gap", "value": 1.5, "valid": False},
            {"name": "pipe_gap", "value": True, "valid": False},
            {"name": "gravity", "value": 0, "valid": True, "normalized": 0.0},
            {"name": "gravity", "value": 2.25, "valid": True, "normalized": 2.25},
            {"name": "gravity", "value": 10.1, "valid": False},
            {"name": "gravity", "value": True, "valid": False},
            {"name": "label", "value": "", "valid": True, "normalized": ""},
            {"name": "label", "value": 1, "valid": False},
            {"name": "enabled", "value": True, "valid": True, "normalized": True},
            {"name": "enabled", "value": False, "valid": True, "normalized": False},
            {"name": "enabled", "value": 1, "valid": False},
            {"name": "mode", "value": "hard", "valid": True, "normalized": "hard"},
            {"name": "mode", "value": "missing", "valid": False},
            {
                "name": "powerups",
                "value": ["magnet", "shield"],
                "valid": True,
                "normalized": ["shield", "magnet"],
            },
            {"name": "powerups", "value": [], "valid": True, "normalized": []},
            {"name": "powerups", "value": ["shield", "shield"], "valid": False},
            {"name": "powerups", "value": ["missing"], "valid": False},
        ],
        # Layers both implementations accept, so both can assert the same resolved values.
        "resolution_cases": [
            {
                "layers": [
                    {"players": 2, "pipe_gap": 120, "powerups": ["magnet", "shield"]},
                    {"pipe_gap": 140, "enabled": True},
                ],
                "values": {
                    "players": 2,
                    "pipe_gap": 140,
                    "gravity": 1.5,
                    "label": "default",
                    "enabled": True,
                    "mode": "normal",
                    "powerups": ["shield", "magnet"],
                },
            },
            {
                "layers": [],
                "values": {
                    "players": 4,
                    "pipe_gap": 100,
                    "gravity": 1.5,
                    "label": "default",
                    "enabled": False,
                    "mode": "normal",
                    "powerups": ["shield"],
                },
            },
        ],
        # One rejected entry per case, because the two resolvers report rejection differently and only
        # the set of rejected entries is genuinely shared. TypeScript collects issues and keeps the
        # default, which the admin API needs so it can name the bad override; Python raises on the
        # first bad value, which is what the harness wants when a launch configuration is wrong. A
        # multi-error layer could not describe both, so each case names exactly one bad entry and each
        # side asserts rejection in its own terms.
        "rejection_cases": [
            {"layer": {"pipe_gap": 0}, "name": "pipe_gap"},
            {"layer": {"mode": "missing"}, "name": "mode"},
            {"layer": {"powerups": ["missing"]}, "name": "powerups"},
            {"layer": {"unknown": "value"}, "name": "unknown"},
        ],
    }
    (FIXTURES_DIR / "parameter-values.json").write_text(
        json.dumps(parameter_values, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    def declared_seat(players: list[int], restricted_builtin: str | None = None) -> dict[str, object]:
        seat: dict[str, object] = {"players": players}
        if restricted_builtin is not None:
            seat["restricted_builtin"] = restricted_builtin
        return seat

    def resolved_seat(
        seat_id: str, players: list[str], restricted_builtin: str | None = None
    ) -> dict[str, object]:
        return {
            "seat_id": seat_id,
            "players": players,
            "restricted_builtin": restricted_builtin,
        }

    def seat_plans(plans: list[dict[str, object]]) -> dict[str, object]:
        return {"kind": "seat_plans", "plans": plans}

    def plan(key: str, title: str, seats: list[dict[str, object]]) -> dict[str, object]:
        return {"key": key, "title": title, "seats": seats}

    def singleton_plan(seats: list[dict[str, object]]) -> dict[str, object]:
        return seat_plans([plan("x", "X", seats)])

    layout_values = {
        "valid": [
            {
                "name": "player bounds solo",
                "meta": {
                    "layout": {"kind": "player_bounds", "min": 1, "max": 4},
                    "human_players": ["player_0"],
                },
                "parameters": {"players": 3},
                "layout": {
                    "plan_key": "solo",
                    "seats": [
                        resolved_seat("seat_0", ["player_0"]),
                        resolved_seat("seat_1", ["player_1"]),
                        resolved_seat("seat_2", ["player_2"]),
                    ],
                    "player_count": 3,
                    "seat_count": 3,
                },
            },
            {
                "name": "restricted uneven seat plan",
                "meta": {
                    "layout": seat_plans(
                        [
                            plan(
                                "duo",
                                "Duo",
                                [
                                    declared_seat([0], "naive"),
                                    declared_seat([1, 2, 3]),
                                ],
                            ),
                            plan(
                                "solo",
                                "Solo",
                                [
                                    declared_seat([0]),
                                    declared_seat([1]),
                                    declared_seat([2]),
                                    declared_seat([3]),
                                ],
                            ),
                        ]
                    ),
                    "human_players": ["player_0"],
                },
                "parameters": {"seat_plan": "duo"},
                "layout": {
                    "plan_key": "duo",
                    "seats": [
                        resolved_seat("seat_0", ["player_0"], "naive"),
                        resolved_seat("seat_1", ["player_1", "player_2", "player_3"]),
                    ],
                    "player_count": 4,
                    "seat_count": 2,
                },
            },
        ],
        "invalid": [
            {
                "name": "duplicate plan key",
                "layout": seat_plans(
                    [
                        plan("x", "X", [declared_seat([0])]),
                        plan("x", "Again", [declared_seat([0])]),
                    ]
                ),
            },
            {"name": "empty plans", "layout": seat_plans([])},
            {"name": "plan with no seats", "layout": singleton_plan([])},
            {"name": "empty seat", "layout": singleton_plan([declared_seat([])])},
            {"name": "duplicate index", "layout": singleton_plan([declared_seat([0, 0])])},
            {"name": "negative index", "layout": singleton_plan([declared_seat([-1])])},
            {
                "name": "invalid plan key",
                "layout": seat_plans([plan("Not Snake", "X", [declared_seat([0])])]),
            },
            {
                "name": "empty plan title",
                "layout": seat_plans([plan("x", "", [declared_seat([0])])]),
            },
            {"name": "gap", "layout": singleton_plan([declared_seat([0, 2])])},
            {"name": "nonzero start", "layout": singleton_plan([declared_seat([1])])},
            {
                "name": "undeclared restricted builtin",
                "layout": singleton_plan([declared_seat([0], "cautious")]),
            },
            {
                "name": "two restricted seats",
                "layout": singleton_plan([declared_seat([0], "naive"), declared_seat([1], "naive")]),
            },
            {
                "name": "only restricted seat",
                "layout": singleton_plan([declared_seat([0], "naive")]),
            },
            {"name": "unknown kind", "layout": {"kind": "unknown"}},
            {"name": "missing kind", "layout": {"min": 1, "max": 2}},
            {
                "name": "foreign player bounds field",
                "layout": {"kind": "player_bounds", "min": 1, "max": 2, "plans": []},
            },
            {
                "name": "restriction on player bounds layout",
                "layout": {"kind": "player_bounds", "min": 1, "max": 2, "restricted_builtin": "naive"},
            },
            {
                "name": "foreign seat plans field",
                "layout": {**singleton_plan([declared_seat([0])]), "min": 1, "max": 1},
            },
        ],
    }
    (FIXTURES_DIR / "layout-values.json").write_text(
        json.dumps(layout_values, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"  fixtures -> {FIXTURES_DIR}")


def generate_environments_json() -> None:
    """Write the backend's environment metadata artifact from discovered source packages.

    The backend never runs Python, so it reads this committed JSON file instead of importing
    the registry. Each entry is its ``EnvironmentMeta.to_json()`` (which already carries
    ``env_id``); the array is sorted by id and the keys are sorted so the bytes are stable
    across machines, like every other generated artifact. The generated-code-fresh CI job
    diffs this path, so it cannot drift from source discovery.
    """
    entries = discover_environments()
    metas = [entries[env_id].entry.meta.to_json() for env_id in sorted(entries)]

    BACKEND_GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    BACKEND_ENVIRONMENTS_JSON.write_text(
        json.dumps(metas, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"  environments metadata -> {BACKEND_ENVIRONMENTS_JSON}")


def main() -> int:
    print("Regenerating derived artifacts:")
    emit_json_schema()
    copy_packaged_schema()
    sync_environments_pyproject()
    generate_fixtures()
    generate_environments_json()
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
