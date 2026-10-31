# LLM Key and Prompt Testing

Status: complete.

## Goal

Let a student confirm that the development key in their `.env` works, and let an operator confirm that the deployment's upstream credential and model mappings work, before any agent depends on them. Both can try a single prompt and see the reply, token use, and latency.

## Mechanism

- **Student key check**: `GET /api/llm/v1/key` takes the development key as a bearer and applies the same checks as a completion (`DevelopmentKeyService.verify`). It returns the season discovery view and spends nothing.
- **Student prompt test**: the page sends the pasted key to the existing `/api/llm/v1/chat/completions`, so a test prompt is an ordinary metered and recorded development call. The key lives only in page state.
- **Operator upstream view**: `GET /api/admin/llm` reports the upstream URL, whether a key is set, each alias with its upstream model and price, and the output-token defaults.
- **Operator test call**: `POST /api/admin/llm/chat` sends one request through the shared `UpstreamCaller`, with no metering or telemetry. An upstream refusal returns `502` with `upstream_status`, so a provider 401 never looks like an expired sign-in.
- **Shared prompt tester**: `LlmPlayground.vue` has model, max tokens, system, and user fields. It sends the limit as `max_completion_tokens`, which reasoning models require, and leaves it out when blank so the deployment default applies. A reply's cost uses the price of the model it ran on. The caller supplies where the request goes and how a refusal reads. Students see plain explanations, and operators see the raw status, code, and message.
- **Budget refresh**: after each student run, the page checks the key the run used again. The result is applied only when no other key was checked in the meantime, so a slow refresh never brings back a replaced key.

## Pages

The student page at `/my/llm` is reached from **Test key** on a My Agents season row.

```text
Test LLM key
API key [sk-sandbox-dev-••••••]  [Check]
● Key works
Season 5 · three_branches
████████░░  900 units left of 1,000 units

Model [small ▾]  Max tokens [Default]
System [                      ]
User   [Good morning!         ]
                          [Run]
Morning! The rye is warm.      [copy]
31 in · 9 out · 80 units · 640 ms
```

The prompt tester appears only after the key check passes, and the budget refreshes after each run.

The operator page at `/admin/llm` sits after **Logs** in the admin sidebar.

```text
LLM
https://provider/v1   Key set              [Test all]
Alias  Upstream model   Status
large  gpt-5.1          ● OK · 820 ms        [Test]
small  gpt-5-mini       ● 401 invalid_api_key [Test]
                        Incorrect API key
(prompt tester)
```

Each alias check sends "Reply with exactly: OK" with at most 16 output tokens, lowered to the deployment's hard limit when that is smaller. Without an upstream, the page names the variables to set.

## Tests

- Backend: `backend/test/admin/llm.test.ts` and the key-check case in `backend/test/llm/development-api.test.ts`.
- Frontend: `frontend/test/llm-testing.test.ts`, plus client cases in `api.test.ts` and link checks in `app-sidebar.test.ts` and `my-agents.test.ts`.
- Browser: the `seasons` group tests every alias against the stub upstream, and the `hearts` LLM journey checks a real key and runs one prompt from `/my/llm`.
