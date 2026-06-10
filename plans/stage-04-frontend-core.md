# Stage 4: Frontend Core

Status: not started

## Goal

A person can sign in with GitHub, browse environments, play Flappy Bird live in the browser, and watch any recording in the replay viewer. This is the first stage a non-developer can experience.

## Scope

Stand up the web app in `frontend/`. Proposed defaults, to be confirmed at stage start: React with Vite, TypeScript throughout, types imported from the Stage 1 generated schema types, and a renderer architecture where each environment registers a module that receives per-step state objects and draws into a canvas or DOM region, per [interaction.md](../specs/interaction.md).

Implement GitHub OAuth in the backend and frontend per [frontend.md](../specs/frontend.md). The GitHub username is the single identifier used everywhere. Implement the operator-configured allowlist that gates starting live sessions.

Build the pages that make sense before submissions exist: Home with environment cards driven by the public metadata, and the Environment page with description and entry points into play and watch (leaderboards and the submission form join in Stages 5 and 6).

Write the Flappy Bird renderer: the game world from the state object's overlay fields plus the game UI (score, tick, lives or attempts, status messages) so it reads as a game rather than a debugger view. Wire raw device input (key, click, touch) through the WebSocket as actions. The same renderer module must run from a stored recording without code changes, since live play and replay share renderers by design.

Add the live-session control for the human-slot timeout from [interaction.md](../specs/interaction.md). Default it from the environment metadata, send the resolved value when starting a session, and show the active timeout in the play UI when it can affect the session. For Flappy Bird (a paced environment) this deadline is the per-step noop window; the same control becomes the move clock for a later turn-based environment, with no second mechanism. Also add the play UI's pause control: pausing a live session freezes the pace cadence and the decision clock together until resume, per [interaction.md](../specs/interaction.md). For single-slot Flappy Bird this is a plain pause; the control is wired through the session so it generalizes to later environments.

Build the replay viewer per [recording.md](../specs/recording.md): load a recording by URL, play, pause, step, and scrub. Implement the retention policy from the same spec in the backend: a deployment-configured window (30 days default), a per-user quota, oldest-unpinned-first eviction, and pinning at the end of a session. The post-session feedback prompt appears here but ratings storage lands in Stage 6; until then it can be a stub that only offers pinning.

## Spec references

[frontend.md](../specs/frontend.md) (pages, flows, identity, on-demand play), [interaction.md](../specs/interaction.md) (renderer contract, input), [recording.md](../specs/recording.md) (replay, retention, pinning).

## Depends on

Stage 3 (backend API, WebSocket protocol, recordings on disk).

## Done when

An allowlisted user signs in with GitHub, starts a Flappy Bird session from the environment page, plays it with the keyboard, sees the active human-slot timeout in the play UI, and after the session ends opens the replay from a shareable URL and scrubs through it. Starting a session with an overridden timeout sends that value to the backend. A non-allowlisted user can watch and replay but cannot start a session. Eviction removes the oldest unpinned recording when a test user exceeds the quota, and a pinned recording survives.

## Deviations

None yet.
