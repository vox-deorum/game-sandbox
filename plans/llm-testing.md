# LLM Key and Prompt Testing

Status: complete.

## Goal

Let a student confirm that the development key in their `.env` works, and let an operator confirm that the deployment's upstream credential and model mappings work, before any agent depends on them. Both can try a single prompt and see the reply, token use, and latency. An operator can also try the student flow exactly as a student sees it.

## Mechanism

- **Key check**: `GET /api/llm/v1/key` takes the development key as a bearer and applies the same checks as a completion (`DevelopmentKeyService.verify`). It returns the season discovery view and spends nothing.
- **Key prompt test**: the page sends the pasted key to the existing `/api/llm/v1/chat/completions`, so a test prompt is an ordinary metered and recorded development call. The key lives only in page state.
- **Operator upstream view**: `GET /api/admin/llm` reports the upstream URL, whether a key is set, each alias with its upstream model and price, and the output-token defaults.
- **Operator test call**: `POST /api/admin/llm/chat` sends one request through the shared `UpstreamCaller`, with no metering or telemetry. An upstream refusal returns `502` with `upstream_status`, so a provider 401 never looks like an expired sign-in.
- **Shared prompt tester**: `LlmPlayground.vue` has model, max output tokens, system prompt, and user prompt fields, with placeholders that explain each prompt. It sends the limit as `max_completion_tokens`, which reasoning models require. A blank limit is left out, so the deployment default applies, and the placeholder names that default when the page knows it. The usage line reads `31 tokens in / 9 tokens out / 80 units / 640 ms`, and a reply's cost uses the price of the model it ran on. The caller supplies where the request goes and how a refusal reads: key calls get plain explanations, and upstream calls show the raw status, code, and message.
- **Budget refresh**: after each key run, the page checks the key the run used again. The result is applied only when no other key was checked in the meantime, so a slow refresh never brings back a replaced key.

## Page

One **LLM Playground** page at `/llm` serves everyone who can participate. Students reach it from **Test key** on a My Agents season row, and operators from **LLM Playground** in the sidebar, after **Server Logs**.

```text
LLM Playground

Deployment upstream  Operators only
https://provider/v1   Key set                          [Test all]
Alias  Upstream model   Status
large  gpt-5.1          ● OK · 820 ms                    [Test]
small  gpt-5-mini       ● 401 invalid_api_key            [Test]
                        Incorrect API key

Development key
API key [sk-sandbox-dev-••••••]                          [Check]
● Key works
Season 5 · three_branches
████████░░  900 units left of 1,000 units

Prompt
Send through [Development key (metered) ▾]  Model [small ▾]
Max output tokens [Default]
System prompt [Optional. Who the model is and how it should answer…]
User prompt   [Good morning!                                     ]
                                                          [Run]
Morning! The rye is warm.                                 [copy]
31 tokens in / 9 tokens out / 80 units / 640 ms
```

- **Students** see the Development key and Prompt sections. The Prompt section appears only after the key check passes.
- **Operators** also see the Deployment upstream section (`LlmUpstreamCard.vue`) and the **Send through** select, so they can compare the student flow with the direct upstream.
  - **Upstream (unmetered)** is offered when an upstream is configured, and is the default.
  - **Development key (metered)** is offered once a key check passes, and a passing check selects it.
- Each alias check sends "Reply with exactly: OK" with at most 16 output tokens, lowered to the deployment's hard limit when that is smaller. Without an upstream, the section names the variables to set.

## Tests

- Backend: `backend/test/admin/llm.test.ts` and the key-check case in `backend/test/llm/development-api.test.ts`.
- Frontend: `frontend/test/llm-testing.test.ts`, plus client cases in `api.test.ts` and link checks in `app-sidebar.test.ts` and `my-agents.test.ts`.
- Browser: the `seasons` group tests every alias against the stub upstream on `/llm`, and the `hearts` LLM journey checks a real key and runs one prompt there.
