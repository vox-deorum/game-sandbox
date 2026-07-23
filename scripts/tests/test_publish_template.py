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


def test_publish_builds_once_and_replaces_bundle_in_every_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    bundle = tmp_path / "frontend" / "dist-local"
    assets = bundle / "assets"
    assets.mkdir(parents=True)
    (bundle / "local.html").write_text("<main>stale</main>\n", encoding="utf-8")
    (assets / "stale.js").write_text("console.log('stale')\n", encoding="utf-8")
    outputs = {
        "flappy_bird": _composed_output(tmp_path / "composed", "template-flappy"),
        "hearts": _composed_output(tmp_path / "composed", "template-hearts"),
        "flappy_bird/hello": _composed_output(tmp_path / "composed", "example-hello"),
        "hearts/oracle": _composed_output(tmp_path / "composed", "example-oracle"),
    }
    calls: list[tuple[list[str], Path]] = []

    def fake_run(command: list[str], *, cwd: Path, check: bool) -> None:
        calls.append((command, cwd))
        assert not bundle.exists()
        fresh_assets = bundle / "assets"
        fresh_assets.mkdir(parents=True)
        (bundle / "local.html").write_text("<main>fresh</main>\n", encoding="utf-8")
        (fresh_assets / "fresh.js").write_text("console.log('fresh')\n", encoding="utf-8")

    monkeypatch.setattr(publisher, "FRONTEND_LOCAL_DIST_DIR", bundle)
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
    monkeypatch.setattr(publisher, "_validate_example_refs", lambda _: None)
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

    assert calls == [
        (
            [
                "npm.cmd" if sys.platform == "win32" else "npm",
                "run",
                "build:local",
                "--workspace",
                "@game-sandbox/frontend",
            ],
            publisher.REPO_ROOT,
        )
    ]
    for output in outputs.values():
        web = output / "sandbox" / "web"
        assert (web / "local.html").read_text(encoding="utf-8") == "<main>fresh</main>\n"
        assert (web / "assets" / "fresh.js").is_file()
        assert not (web / "stale.txt").exists()
        assert not (web / "assets" / "stale.js").exists()

    snapshots = [
        tmp_path / "build" / "publish" / "main",
        tmp_path / "build" / "publish" / "templates" / "flappy_bird",
        tmp_path / "build" / "publish" / "templates" / "hearts",
        tmp_path / "build" / "publish" / "examples" / "flappy_bird" / "hello",
        tmp_path / "build" / "publish" / "examples" / "hearts" / "oracle",
    ]
    for snapshot in snapshots:
        web = snapshot / "sandbox" / "web"
        assert (web / "local.html").read_text(encoding="utf-8") == "<main>fresh</main>\n"
        assert (web / "assets" / "fresh.js").is_file()
        assert not (web / "stale.txt").exists()
        assert not (web / "assets" / "stale.js").exists()

    assert not (bundle / "assets" / "stale.js").exists()
    assert "would exclude source example hearts/hidden from publication" in capsys.readouterr().out


def test_local_frontend_build_requires_local_html(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    bundle = tmp_path / "frontend" / "dist-local"
    bundle.mkdir(parents=True)
    (bundle / "local.html").write_text("<main>stale</main>\n", encoding="utf-8")
    monkeypatch.setattr(publisher, "FRONTEND_LOCAL_DIST_DIR", bundle)
    monkeypatch.setattr(publisher.subprocess, "run", lambda *args, **kwargs: None)

    with pytest.raises(publisher.PublishError, match=r"did not produce .*local\.html"):
        publisher._build_local_frontend()

    assert not bundle.exists()


def test_invalid_example_ref_fails_before_any_composition(monkeypatch: pytest.MonkeyPatch):
    calls: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> SimpleNamespace:
        calls.append(command)
        return SimpleNamespace(returncode=1)

    monkeypatch.setattr(publisher.subprocess, "run", fake_run)
    monkeypatch.setattr(publisher, "list_envs", lambda: ["flappy_bird"])
    monkeypatch.setattr(publisher, "list_published_examples", lambda: [("flappy_bird", ".hidden")])
    monkeypatch.setattr(
        publisher,
        "_build_local_frontend",
        lambda: pytest.fail("ref validation must happen before frontend build or composition"),
    )

    with pytest.raises(publisher.PublishError, match="invalid example publication ref"):
        publisher.publish(version=7, sha="abc123", target_repo="owner/template", token=None, dry_run=True)

    assert calls == [["git", "check-ref-format", "refs/heads/examples/flappy_bird/.hidden"]]


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
    monkeypatch.setattr(publisher, "_validate_example_refs", lambda _: None)
    monkeypatch.setattr(publisher, "_build_local_frontend", lambda: tmp_path / "bundle")
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
