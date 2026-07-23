# Stage 4.5: Information Architecture

Status: approved, navigation model since superseded. This document is checkpoint one of [Stage 4.5](../stage-04.5-ui-restructure.md). The page set and the game-stage principle below still hold, but the single three-zone top bar described under "Navigation model" has been replaced by a two-tier model: a collapsible left sidebar for the cross-game sections (Games, Seasons, Documentation, My Agents, account) plus a per-game contextual tab strip (Overview, Leaderboards, My Submissions, Manage). Front-facing the site now says "Game" for an environment and "Season" for a season. The current authority is the [frontend spec](../../docs/specs/frontend.md) and [frontend contributor guide](../../docs/contributors/frontend.md).

This is the rethought information architecture for the frontend. It covers what exists today, which is four pages plus the dev styleguide. It also reserves visible room for what stages 5 through 9 add: agent profiles, submissions, leaderboards, and telemetry, per [specs/frontend.md](../../docs/specs/frontend.md). The guiding idea is that the site is a small number of strong pages, and the navigation should make the eventual shape of the product legible now, so a student landing on the site understands what it will become.

## Sitemap

```
/                      Environments (the home page, the gallery)
/environments/:envId   Environment hub (overview: description, play and watch,
                       leaderboards, season history)
/sessions/:id          Live stage (an active session)
/replays/:id           Replay stage (a recorded session)
/styleguide            Dev-only primitive showcase, absent from production builds

Since shipped (the per-environment tab strip, ExperimentTabs.vue):
/environments/:envId/leaderboards/:seasonId?   Leaderboards tab (per season)
/environments/:envId/replays                   Replays tab (the environment's
                                               recordings, as a sortable table)
/environments/:envId/agents/:ownerId           My Submissions / agent profile tab
                                               (the agent profile, stage 5)
/environments/:envId/admin                     Operator admin console (operator-only)
```

Sessions and replays keep flat top-level routes rather than nesting under the environment, because they are shareable artifacts addressed by id. The page itself shows its environment context and links back.

## Navigation model

A single persistent top bar on every page, three zones:

- Left: the site name, set in the heading face, linking home.
- Center-left, next to the name: the primary sections. `Environments` is live today. `Agents` and `Leaderboards` appear as visible placeholders: greyed, not focusable, not links, each carrying a small `soon` tag. They make the product's shape legible without dead ends. `Agents` becomes real when stage 5 lands, and `Leaderboards` does when stage 6 lands.
- Right: the identity readout, `signed in as ⟨user⟩`, unchanged in meaning from Stage 4. When OAuth lands, this zone becomes the account affordance, and nothing else in the bar moves.

There is no secondary navigation layer. Pages below the bar provide their own context line (see the wireframes) instead of a breadcrumb component, because the hierarchy is only ever one level deep.

On narrow screens the bar keeps all three zones. The placeholder entries collapse first if space runs out, since they carry no function yet. The bar never becomes a hamburger menu at the current section count.

## Page purposes and wireframes

The wireframes are structural, not visual. Spacing, type, and color come from the design foundation and the styleguide season. The game-stage spotlight principle applies throughout: on session and replay pages the renderer canvas is the visual center, and the chrome around it stays quiet.

### Environments (home, `/`)

Purpose: choose an environment. One heading, one sentence of orientation for first-time visitors, then the gallery. Nothing else competes with the cards.

```
| site name   Environments  Agents(soon)  Leaderboards(soon)   signed in as dev-user |
|-------------------------------------------------------------------------------------|
|  Environments                                                                        |
|  Watch agents play, or play yourself.                                                |
|                                                                                      |
|  [thumb]            [thumb]            [thumb]                                       |
|  Flappy Bird        Hearts             ...                                           |
|  short description  short description                                                |
|  1 slot  human-playable                                                              |
```

Each card carries a thumbnail, display name, short description, slot count, and human-playable badge. The whole card is one link to the environment hub. It is unchanged in content from Stage 4, redesigned in presentation.

### Environment hub (`/environments/:envId`)

