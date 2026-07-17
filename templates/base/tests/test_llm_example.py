"""The LLM smoke command uses the configured alias and never exposes the key."""

from __future__ import annotations

from types import SimpleNamespace

from sandbox import llm_example


def test_smoke_call_uses_configured_alias_and_reports_usage(monkeypatch, capsys):
    calls: list[dict] = []
    completions = SimpleNamespace(
        create=lambda **kwargs: (
            calls.append(kwargs)
            or SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="Game Sandbox LLM ready"))],
                usage=SimpleNamespace(total_tokens=9),
            )
        )
    )
    clients: list[tuple[str, str, int]] = []

    def openai(*, base_url: str, api_key: str, max_retries: int):
        clients.append((base_url, api_key, max_retries))
        return SimpleNamespace(chat=SimpleNamespace(completions=completions))

    monkeypatch.setattr(llm_example, "load_dotenv", lambda: None)
    monkeypatch.setattr(llm_example, "OpenAI", openai)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://course.example/api/llm/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "secret-development-key")
    monkeypatch.setenv("OPENAI_MODEL", "small")

    assert llm_example.main() == 0
    output = capsys.readouterr().out
    assert clients == [("https://course.example/api/llm/v1", "secret-development-key", 0)]
    assert len(calls) == 1
    assert calls[0]["model"] == "small"
    assert calls[0]["stream"] is False
    assert "model alias: small" in output
    assert "tokens used: 9" in output
    assert "secret-development-key" not in output


def test_smoke_call_requires_all_three_settings(monkeypatch, capsys):
    monkeypatch.setattr(llm_example, "load_dotenv", lambda: None)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_MODEL", raising=False)

    assert llm_example.main() == 1
    assert "OPENAI_MODEL" in capsys.readouterr().err
