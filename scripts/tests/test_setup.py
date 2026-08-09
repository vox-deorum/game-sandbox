"""Tests for the dependency-free setup helpers."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import setup  # noqa: E402

DOCKER_ORIGIN_CASES = (
    ("https://sandbox.example.com", True),
    ("https://SANDBOX.EXAMPLE.COM", True),
    ("https://xn--sandbx-f1a.example.com", True),
    ("http://sandbox.example.com", False),
    ("HTTPS://sandbox.example.com", False),
    ("https://sandbox.example.com/", False),
    ("https://sandbox.example.com/path", False),
    ("https://sandbox.example.com?", False),
    ("https://sandbox.example.com#", False),
    ("https://sandbox.example.com:443", False),
    ("https://user@sandbox.example.com", False),
    ("https://localhost", False),
    ("https://127.0.0.1", False),
    ("https://01.2.3.4", False),
    ("https://1.2.3.999", False),
    ("https://sandbox.example.com.", False),
    ("https://sandbox..example.com", False),
    ("https://-sandbox.example.com", False),
    ("https://sandböx.example.com", False),
)


def deployment_answers(**overrides: str) -> dict[str, str]:
    answers = {
        "PUBLIC_ORIGIN": "https://sandbox.example.com",
        "PORT": "8080",
        "LOCAL_HTTPS_PORT": "8443",
        "ADMIN_EMAIL": "operator@example.com",
        "ADMIN_PASSWORD": "not-the-development-password",
        "ADMIN_NAME": "Site Admin",
        "DATA_DIR": "/srv/game-sandbox/data",
        "GITHUB_OAUTH_CLIENT_ID": "",
        "GITHUB_OAUTH_CLIENT_SECRET": "",
        "GITHUB_TOKEN": "",
        "LLM_UPSTREAM_URL": "",
        "LLM_UPSTREAM_KEY": "",
        "LLM_MODEL_LARGE": "",
        "LLM_MODEL_MEDIUM": "",
        "LLM_MODEL_SMALL": "",
    }
    answers.update(overrides)
    return answers


def test_every_managed_field_has_a_label_a_reader_recognizes():
    assert all(field.label and field.label != key for key, field in setup.ENV_FIELDS.items())


def test_collect_answers_uses_friendly_labels_and_mode_defaults(monkeypatch, capsys):
    labels: list[str] = []
    supplied = {
        "Public site URL": "https://sandbox.example.com",
        "Administrator email address": "operator@example.com",
    }

    def fake_prompt(label, default="", validator=None, *, allow_blank=False):
        labels.append(label)
        if allow_blank:
            return default
        return default or supplied[label]

    monkeypatch.setattr(setup, "prompt", fake_prompt)
    monkeypatch.setattr(setup, "prompt_yes_no", lambda *args: False)
    monkeypatch.setattr(setup.secrets, "token_urlsafe", lambda _length: "generated-password")

    host = setup.collect_answers("host", {})
    docker = setup.collect_answers("docker", {})

    assert host["DATA_DIR"] == "backend/data"
    assert docker["DATA_DIR"] == "/srv/game-sandbox/data"
    assert "LOCAL_HTTPS_PORT" not in host
    assert docker["LOCAL_HTTPS_PORT"] == "8443"
    assert host["ADMIN_PASSWORD"] == "generated-password"
    assert "Public site URL" in labels
    assert "GitHub repository access token" in labels
    assert not set(labels) & set(setup.MANAGED_KEYS)
    output = capsys.readouterr().out
    assert "Administrator account" in output
    assert "Private GitHub repositories" in output
    assert "AI provider" in output


def test_enabled_optional_groups_use_friendly_labels(monkeypatch):
    labels: list[str] = []
    supplied = {
        "Public site URL": "https://sandbox.example.com",
        "Administrator email address": "operator@example.com",
        "GitHub OAuth client ID": "client-id",
        "GitHub OAuth client secret": "client-secret",
        "AI provider URL": "https://models.example.com/v1",
    }

    def fake_prompt(label, default="", validator=None, *, allow_blank=False):
        labels.append(label)
        if allow_blank:
            return "large-model" if label == "Large model name" else default
        return default or supplied[label]

    monkeypatch.setattr(setup, "prompt", fake_prompt)
    monkeypatch.setattr(setup, "prompt_yes_no", lambda *args: True)
    monkeypatch.setattr(setup.secrets, "token_urlsafe", lambda _length: "generated-password")

    answers = setup.collect_answers("host", {})

    assert answers["GITHUB_OAUTH_CLIENT_ID"] == "client-id"
    assert answers["LLM_MODEL_LARGE"] == "large-model"
    assert "GitHub OAuth client secret" in labels
    assert "AI provider API key" in labels
    assert "Small model name" in labels
    assert not set(labels) & set(setup.MANAGED_KEYS)


def test_deployment_summary_uses_friendly_names(capsys):
    setup._print_deploy_summary("host", deployment_answers())

    output = capsys.readouterr().out
    assert "Setup complete" in output
    assert "Administrator sign-in" in output
    assert "Open it at:" in output
    assert "Data will be stored in:" in output
    assert "DATA_DIR" not in output


def test_mode_menu_explains_each_choice(monkeypatch, capsys):
    monkeypatch.setattr("builtins.input", lambda _label: "2")

    assert setup.choose_mode() == "host"

    output = capsys.readouterr().out
    assert "Local development" in output
    assert "Run on this computer" in output
    assert "Docker on a Linux server" in output
    assert "Host deployment" not in output


def test_successful_step_hides_command_output(monkeypatch, capsys):
    result = setup.subprocess.CompletedProcess([], 0, stdout="raw command output", stderr="")
    monkeypatch.setattr(setup.subprocess, "run", lambda *args, **kwargs: result)

    setup._run_step("Installing dependencies", ["fake-command"])

    output = capsys.readouterr().out
    assert output == "Installing dependencies... done.\n"
    assert "raw command output" not in output


def test_docker_build_failure_does_not_add_unrelated_app_logs(tmp_path, monkeypatch):
    def fail_build(*args, **kwargs):
        raise SystemExit(1)

    monkeypatch.setattr(setup, "_configure_deployment", lambda _mode: deployment_answers())
    monkeypatch.setattr(setup, "_prepare_tls_dir", lambda: tmp_path)
    monkeypatch.setattr(setup, "_run_step", fail_build)
    monkeypatch.setattr(
        setup.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail("app logs should not run after a build failure"),
    )

    with pytest.raises(SystemExit):
        setup.run_docker()


def test_docker_readiness_failure_labels_diagnostics_once(tmp_path, monkeypatch, capsys):
    def fail_health_check(*args, **kwargs):
        raise SystemExit("raw timeout detail")

    monkeypatch.setattr(setup, "_configure_deployment", lambda _mode: deployment_answers())
    monkeypatch.setattr(setup, "_prepare_tls_dir", lambda: tmp_path)
    monkeypatch.setattr(setup, "_run_step", lambda *args, **kwargs: None)
    monkeypatch.setattr(setup, "_wait_for_http", fail_health_check)
    logs = setup.subprocess.CompletedProcess([], 0, stdout="recent app log", stderr="")
    monkeypatch.setattr(setup.subprocess, "run", lambda *args, **kwargs: logs)

    with pytest.raises(SystemExit) as error:
        setup.run_docker()

    assert error.value.code == 1
    output = capsys.readouterr().out
    assert "did not become ready in time" in output
    assert output.count("Technical details:") == 1
    assert "raw timeout detail" in output
    assert "recent app log" in output


def test_docker_build_pulls_current_bases_and_waits_with_generated_ca(tmp_path, monkeypatch):
    commands: list[list[str]] = []
    waits: list[tuple[str, Path]] = []
    monkeypatch.setattr(setup, "_configure_deployment", lambda _mode: deployment_answers())
    monkeypatch.setattr(setup, "_prepare_tls_dir", lambda: tmp_path)
    monkeypatch.setattr(setup, "_run_step", lambda _label, command: commands.append(command))
    monkeypatch.setattr(
        setup,
        "_wait_for_http",
        lambda url, _timeout, *, ca_file: waits.append((url, ca_file)),
    )
    monkeypatch.setattr(setup, "_print_deploy_summary", lambda *_args: None)

    assert setup.run_docker() == 0

    assert commands == [
        ["docker", "compose", "build", "--pull"],
        ["docker", "compose", "up", "-d"],
    ]
    assert waits == [("https://127.0.0.1:8443/api/environments", tmp_path / "current" / "origin.crt")]


def test_unreadable_existing_settings_get_friendly_error(tmp_path, monkeypatch, capsys):
    (tmp_path / ".env").mkdir()
    monkeypatch.setattr(setup, "REPO_ROOT", tmp_path)

    with pytest.raises(SystemExit) as error:
        setup._configure_deployment("host")

    assert error.value.code == 1
    output = capsys.readouterr().out
    assert "We could not read your existing settings." in output
    assert "Technical details:" in output


def test_render_quotes_only_what_needs_it_and_keeps_preserved_lines_verbatim():
    rendered = setup.render_env_file(
        {"PUBLIC_ORIGIN": "https://sandbox.example.com", "ADMIN_NAME": "Site Admin"},
        preserved=['CUSTOM_VALUE="kept as written"'],
    )

    assert "PUBLIC_ORIGIN=https://sandbox.example.com" in rendered
    assert 'ADMIN_NAME="Site Admin"' in rendered
    assert 'CUSTOM_VALUE="kept as written"' in rendered
    assert setup.parse_env_file(rendered) == {
        "PUBLIC_ORIGIN": "https://sandbox.example.com",
        "ADMIN_NAME": "Site Admin",
        "CUSTOM_VALUE": "kept as written",
    }


def test_plan_env_writes_required_docker_values_and_reuses_valid_secret():
    secret = "a" * 32
    planned = setup.plan_env("docker", deployment_answers(), {"AUTH_SECRET": secret})

    assert planned.keys() >= setup._required_keys("docker")
    assert planned["AUTH_ALLOW_INSECURE_DEFAULTS"] == "false"
    assert planned["AUTH_SECRET"] == secret
    assert "GITHUB_TOKEN" not in planned


def test_plan_env_regenerates_development_secret():
    planned = setup.plan_env("docker", deployment_answers(), {"AUTH_SECRET": setup.DEV_AUTH_SECRET})

    assert planned["AUTH_SECRET"] != setup.DEV_AUTH_SECRET
    assert len(planned["AUTH_SECRET"]) >= 32


@pytest.mark.parametrize("secret", ["short", setup.DEV_AUTH_SECRET])
def test_auth_secret_validator_rejects_short_and_development_values(secret: str):
    assert setup.validate_auth_secret(secret) is not None


def test_admin_validators_reject_development_values():
    assert setup.validate_admin_email(setup.DEV_ADMIN_EMAIL) is not None
    assert setup.validate_admin_email(setup.DEV_ADMIN_EMAIL.upper()) is not None
    assert setup.validate_admin_password(setup.DEV_ADMIN_PASSWORD) is not None


def test_url_validators_distinguish_origins_from_base_urls():
    assert setup.validate_origin("https://sandbox.example.com") is None
    assert setup.validate_origin("https://sandbox.example.com/api") is not None
    assert setup.validate_http_url("https://models.example.com/v1") is None
    assert setup.validate_http_url("https://user:secret@models.example.com/v1") is not None
    assert setup.validate_http_url("http://[invalid") is not None


@pytest.mark.parametrize(("origin", "accepted"), DOCKER_ORIGIN_CASES)
def test_docker_origin_contract(origin: str, accepted: bool):
    assert (setup.validate_docker_origin(origin) is None) is accepted


@pytest.mark.skipif(shutil.which("sh") is None, reason="the deployment proxy runs under Linux sh")
@pytest.mark.parametrize(("origin", "accepted"), DOCKER_ORIGIN_CASES)
def test_proxy_origin_contract_matches_setup(origin: str, accepted: bool):
    result = subprocess.run(
        ["sh", "deploy/nginx/proxy-entrypoint.sh", "--validate-public-origin"],
        cwd=setup.REPO_ROOT,
        env=os.environ | {"PUBLIC_ORIGIN": origin},
        capture_output=True,
        text=True,
        check=False,
    )

    assert (result.returncode == 0) is accepted, result.stderr


def test_host_plan_does_not_write_the_docker_local_https_port():
    planned = setup.plan_env("host", deployment_answers(), {"AUTH_SECRET": "a" * 32})

    assert "LOCAL_HTTPS_PORT" not in planned


@pytest.mark.parametrize("port", ["443", "0443"])
def test_docker_plan_rejects_public_port_for_local_https(port: str):
    with pytest.raises(ValueError, match="Port 443 is reserved"):
        setup.plan_env(
            "docker",
            deployment_answers(LOCAL_HTTPS_PORT=port),
            {"AUTH_SECRET": "a" * 32},
        )


def test_prepare_tls_dir_creates_a_private_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(setup, "REPO_ROOT", tmp_path)

    tls_dir = setup._prepare_tls_dir()

    assert tls_dir == tmp_path / ".tls"
    assert tls_dir.is_dir()


@pytest.mark.parametrize("port", ["0", "65536", "not-a-port", "+8080", "8_080"])
def test_port_validator_rejects_invalid_ports(port: str):
    assert setup.validate_port(port) is not None


def test_oauth_requires_both_values():
    assert setup.validate_oauth("client", "") is not None
    assert setup.validate_oauth("", "secret") is not None
    assert setup.validate_oauth("client", "secret") is None


def test_data_dir_validation_depends_on_mode():
    assert setup.validate_data_dir("backend/data", "docker") is not None
    assert setup.validate_data_dir("backend/data", "host") is None


@pytest.mark.parametrize("platform", ["win32", "darwin"])
def test_docker_mode_error_rejects_desktop_platforms(platform: str):
    assert setup.docker_mode_error(platform) is not None


def test_docker_mode_error_allows_linux():
    assert setup.docker_mode_error("linux") is None


@pytest.mark.parametrize("value", ['has "quote"', "has\\backslash"])
def test_validate_env_value_rejects_quotes_and_backslashes(value: str):
    assert setup.validate_env_value(value) is not None


def test_validate_env_value_accepts_values_with_spaces():
    assert setup.validate_env_value("has a space") is None


def test_write_env_file_backs_up_existing_file(tmp_path: Path):
    env_path = tmp_path / ".env"
    previous_text = '# handwritten\nCUSTOM_VALUE="kept as written"\nPUBLIC_ORIGIN=https://old.example.com\n'
    env_path.write_text(previous_text, encoding="utf-8")

    setup.write_env_file(env_path, {"PUBLIC_ORIGIN": "https://new.example.com"}, previous_text)

    assert (tmp_path / ".env.bak").read_text(encoding="utf-8") == previous_text
    written_text = env_path.read_text(encoding="utf-8")
    assert 'CUSTOM_VALUE="kept as written"' in written_text.splitlines()
    values = setup.parse_env_file(written_text)
    assert values["PUBLIC_ORIGIN"] == "https://new.example.com"
    assert values["CUSTOM_VALUE"] == "kept as written"