Purpose: everything about one environment in one place. At this stage that was the description, the entry points, and recent replays. Stages 5 and 6 added the submission form, leaderboards, and season history, and introduced the per-environment tab strip (`ExperimentTabs.vue`): at which point replays moved off the overview into their own **Replays** tab (a sortable recordings table), and submissions into the **My Submissions** tab. The overview is therefore a column of sections (description, the current season's leaderboards, season history) with the play and watch entry points; the tab strip carries the rest.

```
|  top bar                                                                             |
|-------------------------------------------------------------------------------------|
|  Flappy Bird   [Overview] [Leaderboards] [Replays] [My Submissions] [Manage*]        |
|                                                  (* operator-only; the tab strip)     |
|-------------------------------------------------------------------------------------|
|  Flappy Bird                                     [thumb, right]                      |
|  Longer description of the environment.                                              |
|  1 slot   human-playable   paced 50ms                                                |
|                                                                                      |
|  [ Play Yourself ]  [ Watch ]                    (hidden when not allowlisted)       |
|                                                                                      |
|  Leaderboards (current released season) + season history                            |
```

The start form opens as a modal dialog from Play or Watch instead of expanding inline. The reasoning: the form is a short interruption (seed, timeout, confirm), not a destination, and a dialog keeps the hub stable underneath. The end-to-end journey is unaffected.

At this stage the page closed with a trailing placeholder: one muted sentence, not styled section stubs, so the page did not accumulate empty boxes. Stages 5 and 6 replaced it with the real leaderboards and season-history sections and the tab strip.

### Live stage (`/sessions/:id`)

Purpose: host one active session with the renderer as the star. The chrome is one status strip and a compact metadata strip above the stage, both present while the session runs and after it ends. The only thing the end changes is the strip's controls: the replay and pin actions take the place the pause and stop buttons held.

```
|  top bar                                                                             |
|--------------------------------------------------------------------------------------|
|  Environments / Flappy Bird / Live Session      (context line, links back)           |
|                                                                                      |
|  ● running    reconnecting…        [ Pause ] [ Stop ]      (one status strip)        |
|  Mode · score · ticks · started …                (compact inline metadata strip)     |
|                                                                                      |
|  (no section headings; the log heads its own columns)                                |
|  +-------------------------------------+   Player | Tick | Decision                  |
|  |                                     |   -------+------+---------                  |
|  |          renderer canvas            |      0   |  118 | flap                      |
|  |                                     |      0   |  119 | hold                      |
|  +-------------------------------------+      0   |  120 | flap                      |
|  (the log's height matches the canvas beside it and scrolls within that height)      |
|                                                                                      |
|  (wide canvas, no room beside it: log moves below, same table:)                     |
|  +-------------------------------------------+                                       |
|  |              renderer canvas              |                                       |
|  +-------------------------------------------+                                       |
|  ▸ Decision log    Player | Tick | Decision      (collapsed when stacked)            |
|                                                                                      |
|  (after the session ends, the strip and metadata stay above the canvas:)             |
|  ● Game over            [ Watch replay ] [ Pin ]  (actions replace Pause/Stop)        |
|  Mode · score · ticks · started · ended …         (same metadata strip)              |
|  (no section headings)                                                                |
|  +-------------------------------------+   …      (canvas stays at the last moment)   |
|  +-------------------------------------+                                              |
```

The status indicator always pairs the colored dot with a text label (running, ended, reconnecting), never color alone. When the session ends, the badge names the termination reason (Game over, Stopped, …) in place of a separate end-card heading. The status strip and metadata strip stay above the canvas across the whole lifecycle, so the page does not reflow when the session ends: the strip's right zone simply swaps its controls, the replay and pin actions taking the place pause and stop held. Pause, stop, and the timeout display keep their Stage 4 behavior.

A running decision log shows the agent's per-tick actions as the session plays. The data is already in the stream the renderer consumes, so the log needs no new transport. Each `StepState` carries `agents[slot].action` (the action that agent took on the tick) and `agents[slot].timing.decision_ms` (how long it spent deciding). It is a `Player | Tick | Decision` table (the Player column shows the bare slot index), scrolling independently and pinned to the latest tick unless the reader scrolls up. The cells are terse by nature, a tick number and an action value, because an action is all an agent emits per tick. The column is sized to grow so a future environment with a richer (structured or multi-field) action space reads cleanly. This is not because anything streams in later: Stage 9's LLM call metadata is queried by request (see "What later stages slot in"), a detail view you open, not a live feed piped into this log.

The log's placement is responsive and driven by the canvas, not the viewport alone. It sits **alongside** the canvas when there is horizontal room left over after the canvas takes the size it wants. That is the common case for tall, narrow (vertical) canvases, which leave a column free. When the canvas is wide enough to claim the full width, the log **moves below** it and collapses by default, so it never forces the stage to shrink. The renderer is the star in both layouts, and the log only takes space the canvas does not want.

In the alongside layout the two columns read as a matched pair. Neither carries a section heading: the environment is already named in the tab strip and the log heads its own columns: so the canvas and the log table both start at the top of the row, and the log's height matches the canvas beside it, scrolling within that height rather than stopping short. The canvas declares its intrinsic aspect ratio (the same renderer metadata below), which fixes the canvas height and so the height the log fills.

The metadata above the stage is a single compact inline strip of the run's own facts (mode, score, ticks, dates), not a stacked block. It deliberately omits what the surrounding chrome already states, so none of those repeat in the strip: the environment is in the context line, the recording id is in the URL, the end reason titles the end card, and pin state is shown by the pin button. On the replay page the pin control sits at the trailing edge of the transport bar; on the live page it stays in the end-of-session card beside the replay link.

To decide this without guessing, each renderer declares its **aspect ratio** as metadata on its `RendererModule` (alongside `thumbnail`), derived from the fixed internal coordinate space the renderer draws in (its `internalSize`). The host sizes the canvas to that aspect ratio within the room available, then places the log beside a portrait canvas or below a landscape one based on what remains. The renderer draws in its internal space and the PixiJS base class scales it onto the real size, re-fitting in place when the rect changes (see [rendering.md](../../docs/contributors/environments/rendering.md)). This keeps responsive layout a property the renderer owns, since it knows its own shape, rather than something the host reverse-engineers from rendered pixels. The same metadata lets the home-card thumbnails and the replay stage reason about canvas shape consistently.

### Replay stage (`/replays/:id`)

Purpose: play back one recording, shareable by URL. Same stage layout as the live page so the two read as siblings, with the transport bar where the live page has its status strip.

```
|  top bar                                                                             |
|--------------------------------------------------------------------------------------|
|  Environments / Flappy Bird / Replay            (context line, links back)           |
|  seed · score · ticks · owner · created          (compact inline metadata strip)     |
|  [←] [▶ play] [→]  ─────────────●──────────────  tick 120 / 300  [Pin recording] |
|                                                                                      |
|  Flappy Bird                            Decision log    (each column gets a header)   |
|  +-------------------------------------+   Tick | Decision                           |
|  |                                     |   -----+---------                           |
|  |          renderer canvas            |    118 | flap                               |
|  |                                     |    119 | hold                               |
|  +-------------------------------------+    120 | flap                               |
```

The transport gains full keyboard operation (space toggles play, arrows step, Home and End jump), and the scrubber announces its position to assistive tech. Its buttons use the tight primitive size, the step controls show compact arrows with accessible names, and the pin action is last. The metadata block reuses the same component as the end-of-session card. Similarly, the decision log should reuse the same component.

### Styleguide (`/styleguide`, dev only)

Purpose: render every primitive in every variant and state, plus the token swatches (colors, spacing, type scale), so design review happens against the real components. Registered only in dev builds; the production bundle does not contain it.

## What later stages slot in

- Stage 5 (submissions): the `Agents` nav entry becomes a real section (agent profiles), and the environment hub gains the submission form section. The hub's section-column layout is the insertion point.
- Stage 6 (leaderboards): the `Leaderboards` nav entry becomes real, pointing at the per-environment boards on the hub. The hub gains the two boards and season history, and the replay stage gains the rating prompt next to pinning.
- Stage 9 (LLM gateway): the replay stage and agent profiles gain an owner-only view of an agent's LLM call metadata for a run (prompt, model, token and latency detail), queried by request for a tick or a run rather than streamed, because telemetry is detail you open, not a live feed. This is a separate surface from the decision log. The log shows agent actions from the state stream and is unchanged by Stage 9; the call-metadata view answers "why did it act that way" on demand. No new top-level sections.
- Stages 8 and 9 (multi-agent, chat): the live and replay stages gain slot assignment and the chat panel inside the existing stage layout, and the start dialog grows slot pickers.

Each stage retires or fills its placeholder as it lands. The parent stage files get a one-line note about this when Stage 4.5 closes.
