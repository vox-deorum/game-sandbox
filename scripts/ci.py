"""Run a CI job exactly as CI runs it: ``uv run python scripts/ci.py <job>``.

Every GitHub Actions job is a single call to this script after dependency setup, so the
workflow YAML carries triggers and caching but no logic, and a developer can reproduce
any job with the same command (under WSL for Linux parity). The jobs map one-to-one to the
five workflows under ``.github/workflows/``:

ci.yml (runs on every push and pull request):
- ``python``: ruff check, ruff format --check, pyright, pytest.
- ``typescript``: biome check, tsc --noEmit, vitest run, workspace-wide, so the backend joins
  it; the backend's biome check enforces the import-isolation rule.
- ``backend-integration``: the Docker-gated backend Vitest project (real containers: the
  WebSocket client, sandbox guarantees, idle/orphan reaping). Needs a Docker daemon, so it is a
  job of its own and is *not* part of ``all`` (which must run without Docker).
- ``generated-code-fresh``: regenerate, then fail if anything generated changed; also runs
  ``bump_template_version.py --check`` so the version touchpoints cannot silently drift.
- ``examples``: compose every example, install it into a fresh venv, run its pytest; also
  fail if any environment template layer ships no example.

e2e.yml (manually dispatched from the Actions tab, too Docker-heavy and slow for every push):
- ``frontend-e2e``: the Docker-gated browser suite. Playwright drives Chromium against the real
  backend serving the production frontend and the scripted loopback bridge serving the local bundle.
  A production session launches a container, so the job needs Docker and is *not* part of ``all``.
  Bare, it runs every group with the long season arcs included, which is what CI checks and what
  ``scripts/demo.py`` turns into the demo's fixture database. For a local loop it narrows::

      ci.py frontend-e2e --group hearts     # just the Hearts specs, arcs skipped
      ci.py frontend-e2e --fast             # every group, arcs skipped
      ci.py frontend-e2e --group spades --include-slow --no-build

  Only the bare form claims the data dir the demo serves; everything else, including a hand-typed
  ``playwright test``, writes a throwaway one, so no narrowed run can thin that fixture.

compose-smoke.yml (manually dispatched from the Actions tab):
- ``compose-smoke``: the containerized-deployment rehearsal from
  docs/contributors/setup/docker.md. It builds current base images, boots ``compose.yaml`` with a
  throwaway ``.env``, and proves local TLS, private app ports, proxy survival across app recreation,
  the same-path ``DATA_DIR`` bind, and startup reaping through the mounted daemon socket. Needs a
  Linux daemon, so it is *not* part of ``all``.

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
import json
import os
import subprocess
import sys
from pathlib import Path

from _paths import (
    BACKEND_GENERATED_DIR,
    BUILD_DIR,
    E2E_DIR,
    E2E_MAIN_DATA_SUBDIR,
    E2E_PARTIAL_DATA_SUBDIR,
    ENVIRONMENTS_PYPROJECT,
    FIXTURES_DIR,
    FRONTEND_DIST_DIR,
    FRONTEND_LOCAL_DIST_DIR,
    HARNESS_SCHEMA_DATA,
    REPO_ROOT,
    SCHEMA_DIR,
    SCHEMA_FILES,
)

_NPM = "npm.cmd" if sys.platform == "win32" else "npm"


def e2e_groups() -> tuple[str, ...]:
    """The browser suite's groups: every directory under frontend/e2e/ that holds a spec.

    The filesystem is the only registry. ``frontend/playwright.config.ts`` derives its projects with
    the same rule, so a new group needs no edit in either file, and neither can list a group the other
    does not. ``support/`` and ``fixtures/`` fall out because they hold no specs.
    """
    return tuple(
        sorted(entry.name for entry in E2E_DIR.iterdir() if entry.is_dir() and any(entry.glob("*.spec.ts")))
    )


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


def _e2e_playwright_args(groups: list[str], *, include_slow: bool) -> list[str]:
    """Translate a group selection into Playwright's own flags.

    Kept as a pure function so a test can assert the translation without running the suite.
    """
    args: list[str] = []
    for group in groups:
        args += ["--project", group]
    if not include_slow:
        args += ["--grep-invert", "@slow"]
    return args


def job_frontend_e2e(
    groups: list[str] | None = None,
    *,
    include_slow: bool | None = None,
    build: bool = True,
) -> None:
    """Run the browser suite. With no arguments this is the complete run.

    Playwright drives Chromium against both the real backend and the Python local-play bridge.
    Production sessions launch real containers, so this job needs the same Docker gate as
    backend-integration. The local journey also needs the repository's Python environment.

    ``groups`` narrows the run to those Playwright projects (the directories under ``frontend/e2e/``).
    A narrowed run also drops the long ``@slow`` season arcs, since the point of picking a group is a
    fast loop; pass ``include_slow=True`` to keep them.

    Only a complete run claims the data dir ``npm run demo`` serves, by setting ``E2E_DATA_SUBDIR``.
    The Playwright config defaults to the throwaway dir, so a narrowed run here, and any hand-typed
    ``playwright test``, leaves that fixture alone without having to remember to.

    scripts/demo.py calls this with no arguments to build that fixture, and CI runs the bare
    ``ci.py frontend-e2e``, so "every group, arcs included, freshly built" must stay the default.
    """
    selected = sorted(set(groups or []))
    slow = include_slow if include_slow is not None else not selected
    complete = not selected and slow

    if not build:
        if os.environ.get("CI"):
            raise SystemExit("--no-build is a local convenience; CI always rebuilds the bundles.")
        for entry in (FRONTEND_DIST_DIR / "index.html", FRONTEND_LOCAL_DIST_DIR / "local.html"):
            if not entry.exists():
                raise SystemExit(f"--no-build needs {entry}; run the job once without it first.")
        print("--no-build: reusing the existing frontend bundles, which may be stale", flush=True)

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
    if build:
        _run([_NPM, "run", "e2e:build", "--workspace", "@game-sandbox/frontend"])
    # Claim the demo's data dir only for a complete run. The config defaults to the throwaway one, so a
    # narrowed run here, and any direct Playwright invocation, leaves the fixture alone by default.
    subdir = E2E_MAIN_DATA_SUBDIR if complete else E2E_PARTIAL_DATA_SUBDIR
    env = {**os.environ, "E2E_DATA_SUBDIR": subdir}
    _run(
        [_NPM, "exec", "--workspace", "@game-sandbox/frontend", "--", "playwright", "test"]
        + _e2e_playwright_args(selected, include_slow=slow),
        env=env,
    )


def _wait_for_http(url: str, timeout_s: float, *, ca_file: Path | None = None) -> None:
    """Poll ``url`` until it answers 200, failing the job when ``timeout_s`` runs out."""
    import ssl
    import time
    import urllib.request

    deadline = time.monotonic() + timeout_s
    last_error = "no response yet"
    while time.monotonic() < deadline:
        try:
            context = ssl.create_default_context(cafile=str(ca_file)) if ca_file else None
            with urllib.request.urlopen(url, timeout=5, context=context) as response:
                if response.status == 200:
                    return
                last_error = f"HTTP {response.status}"
        except (OSError, ValueError) as error:
            last_error = str(error)
        time.sleep(2)
    raise SystemExit(f"{url} did not answer 200 within {int(timeout_s)}s (last error: {last_error})")


def _require_https_rejection(*, port: int, host: str, ca_file: Path, reason: str) -> None:
    """Fail when a proxy boundary that should reject the request returns a successful response."""
    import http.client
    import ssl

    connection = http.client.HTTPSConnection(
        "127.0.0.1",
        port,
        timeout=5,
        context=ssl.create_default_context(cafile=str(ca_file)),
    )
    try:
        connection.request("GET", "/api/environments", headers={"Host": host})
        response = connection.getresponse()
        response.read()
        if 200 <= response.status < 400:
            raise SystemExit(f"{reason}: the proxy returned HTTP {response.status}")
    except (OSError, http.client.HTTPException):
        return
    finally:
        connection.close()


def _require_aop_client_certificate(compose: list[str]) -> None:
    """Prove the rendered public TLS listener rejects a handshake without an AOP certificate."""
    try:
        result = subprocess.run(
            [
                *compose,
                "exec",
                "-T",
                "proxy",
                "openssl",
                "s_client",
                "-connect",
                "127.0.0.1:443",
                "-servername",
                "compose-smoke.example.com",
                "-CAfile",
                "/tls/current/origin.crt",
                "-verify_return_error",
                "-tls1_3",
            ],
            cwd=REPO_ROOT,
            input="",
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise SystemExit("the public TLS AOP handshake probe hung for 30s instead of failing fast") from None
    diagnostic = f"{result.stdout}\n{result.stderr}".lower()
    expected_alerts = ("certificate required", "alert number 116")
    if not any(alert in diagnostic for alert in expected_alerts):
        raise SystemExit(
            "public TLS did not require the Cloudflare AOP client certificate\n"
            f"{result.stdout}{result.stderr}"
        )


def job_compose_smoke() -> None:
    # Rehearses the containerized deployment from docs/contributors/setup/docker.md: build the app
    # and proxy images, boot compose.yaml with throwaway state, and check the TLS and container
    # boundaries that the topology depends on. Needs a Linux daemon (the same-path convention does
    # not hold under Docker Desktop's VM), so it is not part of ``all``; run it from the Actions tab
    # or under WSL.
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
    tls_dir = REPO_ROOT / ".tls"
    if tls_dir.exists():
        raise SystemExit(".tls already exists; compose-smoke needs an empty certificate directory.")

    data_dir = Path(tempfile.mkdtemp(prefix="game-sandbox-compose-smoke-"))
    tls_dir.mkdir(mode=0o700)
    project_name = f"game-sandbox-smoke-{secrets.token_hex(4)}"
    internal_network = f"{project_name}-internal"
    outbound_network = f"{project_name}-outbound"
    compose = ["docker", "compose", "--project-name", project_name]
    env_path.write_text(
        "\n".join(
            [
                "PUBLIC_ORIGIN=https://compose-smoke.example.com",
                "PORT=8080",
                "LOCAL_HTTPS_PORT=18443",
                f"INTERNAL_NETWORK_NAME={internal_network}",
                f"OUTBOUND_NETWORK_NAME={outbound_network}",
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
    url = "https://127.0.0.1:18443/api/environments"
    certificate = tls_dir / "current" / "origin.crt"
    planted_id: str | None = None
    try:
        _run([*compose, "build", "--pull"])
        _run([*compose, "up", "-d"])
        _wait_for_http(url, 300, ca_file=certificate)
        _require_aop_client_certificate(compose)
        _require_https_rejection(
            port=443,
            host="compose-smoke.example.com",
            ca_file=certificate,
            reason="public HTTPS accepted a direct request without Cloudflare AOP",
        )
        _require_https_rejection(
            port=18443,
            host="unexpected.example.com",
            ca_file=certificate,
            reason="loopback HTTPS accepted an unexpected Host header",
        )
        if not (data_dir / "sandbox.db").exists():
            raise SystemExit(
                f"the app answered but wrote no sandbox.db under {data_dir}; "
                "the same-path DATA_DIR bind is broken"
            )
        app_id = subprocess.run(
            [*compose, "ps", "-q", "app"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        bindings_result = subprocess.run(
            ["docker", "inspect", "--format", "{{json .HostConfig.PortBindings}}", app_id],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        if json.loads(bindings_result.stdout) not in ({}, None):
            raise SystemExit("the app container unexpectedly publishes a host port")

        # Recreate the app without touching nginx. Docker DNS re-resolution must carry the next
        # request to the replacement container rather than the old address.
        _run([*compose, "up", "-d", "--force-recreate", "--no-deps", "app"])
        _wait_for_http(url, 120, ca_file=certificate)
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
        _run([*compose, "restart", "app"])
        _wait_for_http(url, 120, ca_file=certificate)
        gone = subprocess.run(["docker", "inspect", planted_id], cwd=REPO_ROOT, capture_output=True)
        if gone.returncode == 0:
            raise SystemExit("the restarted app did not reap the planted leftover container")
        print(
            "compose smoke passed: local TLS is up, app ports are private, proxy followed app "
            "recreation, same-path DATA_DIR works, and restart reaped the leftover"
        )
    except (SystemExit, Exception):
        subprocess.run([*compose, "logs", "proxy", "app"], cwd=REPO_ROOT)
        raise
    finally:
        if planted_id:
            subprocess.run(["docker", "rm", "-f", planted_id], cwd=REPO_ROOT, capture_output=True)
        subprocess.run([*compose, "down", "--remove-orphans"], cwd=REPO_ROOT)
        env_path.unlink(missing_ok=True)
        # The proxy writes root-owned pair directories into .tls, which a non-root runner cannot
        # delete directly, so empty the directory through the daemon first.
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{tls_dir}:/tls",
                "nginx:alpine",
                "sh",
                "-c",
                "rm -rf /tls/* /tls/.[!.]*",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
        )
        shutil.rmtree(tls_dir, ignore_errors=True)
        if tls_dir.exists():
            print(
                f"warning: could not fully remove {tls_dir}; remove it before the next run", file=sys.stderr
            )
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
    from _envs import discover_environments
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

    specs = {env_id: discovered.spec for env_id, discovered in discover_environments().items()}

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

        # Type-check the composed sandbox modules a spec has opted in, catching drift between the
        # TypedDict observation shapes and the code that reads them before it ships to students.
        # An environment's own paths are required of every one of its examples, so a rename that
        # would quietly drop coverage stops the job here. Example-owned files are checked in the
        # trees that carry them.
        spec = specs[env]
        absent = [path for path in spec.pyright_files if not (out_dir / path.rstrip("/")).exists()]
        if absent:
            raise SystemExit(f"composed example {env}/{name} is missing type-checked path(s) {absent}")
        shipped = [path for path in spec.pyright_example_files if (out_dir / path.rstrip("/")).exists()]
        pyright_files = (*spec.pyright_files, *shipped)
        if pyright_files:
            # Resolve imports against the example's own venv, since some examples depend on
            # packages the repo venv does not carry (the LLM examples, for instance).
            config = {
                "typeCheckingMode": "basic",
                "include": list(pyright_files),
                "venvPath": ".",
                "venv": ".venv",
            }
            (out_dir / "pyrightconfig.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
            _run(["uv", "run", "pyright", "-p", str(out_dir)])


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
    e2e = parser.add_argument_group(
        "frontend-e2e options",
        "Narrow the browser suite. With none of these the job runs everything, which is what CI and "
        "scripts/demo.py depend on.",
    )
    e2e.add_argument(
        "--group",
        action="append",
        choices=e2e_groups(),
        metavar="NAME",
        help="run only this group's specs (repeatable); also skips the @slow season arcs",
    )
    slow = e2e.add_mutually_exclusive_group()
    slow.add_argument("--fast", action="store_true", help="skip the long @slow season arcs")
    slow.add_argument("--include-slow", action="store_true", help="keep the @slow arcs in a narrowed run")
    e2e.add_argument(
        "--no-build",
        dest="build",
        action="store_false",
        help="reuse the existing frontend bundles instead of rebuilding them",
    )
    args = parser.parse_args(argv)

    narrowing = args.group or args.fast or args.include_slow or not args.build
    if narrowing and args.job != "frontend-e2e":
        parser.error("--group, --fast, --include-slow and --no-build apply only to frontend-e2e")

    BUILD_DIR.mkdir(exist_ok=True)
    if args.job == "frontend-e2e":
        include_slow = True if args.include_slow else (False if args.fast else None)
        job_frontend_e2e(args.group, include_slow=include_slow, build=args.build)
    else:
        _JOBS[args.job]()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
