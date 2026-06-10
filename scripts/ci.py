"""Run a CI job exactly as CI runs it: ``uv run python scripts/ci.py <job>``.

Every GitHub Actions job is a single call to this script after dependency setup, so the
workflow YAML carries triggers and caching but no logic, and a developer can reproduce
any job with the same command (under WSL for Linux parity). The jobs:

- ``python``: ruff check, ruff format --check, pyright, pytest.
- ``typescript``: biome check, tsc --noEmit, vitest run.
- ``generated-code-fresh``: regenerate, then fail if anything generated changed.
- ``examples``: compose every example, install it into a fresh venv, run its pytest.

``check`` and ``test`` are local convenience aggregates wired to ``npm run check`` / ``npm
run test``.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from _paths import (
    BUILD_DIR,
    FIXTURES_DIR,
    HARNESS_SCHEMA_DATA,
    REPO_ROOT,
    TS_GENERATED_DIR,
)

_NPM = "npm.cmd" if sys.platform == "win32" else "npm"


def _run(cmd: list[str], cwd: Path | None = None) -> None:
    """Run a command, echoing it, and raise SystemExit on failure."""
    printable = " ".join(cmd)
    where = f" (in {cwd})" if cwd else ""
    print(f"$ {printable}{where}", flush=True)
    result = subprocess.run(cmd, cwd=cwd or REPO_ROOT)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def job_python() -> None:
    _run(["uv", "run", "ruff", "check", "."])
    _run(["uv", "run", "ruff", "format", "--check", "."])
    _run(["uv", "run", "pyright"])
    _run(["uv", "run", "pytest"])


def job_typescript() -> None:
    _run([_NPM, "run", "--workspace", "@game-sandbox/schema", "check"])
    _run([_NPM, "run", "--workspace", "@game-sandbox/schema", "test"])


def job_generated_code_fresh() -> None:
    _run(["uv", "run", "python", "scripts/generate.py"])
    # Fail if regeneration changed anything tracked under the three generated locations.
    targets = [
        str(TS_GENERATED_DIR.relative_to(REPO_ROOT)),
        str(HARNESS_SCHEMA_DATA.relative_to(REPO_ROOT)),
        str(FIXTURES_DIR.relative_to(REPO_ROOT)),
    ]
    _run(["git", "diff", "--exit-code", "--", *targets])


def job_examples() -> None:
    from compose_example import compose, list_examples

    names = list_examples()
    if not names:
        print("no examples to compose")
        return
    for name in names:
        print(f"=== example: {name} ===", flush=True)
        out_dir = compose(name)
        venv_dir = out_dir / ".venv"
        _run(["uv", "venv", str(venv_dir)])
        python = (
            venv_dir
            / ("Scripts" if sys.platform == "win32" else "bin")
            / ("python.exe" if sys.platform == "win32" else "python")
        )
        reqs = ["-r", str(out_dir / "requirements.txt")]
        if (out_dir / "requirements-dev.txt").exists():
            reqs += ["-r", str(out_dir / "requirements-dev.txt")]
        _run(["uv", "pip", "install", "--python", str(python), *reqs])
        _run([str(python), "-m", "pytest", "-q"], cwd=out_dir)


def job_check() -> None:
    """Local aggregate: lint and typecheck both languages."""
    _run(["uv", "run", "ruff", "check", "."])
    _run(["uv", "run", "ruff", "format", "--check", "."])
    _run(["uv", "run", "pyright"])
    _run([_NPM, "run", "--workspace", "@game-sandbox/schema", "check"])


def job_test() -> None:
    """Local aggregate: run all tests."""
    _run(["uv", "run", "pytest"])
    _run([_NPM, "run", "--workspace", "@game-sandbox/schema", "test"])


_JOBS = {
    "python": job_python,
    "typescript": job_typescript,
    "generated-code-fresh": job_generated_code_fresh,
    "examples": job_examples,
    "check": job_check,
    "test": job_test,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a CI job locally or in CI.")
    parser.add_argument("job", choices=sorted(_JOBS), help="which job to run")
    args = parser.parse_args(argv)
    BUILD_DIR.mkdir(exist_ok=True)
    _JOBS[args.job]()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
