"""The load-check subprocess reports one unspoofable result without playing a game."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest


def _write_repo(root: Path, module: str, *, class_name: str, source: str) -> None:
    (root / f"{module}.py").write_text(source, encoding="utf-8")
    manifest = {"entry_point": module, "class_name": class_name, "template_version": 1}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def _run(root: Path) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
    proc = subprocess.run(
        [sys.executable, "-m", "game_sandbox_harness.validate", str(root)],
        capture_output=True,
        text=True,
        timeout=10,
    )
    events = [json.loads(line) for line in proc.stdout.splitlines()]
    assert len(events) == 1, (proc.stdout, proc.stderr)
    assert events[0]["kind"] == "validate-result"
    return proc, events[0]


_GOOD_AGENT = """
class Agent:
    def reset(self, seed, observation):
        raise AssertionError("validation called reset")
    def act(self, observation):
        raise AssertionError("validation called act")
    def learn(self, observation, action, reward, terminated):
        raise AssertionError("validation called learn")
"""


def test_good_agent_loads_and_reports_success(tmp_path: Path):
    _write_repo(tmp_path, "good_validate_agent", class_name="Agent", source=_GOOD_AGENT)
    proc, envelope = _run(tmp_path)
    assert proc.returncode == 0
    assert envelope == {"kind": "validate-result", "ok": True, "hooks": {"learn": True, "chat": False}}


@pytest.mark.parametrize(
    ("class_name", "source", "code", "detail"),
    [
        ("Missing", _GOOD_AGENT, "class_not_found", "Missing"),
        ("Agent", "raise RuntimeError('boom at import')", "import_error", "boom at import"),
        (
            "Agent",
            _GOOD_AGENT + "\n    def __init__(self):\n        raise ValueError('no good')\n",
            "constructor_error",
            "no good",
        ),
        ("Agent", _GOOD_AGENT.replace("def reset(", "def other_reset("), "missing_hook", "reset"),
        ("Agent", _GOOD_AGENT.replace("def act(", "def other_act("), "missing_hook", "act"),
        ("Agent", _GOOD_AGENT + "\n    reset = None\n", "missing_hook", "reset"),
        ("Agent", _GOOD_AGENT + "\n    act = 1\n", "missing_hook", "act"),
    ],
)
def test_missing_class_reports_class_not_found(tmp_path: Path, class_name, source, code, detail):
    _write_repo(tmp_path, "invalid_validate_agent", class_name=class_name, source=source)
    proc, envelope = _run(tmp_path)
    assert proc.returncode == 1
    assert envelope["ok"] is False
    assert envelope["code"] == code
    assert detail in envelope["detail"]


def test_entry_point_outside_repo_reports_import_error(tmp_path: Path):
    (tmp_path / "manifest.json").write_text(
        json.dumps({"entry_point": "json", "class_name": "JSONDecoder", "template_version": 1}),
        encoding="utf-8",
    )
    proc, envelope = _run(tmp_path)
    assert proc.returncode == 1
    assert envelope["ok"] is False
    assert envelope["code"] == "import_error"
    assert "json" in envelope["detail"]
    assert "outside the repo root" in envelope["detail"]


def test_participant_stdout_cannot_spoof_the_result(tmp_path: Path):
    fake_success = json.dumps({"kind": "validate-result", "ok": True})
    _write_repo(
        tmp_path,
        "spoof_validate_agent",
        class_name="Agent",
        source=(
            f"print({fake_success!r}, flush=True)\n"
            "class Agent:\n"
            "    def reset(self, seed, observation):\n"
            "        pass\n"
        ),
    )
    proc, envelope = _run(tmp_path)
    assert proc.returncode == 1
    assert envelope["ok"] is False
    assert envelope["code"] == "missing_hook"
    assert fake_success in proc.stderr
