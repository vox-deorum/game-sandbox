"""The ``validate`` load-check command (Stage 5.4): exercise it directly, without the backend.

Each test writes a tiny repo into ``tmp_path`` with a unique entry-point module name (so the
shared ``sys.path``/import mechanism never collides on a cached ``agent`` module across tests),
runs :func:`game_sandbox_harness.validate.main` against it, and asserts both the process exit code
and the single structured ``validate-result`` envelope printed on stdout. The worked example loads;
each broken variant reports its specific closed-set code. The command never constructs the
environment — it only imports the module and instantiates the class.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from game_sandbox_harness.validate import RESULT_KIND


def _write_repo(root: Path, module: str, *, class_name: str, source: str) -> None:
    (root / f"{module}.py").write_text(source, encoding="utf-8")
    manifest = {"entry_point": module, "class_name": class_name, "template_version": 1}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def _cleanup(root: Path, module: str) -> None:
    sys.path[:] = [p for p in sys.path if p != str(root.resolve())]
    sys.modules.pop(module, None)


def _run(root: Path) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
    """Run the module and return the process plus the parsed result envelope from stdout."""
    proc = subprocess.run(
        [sys.executable, "-m", "game_sandbox_harness.validate", str(root)],
        capture_output=True,
        text=True,
        timeout=10,
    )
    out = proc.stdout
    envelope = next(
        json.loads(line)
        for line in out.splitlines()
        if line.strip().startswith("{") and json.loads(line).get("kind") == RESULT_KIND
    )
    return proc, envelope


_GOOD_AGENT = """
class Agent:
    def reset(self, seed):
        self.seed = seed
    def act(self, observation):
        return 1
    def learn(self, observation, action, reward, terminated):
        pass
"""


def test_good_agent_loads_and_reports_success(tmp_path: Path):
    module = "good_validate_agent"
    _write_repo(tmp_path, module, class_name="Agent", source=_GOOD_AGENT)
    try:
        proc, envelope = _run(tmp_path)
        assert proc.returncode == 0
        assert envelope["ok"] is True
        # Optional-hook presence rides along for the owner's debug view.
        assert envelope["hooks"] == {"learn": True, "chat": False}
    finally:
        _cleanup(tmp_path, module)


def test_missing_class_reports_class_not_found(tmp_path: Path):
    module = "nomatch_validate_agent"
    _write_repo(tmp_path, module, class_name="Missing", source=_GOOD_AGENT)
    try:
        proc, envelope = _run(tmp_path)
        assert proc.returncode == 1
        assert envelope["ok"] is False
        assert envelope["code"] == "class_not_found"
        assert "Missing" in envelope["detail"]
    finally:
        _cleanup(tmp_path, module)


def test_import_error_reports_import_error(tmp_path: Path):
    module = "raises_on_import_agent"
    _write_repo(
        tmp_path,
        module,
        class_name="Agent",
        source="raise RuntimeError('boom at import')\n",
    )
    try:
        proc, envelope = _run(tmp_path)
        assert proc.returncode == 1
        assert envelope["code"] == "import_error"
    finally:
        _cleanup(tmp_path, module)


def test_constructor_error_reports_constructor_error(tmp_path: Path):
    module = "bad_ctor_agent"
    _write_repo(
        tmp_path,
        module,
        class_name="Agent",
        source=(
            "class Agent:\n"
            "    def __init__(self):\n"
            "        raise ValueError('no good')\n"
            "    def reset(self, seed):\n"
            "        pass\n"
            "    def act(self, observation):\n"
            "        return 0\n"
        ),
    )
    try:
        proc, envelope = _run(tmp_path)
        assert proc.returncode == 1
        assert envelope["code"] == "constructor_error"
        assert "no good" in envelope["detail"]
    finally:
        _cleanup(tmp_path, module)


def test_missing_act_hook_reports_missing_hook(tmp_path: Path):
    module = "noact_validate_agent"
    _write_repo(
        tmp_path,
        module,
        class_name="Agent",
        source="class Agent:\n    def reset(self, seed):\n        pass\n",
    )
    try:
        proc, envelope = _run(tmp_path)
        assert proc.returncode == 1
        assert envelope["code"] == "missing_hook"
    finally:
        _cleanup(tmp_path, module)


def test_participant_stdout_cannot_spoof_the_result(tmp_path: Path):
    module = "spoof_validate_agent"
    fake_success = json.dumps({"kind": RESULT_KIND, "ok": True})
    _write_repo(
        tmp_path,
        module,
        class_name="Agent",
        source=(
            f"print({fake_success!r}, flush=True)\nclass Agent:\n    def reset(self, seed):\n        pass\n"
        ),
    )
    try:
        proc, envelope = _run(tmp_path)
        assert proc.returncode == 1
        assert proc.stdout.count(RESULT_KIND) == 1
        assert envelope["ok"] is False
        assert envelope["code"] == "missing_hook"
        assert fake_success in proc.stderr
    finally:
        _cleanup(tmp_path, module)
