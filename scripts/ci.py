"""Run a CI job exactly as CI runs it: ``uv run python scripts/ci.py <job>``.

Every GitHub Actions job is a single call to this script after dependency setup, so the
workflow YAML carries triggers and caching but no logic, and a developer can reproduce
any job with the same command (under WSL for Linux parity). The jobs map one-to-one to the
three workflows under ``.github/workflows/``:

ci.yml:
- ``python``: ruff check, ruff format --check, pyright, pytest.
- ``typescript``: biome check, tsc --noEmit, vitest run.
- ``generated-code-fresh``: regenerate, then fail if anything generated changed.
- ``examples``: compose every example, install it into a fresh venv, run its pytest; also
  fail if any environment template layer ships no example.

docs.yml:
- ``docs``: the strict ``mkdocs build`` that gates docs pull requests.

template-publish.yml:
- ``publish-dry-run``: compose and assemble the publish snapshots without pushing, the
  ``verify`` job being the same ``examples`` job above.

``all`` runs every job above in order: the full local equivalent of all three workflows,
which is what a contributor runs before pushing a branch or cutting a ``template-v<N>``
tag. ``check`` and ``test`` are narrower convenience aggregates wired to ``npm run check``
/ ``npm run test``.
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
    TEMPLATE_ENVS,
    TS_GENERATED_DIR,
    template_sandbox_env,
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
    # Fail if regeneration changed anything tracked under the generated locations: the schema
    # mirrors, plus every per-environment template sandbox_env/.
    targets = [
        str(TS_GENERATED_DIR.relative_to(REPO_ROOT)),
        str(HARNESS_SCHEMA_DATA.relative_to(REPO_ROOT)),
        str(FIXTURES_DIR.relative_to(REPO_ROOT)),
        *(str(template_sandbox_env(env).relative_to(REPO_ROOT)) for env in TEMPLATE_ENVS),
    ]
    _run(["git", "diff", "--exit-code", "--", *targets])


def job_examples() -> None:
    from compose import compose_example, list_envs, list_examples

    pairs = list_examples()
    if not pairs:
        print("no examples to compose")
        return

    # Every environment layer must ship at least one example: the bare template's pytest is
    # red by design (agent.py raises NotImplementedError), so a composed example is the only
    # green proof that an env layer works end to end.
    envs_with_examples = {env for env, _ in pairs}
    missing = [env for env in list_envs() if env not in envs_with_examples]
    if missing:
        raise SystemExit(
            f"environment template layer(s) {missing} ship no example; every env layer must "
            f"have at least one example under examples/<env>/<name>/ to prove it composes."
        )

    for env, name in pairs:
        print(f"=== example: {env}/{name} ===", flush=True)
        out_dir = compose_example(env, name)
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


def job_docs() -> None:
    # docs.yml builds the site with --strict so broken links or bad refs fail the build.
    _run(["uv", "run", "--group", "docs", "mkdocs", "build", "--strict"])


def job_publish_dry_run() -> None:
    # template-publish.yml's publish job runs this script on a real tag; --dry-run composes
    # and assembles the snapshots under build/publish/ without any network push. The tag is
    # the Stage 1 placeholder; resolve_version only needs the integer N from it.
    _run(
        [
            "uv",
            "run",
            "python",
            "scripts/publish_template.py",
            "--tag",
            "template-v0",
            "--dry-run",
        ]
    )


def job_all() -> None:
    """The full end-to-end suite: every ci.yml job, the docs strict build, and the publish
    dry-run, in order. Run this before pushing a branch or cutting a template tag."""
    job_python()
    job_typescript()
    job_generated_code_fresh()
    job_examples()
    job_docs()
    job_publish_dry_run()


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
    "docs": job_docs,
    "publish-dry-run": job_publish_dry_run,
    "all": job_all,
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
