"""Run a CI job exactly as CI runs it: ``uv run python scripts/ci.py <job>``.

Every GitHub Actions job is a single call to this script after dependency setup, so the
workflow YAML carries triggers and caching but no logic, and a developer can reproduce
any job with the same command (under WSL for Linux parity). The jobs map one-to-one to the
five workflows under ``.github/workflows/``:

ci.yml (runs on every push and pull request):
- ``python``: ruff check, ruff format --check, pyright, pytest.
- ``typescript``: biome check, tsc --noEmit, vitest run — workspace-wide, so the backend joins
  it; the backend's biome check enforces the import-isolation rule.
- ``backend-integration``: the Docker-gated backend Vitest project (real containers: the
  WebSocket client, sandbox guarantees, idle/orphan reaping). Needs a Docker daemon, so it is a
  job of its own and is *not* part of ``all`` (which must run without Docker).
- ``generated-code-fresh``: regenerate, then fail if anything generated changed; also runs
  ``bump_template_version.py --check`` so the version touchpoints cannot silently drift.
- ``examples``: compose every example, install it into a fresh venv, run its pytest; also
  fail if any environment template layer ships no example.

e2e.yml (manually dispatched from the Actions tab — too Docker-heavy and slow for every push):
- ``frontend-e2e``: the Docker-gated browser suite — Playwright drives Chromium against the real
  backend serving the production frontend and the scripted loopback bridge serving the local bundle.
  A production session launches a container, so the job needs Docker and is *not* part of ``all``.

compose-smoke.yml (manually dispatched from the Actions tab):
- ``compose-smoke``: the containerized-deployment rehearsal from
  docs/contributors/setup/docker.md. It builds the app image, boots ``compose.yaml`` with a
  throwaway ``.env``, and proves the published API port, the same-path ``DATA_DIR`` bind, and
  startup reaping through the mounted daemon socket. Needs a Linux daemon, so it is *not* part
  of ``all``.

docs.yml:
- ``docs``: the strict ``mkdocs build`` that gates docs pull requests.

template-publish.yml:
- ``publish-dry-run``: compose and assemble the publish snapshots without pushing, the
  ``verify`` job being the same ``examples`` job above.

``all`` runs every non-Docker job above in order (ci.yml minus its Docker job, plus the docs
build and the publish dry run), which is what a contributor runs before pushing a branch or
cutting a ``template-v<N>`` tag; the Docker-gated ``backend-integration``, ``frontend-e2e``, and
``compose-smoke`` jobs are run separately. ``check`` and ``test`` are narrower convenience aggregates wired to
``npm run check`` / ``npm run test``.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from _paths import (
    BACKEND_GENERATED_DIR,
    BUILD_DIR,
    ENVIRONMENTS_PYPROJECT,
    FIXTURES_DIR,
    HARNESS_SCHEMA_DATA,
    REPO_ROOT,
    SCHEMA_DIR,
    SCHEMA_FILES,
)

_NPM = "npm.cmd" if sys.platform == "win32" else "npm"


def _run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    """Run a command, echoing it, and raise SystemExit on failure.

    ``env`` defaults to ``None``, which inherits this process's environment unchanged; pass an
    explicit map (typically ``os.environ`` plus overrides) to run the child with extra variables,
    e.g. the demo's loopback ``AUTH_ALLOW_INSECURE_DEFAULTS``.
    """
    printable = " ".join(cmd)
    where = f" (in {cwd})" if cwd else ""
    print(f"$ {printable}{where}", flush=True)
    result = subprocess.run(cmd, cwd=cwd or REPO_ROOT, env=env)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def job_python() -> None:
    _run(["uv", "run", "ruff", "check", "."])
    _run(["uv", "run", "ruff", "format", "--check", "."])
    _run(["uv", "run", "pyright"])
    _run(["uv", "run", "pytest"])


def job_typescript() -> None:
    # Workspace-wide: check:ts and test:ts run `check`/`test` in every workspace that defines them
    # (schema/ts and backend), so the backend joins this job with no YAML change. The backend's
    # `biome check .` enforces the Stage 3 import-isolation rule on every PR.
    _run([_NPM, "run", "check:ts"])
    _run([_NPM, "run", "test:ts"])


def job_backend_integration() -> None:
    # The Docker-gated backend suite: a separate Vitest project that builds the session base image
    # and launches real containers (the WebSocket client, the sandbox guarantees, idle/orphan
    # reaping). Runs on ubuntu-latest in CI where the daemon is available, and locally against
    # Docker Desktop. An `act` run may skip it; it is also runnable directly with this command.
    _run([_NPM, "run", "--workspace", "@game-sandbox/backend", "test:integration"])


def job_frontend_e2e() -> None:
    # Playwright drives Chromium against both the real backend and the Python local-play bridge.
    # Production sessions launch real containers, so this job needs the same Docker gate as
    # backend-integration. The local journey also needs the repository's Python environment.
    # Build the image, install Chromium, then run the gated suite. The frontend package's e2e script
    # rebuilds both browser entries itself, so direct and CI-driven Playwright runs cannot use stale bundles.
    _run([_NPM, "run", "build:image"])
    install_chromium = [
        _NPM,
        "exec",
        "--workspace",
        "@game-sandbox/frontend",
        "--",
        "playwright",
        "install",
        "--with-deps",
        "chromium",
    ]
    _run(install_chromium)
    _run([_NPM, "run", "e2e", "--workspace", "@game-sandbox/frontend"])


def _wait_for_http(url: str, timeout_s: float) -> None:
    """Poll ``url`` until it answers 200, failing the job when ``timeout_s`` runs out."""
    import time
    import urllib.request

    deadline = time.monotonic() + timeout_s
    last_error = "no response yet"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status == 200:
                    return
                last_error = f"HTTP {response.status}"
        except OSError as error:
            last_error = str(error)
        time.sleep(2)
    raise SystemExit(f"{url} did not answer 200 within {int(timeout_s)}s (last error: {last_error})")


def job_compose_smoke() -> None:
    # Rehearses the containerized deployment from docs/contributors/setup/docker.md: build the app
    # image, boot compose.yaml with a throwaway .env, and prove the three things the topology
    # depends on. The published API port answers, the same-path DATA_DIR bind is writable from
    # inside the container, and a restart reaps a planted leftover container through the mounted
    # daemon socket. Needs a Linux daemon (the same-path convention does not hold under Docker
    # Desktop's VM), so it is not part of ``all``; run it from the Actions tab or under WSL.
    import secrets
    import shutil
    import tempfile

    if sys.platform == "win32":
        raise SystemExit(
            "compose-smoke needs a Linux Docker daemon; run it under WSL or from the Actions tab."
        )
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        raise SystemExit(".env already exists; compose-smoke writes a throwaway one. Move yours aside first.")

    data_dir = Path(tempfile.mkdtemp(prefix="game-sandbox-compose-smoke-"))
    env_path.write_text(
        "\n".join(
            [
                "PUBLIC_ORIGIN=http://127.0.0.1:8080",
                "PORT=8080",
                f"AUTH_SECRET={secrets.token_hex(32)}",
                "ADMIN_EMAIL=compose-smoke@example.com",
                f"ADMIN_PASSWORD={secrets.token_hex(16)}",
                "ADMIN_NAME=Compose Smoke",
                "AUTH_ALLOW_INSECURE_DEFAULTS=false",
                f"DATA_DIR={data_dir}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    url = "http://127.0.0.1:8080/api/environments"
    planted_id: str | None = None
    try:
        _run(["docker", "compose", "up", "-d", "--build"])
        _wait_for_http(url, 300)
        if not (data_dir / "sandbox.db").exists():
            raise SystemExit(
                f"the app answered but wrote no sandbox.db under {data_dir}; "
                "the same-path DATA_DIR bind is broken"
            )
        # Plant the leftover a previous containerized incarnation would leave behind: a container
        # carrying the session label and owner pid 1. The restarted app (pid 1 again) must reap it.
        planted = subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--entrypoint",
                "sleep",
                "--label",
                "game-sandbox.session=compose-smoke",
                "--label",
                "game-sandbox.owner-pid=1",
                "game-sandbox/app",
                "300",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if planted.returncode != 0:
            raise SystemExit(f"could not plant the leftover container: {planted.stderr.strip()}")
        planted_id = planted.stdout.strip()
        _run(["docker", "compose", "restart", "app"])
        _wait_for_http(url, 120)
        gone = subprocess.run(["docker", "inspect", planted_id], cwd=REPO_ROOT, capture_output=True)
        if gone.returncode == 0:
            raise SystemExit("the restarted app did not reap the planted leftover container")
        print("compose smoke passed: API up, same-path DATA_DIR bind works, restart reaped the leftover")
    except (SystemExit, Exception):
        subprocess.run(["docker", "compose", "logs", "app"], cwd=REPO_ROOT)
        raise
    finally:
        if planted_id:
            subprocess.run(["docker", "rm", "-f", planted_id], cwd=REPO_ROOT, capture_output=True)
        subprocess.run(["docker", "compose", "down", "--remove-orphans"], cwd=REPO_ROOT)
        env_path.unlink(missing_ok=True)
        shutil.rmtree(data_dir, ignore_errors=True)


def job_generated_code_fresh() -> None:
    _run(["uv", "run", "python", "scripts/generate.py"])
    # Fail if schema, registry, or packaging regeneration changed tracked output.
    targets = [
        # The canonical schema files are emitted from the zod definitions, so drift between the
        # zod source and the committed JSON is exactly what this job exists to catch.
        *(str((SCHEMA_DIR / name).relative_to(REPO_ROOT)) for name in SCHEMA_FILES),
        str(HARNESS_SCHEMA_DATA.relative_to(REPO_ROOT)),
        str(FIXTURES_DIR.relative_to(REPO_ROOT)),
        str(BACKEND_GENERATED_DIR.relative_to(REPO_ROOT)),
        str(ENVIRONMENTS_PYPROJECT.relative_to(REPO_ROOT)),
    ]
    _run(["git", "diff", "--exit-code", "--", *targets])
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", *targets],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    # The diff above already proved every tracked generated file matches what regeneration produced.
    # What it cannot see is a file regeneration created but nobody tracked, or one that disappeared.
    # Those are the two states to fail on. A staged modification is neither: it is this very change
    # set, correctly regenerated and waiting to be committed, so flagging it would make the check
    # impossible to pass from a working tree.
    stranded = [line for line in status.stdout.splitlines() if line.startswith("??") or "D" in line[:2]]
    if stranded:
        raise SystemExit("generated output has untracked or removed paths:\n" + "\n".join(stranded))
    # Not generated, but the same idea: the version touchpoints (base manifest, DEPS_VERSION, the
    # frozen deps-v<N> snapshot, e2e fixtures) are derived state that must agree. --check fails the
    # PR if a manual edit desynced them, before a release can inherit the drift.
    _run(["uv", "run", "python", "scripts/bump_template_version.py", "--check"])


def job_examples() -> None:
    from compose import compose_example, list_envs, list_examples

    pairs = list_examples()
    if not pairs:
        print("no examples to compose")
        return

    # Every environment layer must ship at least one example: a worked strategy that reads the
    # observation through the helper module, and the proof its env layer composes and runs end to
    # end in a fresh virtualenv (the bare template ships a naive starting agent, not a worked one).
    envs_with_examples = {env for env, _ in pairs}
    missing = [env for env in list_envs() if env not in envs_with_examples]
    if missing:
        raise SystemExit(
            f"environment template layer(s) {missing} ship no example; every env layer must "
            f"have at least one colocated example under environments/<env>/examples/<name>/ "
            f"to prove it composes."
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
    _run([_NPM, "run", "check:ts"])


def job_test() -> None:
    """Local aggregate: run all tests (the Docker-gated backend integration job is separate)."""
    _run(["uv", "run", "pytest"])
    _run([_NPM, "run", "test:ts"])


_JOBS = {
    "python": job_python,
    "typescript": job_typescript,
    "backend-integration": job_backend_integration,
    "compose-smoke": job_compose_smoke,
    "frontend-e2e": job_frontend_e2e,
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
