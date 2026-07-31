# Browser end-to-end tests

The end-to-end suite lives under `frontend/e2e/`. It runs Playwright with Chromium against the real backend, which serves the built frontend from the same origin. The suite and the `backend-integration` job require a Docker daemon. Being Docker-heavy makes the `frontend-e2e` job too slow for every push, so it has its own manually dispatched workflow at `.github/workflows/e2e.yml`. Run it from the Actions tab with **Run workflow** when a UI change warrants it.

For the wider verification matrix and how this job fits the pipeline, see [Testing](index.md). This page is about the suite itself: how to run it, how its data is set up, and the conventions for adding to it.

## Running it

```console
# Full job: build frontend + session image, install Chromium, run the suite.
uv run python scripts/ci.py frontend-e2e

# Rebuild both frontend bundles and run the tests (session image already built).
npm run e2e --workspace @game-sandbox/frontend

# Rebuild both frontend bundles and run one spec.
npm run e2e --workspace @game-sandbox/frontend -- leaderboards-admin.spec.ts
```

The suite runs serially (`workers: 1`, `fullyParallel: false`) so the real containers and the shared database never contend.

## Suite setup and spec inventory

`playwright.config.ts` starts the main backend on port 8090 and the loopback local-play bridge on port 8091. The suite uses the bootstrap admin as its operator and creates owners, judges, and spectators as real member accounts through `e2e/support/fixtures.ts`.

| Spec | Project | What it covers |
| --- | --- | --- |
| `journey.spec.ts` | main | Live play → pause/resume → stop → replay → pin. |
| `watch.spec.ts` | main | Watch a scripted session; a second context is a controls-less spectator. |
| `submission.spec.ts` | main | The resolve → static → build → load pipeline; a ready agent watched, and a load failure. |
| `leaderboards-admin.spec.ts` | main | Season cards, released history, operator preview, and a complete competition workflow. |
| `hearts.spec.ts` | main | Four-player rendering, scheduled matches, LLM journeys, seat selection, human play, and replay attribution. |
| `spades.spec.ts` | main | Messaging controls and a partnership matchup. |
| `auth.spec.ts` | main | Three authentication journeys: the admin signs in, sees the admin navigation, and signs out; the admin creates a user who then signs in and participates; a pending user is gated, an admin approves them on the Users page, and the controls unlock. |
| `local-play.spec.ts` | main | The standalone local bundle against the loopback bridge: a scripted run plus canvas device-pixel-ratio and resize behavior. |
| `simultaneous-metadata.spec.ts` | main | Synthetic simultaneous environment metadata offers an input window without a human-timeout override. |

## Manual GitHub OAuth check

GitHub OAuth depends on an external provider, so the frontend Vitest suite covers the button and account-management wiring with mocks. Before releasing a GitHub integration change, run this check against a deployment with `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` configured:

1. Create an email and password user whose email matches the verified primary email of a GitHub account. Sign in with GitHub and confirm the existing user is used, with its status and display name unchanged.
2. Sign in to a different email and password user, open My Profile, and connect a GitHub account with a different verified email. Confirm the account email changes to the GitHub email, the username appears on My Profile and in the account menu, and the old email no longer signs in.
3. Open an agent profile owned by that user and confirm the owner link opens the connected GitHub profile. Confirm leaderboards and recordings do not show the GitHub username.
4. Disconnect GitHub and confirm the username disappears while the changed account email remains. Confirm email and password sign-in still works with that email.
5. Sign in as a GitHub-only user and confirm My Profile does not allow disconnecting the final sign-in method.
6. Confirm that connecting a second GitHub account or a GitHub email already owned by another Game Sandbox user is refused with an inline error.

## A fresh database every run

`e2e/fresh-backend.mjs` starts each backend with a fresh data directory, first deleting the one directory it is launched with. This keeps local runs independent and lets tests use readable, stable names. Sibling directories under `.data/` are left untouched, including the demo snapshot and any manual backup directory a contributor keeps there.

## This data is the demo's fixture

`npm run demo` copies `frontend/e2e/.data/main/` to `demo/` and serves that copy. The e2e suite creates the source data, including recordings, submissions, and real sign-in accounts, so the demo and browser tests exercise the same workflows. After changing the data a journey creates, run `npm run demo -- --rerun-e2e` to rebuild the source fixture before starting the demo.

## Naming and shared helpers

Shared identities live in `e2e/support/names.ts` and shared API flows in `e2e/support/api.ts`. Reuse them instead of repeating request and assertion code.

- **Seasons** use short, themed labels without years, such as `Updraft Open` and `Thermals Cup`. Give each test a distinct label: the suite shares one database during a run, so duplicates make assertions ambiguous.
- **Agents** use their owner id as the public handle linked from the leaderboard and as the key in `/agents/<owner>`. Use realistic handles such as `ada-lovelace` and `grace-hopper`. Limit each owner to one test purpose so its profile remains unambiguous.
- **Raters** are active (`normal`) member accounts created by the `as` fixture. The Human Ratings board ranks an agent only after at least three distinct people rate it.

## Adding a test or fixture

- Add identities to `support/names.ts` and flows to `support/api.ts`; keep specs declarative.
- A new agent fixture is a folder under `fixtures/submission/` with a `manifest.json` (mirror `good/manifest.json`) and an `agent.py` exposing a callable `Agent` with `reset`/`act`.
- Assert DOM facts such as visible controls, a painted canvas, and board rows. Never assert pixels: font and GPU differences between runners would make the suite unreliable.
- Update the relevant Playwright journeys with any UI change, as [Testing](index.md#browser-end-to-end) requires.
