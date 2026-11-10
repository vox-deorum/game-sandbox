"""Publication-time local browser bundle assembly."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import publish_template as publisher  # noqa: E402


def _composed_output(root: Path, name: str) -> Path:
    output = root / name
    web = output / "sandbox" / "web"
    web.mkdir(parents=True)
    (web / "stale.txt").write_text("stale\n", encoding="utf-8")
    return output


def test_publish_builds_one_bundle_per_environment_for_its_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    local_web = tmp_path / "build" / "local-web"
    outputs = {
        "flappy_bird": _composed_output(tmp_path / "composed", "template-flappy"),
        "hearts": _composed_output(tmp_path / "composed", "template-hearts"),
        "flappy_bird/hello": _composed_output(tmp_path / "composed", "example-hello"),
        "hearts/oracle": _composed_output(tmp_path / "composed", "example-oracle"),
    }
    calls: list[tuple[list[str], Path, str]] = []

    def fake_run(command: list[str], *, cwd: Path, check: bool, env: dict[str, str]) -> None:
        selected = env["GAME_SANDBOX_LOCAL_ENV"]
        calls.append((command, cwd, selected))
        bundle = Path(command[command.index("--outDir") + 1])
        assert bundle == local_web / selected
        assert not bundle.exists()
        fresh_assets = bundle / "assets"
        fresh_assets.mkdir(parents=True)
        (bundle / "local.html").write_text(f"<main>{selected}</main>\n", encoding="utf-8")
        (fresh_assets / f"{selected}.js").write_text(f"console.log('{selected}')\n", encoding="utf-8")

    monkeypatch.setattr(publisher, "LOCAL_WEB_BUILD_DIR", local_web)
    monkeypatch.setattr(publisher, "BUILD_DIR", tmp_path / "build")
    monkeypatch.setattr(publisher, "list_envs", lambda: ["flappy_bird", "hearts"])
    monkeypatch.setattr(
        publisher, "list_published_examples", lambda: [("flappy_bird", "hello"), ("hearts", "oracle")]
    )
    monkeypatch.setattr(
        publisher,
        "list_examples",
        lambda: [("flappy_bird", "hello"), ("hearts", "hidden"), ("hearts", "oracle")],
    )
    monkeypatch.setattr(publisher, "compose_template", lambda env: outputs[env])
    monkeypatch.setattr(publisher, "compose_example", lambda env, name: outputs[f"{env}/{name}"])
    monkeypatch.setattr(publisher.subprocess, "run", fake_run)

    publisher.publish(
        version=7,
        sha="abc123",
        target_repo="owner/template",
        token=None,
        dry_run=True,
    )

    npm_command = [
        "npm.cmd" if sys.platform == "win32" else "npm",
        "run",
        "build:local",
        "--workspace",
        "@game-sandbox/frontend",
        "--",
        "--outDir",
    ]
    assert calls == [
        ([*npm_command, str(local_web / "flappy_bird")], publisher.REPO_ROOT, "flappy_bird"),
        ([*npm_command, str(local_web / "hearts")], publisher.REPO_ROOT, "hearts"),
    ]

    cases = [
        ("flappy_bird", "flappy_bird", "hearts"),
        ("flappy_bird/hello", "flappy_bird", "hearts"),
        ("hearts", "hearts", "flappy_bird"),
        ("hearts/oracle", "hearts", "flappy_bird"),
    ]
    for name, selected, other in cases:
        web = outputs[name] / "sandbox" / "web"
        assert (web / "local.html").read_text(encoding="utf-8") == f"<main>{selected}</main>\n"
        assert (web / "assets" / f"{selected}.js").is_file()
        assert not (web / "assets" / f"{other}.js").exists()
        assert not (web / "stale.txt").exists()

    snapshots = [
        (tmp_path / "build" / "publish" / "main", "flappy_bird"),
        (tmp_path / "build" / "publish" / "templates" / "flappy_bird", "flappy_bird"),
        (tmp_path / "build" / "publish" / "templates" / "hearts", "hearts"),
        (tmp_path / "build" / "publish" / "examples" / "flappy_bird" / "hello", "flappy_bird"),
        (tmp_path / "build" / "publish" / "examples" / "hearts" / "oracle", "hearts"),
    ]
    for snapshot, selected in snapshots:
        web = snapshot / "sandbox" / "web"
        assert (web / "local.html").read_text(encoding="utf-8") == f"<main>{selected}</main>\n"
        assert (web / "assets" / f"{selected}.js").is_file()
        assert not (web / "stale.txt").exists()

    assert "would exclude source example hearts/hidden from publication" in capsys.readouterr().out


def test_local_frontend_build_requires_local_html(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    local_web = tmp_path / "build" / "local-web"
    bundle = local_web / "flappy_bird"
    bundle.mkdir(parents=True)
    (bundle / "local.html").write_text("<main>stale</main>\n", encoding="utf-8")
    monkeypatch.setattr(publisher, "LOCAL_WEB_BUILD_DIR", local_web)
    monkeypatch.setattr(publisher.subprocess, "run", lambda *args, **kwargs: None)

    with pytest.raises(publisher.PublishError, match=r"did not produce .*local\.html"):
        publisher._build_local_frontend("flappy_bird")

    assert not bundle.exists()


def test_prune_stale_example_refs_is_scoped_sorted_and_idempotent(monkeypatch: pytest.MonkeyPatch):
    commands: list[list[str]] = []
    monkeypatch.setattr(
        publisher.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            stdout=(
                "abc\trefs/heads/examples/hearts/stale\n"
                "def\trefs/heads/examples/flappy_bird/old\n"
                "ghi\trefs/heads/templates/hearts\n"
            )
        ),
    )
    monkeypatch.setattr(publisher, "_git", lambda args, cwd: commands.append(args))

    publisher._prune_stale_example_refs(
        "remote", {"refs/heads/examples/hearts/oracle", "refs/heads/examples/spades/counter"}
    )

    assert commands == [
        ["push", "remote", "--delete", "examples/flappy_bird/old"],
        ["push", "remote", "--delete", "examples/hearts/stale"],
    ]

    commands.clear()
    monkeypatch.setattr(
        publisher.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(stdout="abc\trefs/heads/examples/hearts/oracle\n"),
    )
    publisher._prune_stale_example_refs("remote", {"refs/heads/examples/hearts/oracle"})
    assert commands == []


def test_prune_empty_allowlist_and_propagates_the_first_delete_failure(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        publisher.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            stdout="abc\trefs/heads/examples/flappy_bird/old\ndef\trefs/heads/examples/hearts/stale\n"
        ),
    )
    commands: list[list[str]] = []

    def fail_first_delete(args: list[str], cwd: Path) -> None:
        commands.append(args)
        raise RuntimeError("network failed")

    monkeypatch.setattr(publisher, "_git", fail_first_delete)
    with pytest.raises(RuntimeError, match="network failed"):
        publisher._prune_stale_example_refs("remote", set())

    assert commands == [["push", "remote", "--delete", "examples/flappy_bird/old"]]


def test_failed_desired_example_push_does_not_start_cleanup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    template = tmp_path / "composed" / "template"
    example = tmp_path / "composed" / "example"
    template.mkdir(parents=True)
    example.mkdir(parents=True)
    branches: list[str] = []

    monkeypatch.setattr(publisher, "BUILD_DIR", tmp_path / "build")
    monkeypatch.setattr(publisher, "list_envs", lambda: ["flappy_bird"])
    monkeypatch.setattr(publisher, "list_published_examples", lambda: [("flappy_bird", "hello")])
    monkeypatch.setattr(publisher, "_build_local_frontend", lambda _env: tmp_path / "bundle")
    monkeypatch.setattr(publisher, "compose_template", lambda _: template)
    monkeypatch.setattr(publisher, "compose_example", lambda *_: example)
    monkeypatch.setattr(publisher, "_inject_local_frontend", lambda *_: None)
    monkeypatch.setattr(publisher, "_git", lambda *_args, **_kwargs: None)

    def fail_example_push(*, branch: str, **_: object) -> None:
        branches.append(branch)
        if branch.startswith("examples/"):
            raise RuntimeError("example push failed")

    monkeypatch.setattr(
        publisher,
        "_publish_orphan_snapshot",
        lambda _dest, **kwargs: fail_example_push(**kwargs),
    )
    monkeypatch.setattr(
        publisher,
        "_prune_stale_example_refs",
        lambda *_: pytest.fail("cleanup must wait for every desired push"),
    )

    with pytest.raises(RuntimeError, match="example push failed"):
        publisher.publish(
            version=7,
            sha="abc123",
            target_repo="owner/template",
            token="secret",
            dry_run=False,
        )

    assert branches == ["templates/flappy_bird", "examples/flappy_bird/hello"]
