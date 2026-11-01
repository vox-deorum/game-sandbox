# LLM Key and Prompt Testing

Status: complete.

## Goal

Give every participant one place to get a development key, confirm that it works, and try a prompt with it before any agent depends on it. Operators use the same flow, so they see exactly what a student sees, and can also confirm that the deployment's upstream credential and model mappings work.

## Mechanism

- **Key issue and rotation**: the page lists the seasons from `GET /api/llm-development/seasons` (open for submissions, with effective LLM access) and creates or rotates a key through `POST /api/seasons/:seasonId/llm-development-key`. Rotation asks for confirmation first, because the old key stops working at once. The new credential is shown once in `DevelopmentCredentialDialog`, then filled in and checked.
- **Key check**: `GET /api/llm/v1/key` takes the development key as a bearer and applies the same checks as a completion (`DevelopmentKeyService.verify`). It returns the season discovery view and spends nothing.
- **Prompt test**: the page sends the key to the existing `/api/llm/v1/chat/completions`, so a test prompt is an ordinary metered and recorded development call, for operators too. The key lives only in page state.
- **Operator upstream view**: `GET /api/admin/llm` reports the upstream URL, whether a key is set, each alias with its upstream model and price, and the output-token defaults.
- **Operator alias check**: `POST /api/admin/llm/chat` sends one request through the shared `UpstreamCaller`, with no metering or telemetry. An upstream refusal returns `502` with `upstream_status`, so a provider 401 never looks like an expired sign-in.
- **Operator model list**: `GET /api/admin/llm/models` reads the upstream's `GET /models` through `UpstreamCaller.listModels` and returns the sorted model ids. It reports refusals the same way as the alias check. The backend builds the `UpstreamCaller` whenever `LLM_UPSTREAM_URL` is set, so the list works before any alias is mapped and an operator can pick exact names for the `LLM_MODEL_*` variables.
- **Prompt tester**: `LlmPlayground.vue` has model, max output tokens, system prompt, and user prompt fields, with placeholders that explain each prompt. It sends the limit as `max_completion_tokens`, which reasoning models require. A blank limit is left out, so the deployment default applies. The usage line reads `31 tokens in / 9 tokens out / 80 units / 640 ms`, and a reply's cost uses the price of the model it ran on. Refusals get plain explanations from `describeLlmError`.
- **Budget refresh**: after each run, the page checks the key the run used again. The result is applied only when no other key was checked in the meantime, so a slow refresh never brings back a replaced key.

## Page

One **LLM Playground** page at `/llm` serves everyone who can participate. Students reach it from **Get or test key** on a My Agents season row, which keeps only the usage meter. Operators also reach it from **LLM Playground** in the sidebar, after **Server Logs**.

```text
LLM Playground

Upstream  Operators only
https://provider/v1   Key set            [List models] [Test all]
Alias  Upstream model   Status
large  gpt-5.1          ● OK · 820 ms                    [Test]
small  gpt-5-mini       ● 401 invalid_api_key            [Test]
                        Incorrect API key

Upstream models · 3
gpt-5.1 (large)      gpt-5-mini (small)      gpt-5-nano

Development key
Season 5 · three_branches   Key issued   [Rotate development key]
Week 4 · hearts             No key yet   [Create development key]
────────────────────────────────────────────────────────────────
API key [sk-sandbox-dev-••••••]                          [Check]
● Key works
Season 5 · three_branches
████████░░  900 units left of 1,000 units

Prompt
Model [small ▾]  Max output tokens [Default]
System prompt [Optional. Who the model is and how it should answer…]
User prompt   [Good morning!                                     ]
                                                          [Run]
Morning! The rye is warm.                                 [copy]
31 tokens in / 9 tokens out / 80 units / 640 ms
```

- The Prompt section appears only after a key check passes, for students and operators alike.
- With no eligible season, the key list says "No open season has LLM access." Operators also read how to fix it: turn on LLM for a season in Manage and open its submissions.
- The Upstream section is operators only. Each alias check sends "Reply with exactly: OK" with at most 16 output tokens, lowered to the deployment's hard limit when that is smaller. Without an upstream URL, the section names the variables to set. With a URL but no alias yet, it replaces the alias table with a hint to list the upstream's models and set an `LLM_MODEL_*` variable.
- **List models** shows the upstream's model ids in scrolling columns, since a routing provider can list hundreds. Each model an alias maps to carries that alias as a badge. A refusal shows the provider status and message, like an alias check.
- The owner's agent profile keeps its own Development access section with create, rotate, and call history.

## Tests

- Backend: `backend/test/admin/llm.test.ts` and the key-check case in `backend/test/llm/development-api.test.ts`.
- Frontend: `frontend/test/llm-testing.test.ts`, plus client cases in `api.test.ts` and link checks in `app-sidebar.test.ts` and `my-agents.test.ts`.
- Browser: the `seasons` group tests every alias and lists the models of the stub upstream on `/llm`, and the `hearts` LLM journey follows **Get or test key** from My Agents, creates and rotates a key on the playground, and runs one prompt there.
