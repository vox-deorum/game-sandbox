# Stage 4.5: Information Architecture

Status: proposed, awaiting owner approval. This document is checkpoint one of [Stage 4.5](../stage-04.5-ui-restructure.md): no page is rebuilt until the owner approves it. Record the approval date here when it happens.

This is the rethought information architecture for the frontend. It covers what exists today (four pages plus the dev styleguide) and reserves visible room for what stages 5 through 9 add (agent profiles, submissions, leaderboards, telemetry), per [specs/frontend.md](../../specs/frontend.md). The guiding idea: the site is a small number of strong pages, and the navigation should make the eventual shape of the product legible now, so a student landing on the site understands what it will become.

## Sitemap

```
/                      Environments (the home page, the gallery)
/environments/:envId   Environment hub (overview, play and watch, recent replays;
                       later: leaderboards, submission form, iteration history)
/sessions/:id          Live stage (an active session)
/replays/:id           Replay stage (a recorded session)
/styleguide            Dev-only primitive showcase, absent from production builds

Future, anticipated but not routed yet:
/agents/:agentId       Agent profile (stage 5)
leaderboards           Stage 6; per environment per iteration, so it most likely
                       lives on the environment hub rather than as its own route,
                       with the nav entry scrolling or linking there
```

Sessions and replays keep flat top-level routes (not nested under the environment) because they are shareable artifacts addressed by id; the page itself shows its environment context and links back.

## Navigation model

A single persistent top bar on every page, three zones:

- Left: the site name, set in the heading face, linking home.
- Center-left, next to the name: the primary sections. `Environments` is live today. `Agents` and `Leaderboards` appear as visible placeholders: greyed, not focusable, not links, each carrying a small `soon` tag. They make the product's shape legible without dead ends. When stage 5 lands, `Agents` becomes real; when stage 6 lands, `Leaderboards` does.
- Right: the identity readout, `signed in as ⟨user⟩`, unchanged in meaning from Stage 4. When OAuth lands this zone becomes the account affordance; nothing else in the bar moves.

There is no secondary navigation layer. Pages below the bar provide their own context line (see the wireframes) instead of a breadcrumb component, because the hierarchy is only ever one level deep.

On narrow screens the bar keeps all three zones; the placeholder entries collapse first if space runs out (they carry no function yet). The bar never becomes a hamburger menu at the current section count.

## Page purposes and wireframes

The wireframes are structural, not visual; spacing, type, and color come from the design foundation and the styleguide iteration. The game-stage spotlight principle applies throughout: on session and replay pages the renderer canvas is the visual center, and the chrome around it stays quiet.

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

Each card: thumbnail, display name, short description, slot count, human-playable badge. The whole card is one link to the environment hub. Unchanged in content from Stage 4, redesigned in presentation.

### Environment hub (`/environments/:envId`)

Purpose: everything about one environment in one place. Today that is the description, the entry points, and recent replays. Stages 5 and 6 add the submission form, leaderboards, and iteration history to this same page, so the hub is laid out as a column of sections that future stages append to.

```
|  top bar                                                                             |
|-------------------------------------------------------------------------------------|
|  Environments / Flappy Bird                      (context line, link back to /)      |
|                                                                                      |
|  Flappy Bird                                     [thumb, right]                      |
|  Longer description of the environment.                                              |
|  1 slot   human-playable   paced 50ms                                                |
|                                                                                      |
|  [ Play ]  [ Watch ]                             (hidden when not allowlisted)       |
|                                                                                      |
|  Recent replays                                                                      |
|  - replay row (id, date, score, pinned badge)                                        |
|  - replay row                                                                        |
|                                                                                      |
|  Leaderboards and agent submissions arrive in later stages.   (quiet placeholder)    |
```

The start form opens as a modal dialog from Play or Watch instead of expanding inline. The decision: the form is a short interruption (seed, timeout, confirm), not a destination, and a dialog keeps the hub stable underneath. The end-to-end journey is unaffected.

The trailing placeholder is one muted sentence, not styled section stubs, so the page does not accumulate empty boxes.

### Live stage (`/sessions/:id`)

Purpose: host one active session with the renderer as the star. The chrome is one status strip above the stage and the end-of-session card after it ends.

```
|  top bar                                                                             |
|--------------------------------------------------------------------------------------|
|  Environments / Flappy Bird / Live Session      (context line, links back)           |
|                                                                                      |
|  ● running    reconnecting…        [ Pause ] [ Stop ]      (one status strip)        |
|  metadata (environment, seed, score, ticks, ...)                                     |
|                                                                                      |
|  +-------------------------------------+   Decision log                              |
|  |                                     |   Tick | Decision                           |
|  |          renderer canvas            |   -----+---------                           |
|  |                                     |    118 | flap                               |
|  |                                     |    119 | hold                               |
|  +-------------------------------------+    120 | flap                               |
|                                                                                      |
|  (wide canvas, no room beside it — log moves below, same table:)                     |
|  +-------------------------------------------+                                       |
|  |              renderer canvas              |                                       |
|  +-------------------------------------------+                                       |
|  ▸ Decision log    Tick | Decision               (collapsed when stacked)            |
|                                                                                      |
|  (after the session ends, in place of the strip:)                                    |
|  ● completed                                                                         |
|  metadata (environment, seed, score, ticks, ...)                                     |
|  (canvas stays at the last moment)                                                   |
|  [ Watch replay ]  [ Pin replay ]                                                    |
```

The status indicator pairs the colored dot with a text label always (running, ended, reconnecting), never color alone. Pause, stop, and the timeout display keep their Stage 4 behavior.

A running decision log streams the agent's per-tick choices as the session plays. It is a two-column table, `Tick | Decision`, scrolling independently and pinned to the latest tick unless the reader scrolls up. Today the cells are terse (a tick number and an action name); the column is sized to grow, because the LLM-based agents of later stages will emit richer reasoning per tick (Stage 7's per-tick call metadata is the natural feed for it).

The log's placement is responsive and driven by the canvas, not the viewport alone. It sits **alongside** the canvas when there is horizontal room left over after the canvas takes the size it wants — the common case for tall, narrow (vertical) canvases, which leave a column free. When the canvas is wide enough to claim the full width, the log **moves below** it and collapses by default, so it never forces the stage to shrink. The renderer is the star in both layouts; the log only takes space the canvas does not want.

To decide this without guessing, each renderer declares its **targeted canvas size** as metadata on its `RendererModule` (alongside `thumbnail`) — an intrinsic size and/or aspect ratio the renderer is designed for. The host lays the canvas out at or under that target, then places the log beside or below based on the room that remains. This keeps responsive layout a property the renderer owns (it knows its own shape) rather than something the host reverse-engineers from rendered pixels, and the same metadata lets the home-card thumbnails and the replay stage reason about canvas shape consistently.

### Replay stage (`/replays/:id`)

Purpose: play back one recording, shareable by URL. Same stage layout as the live page so the two read as siblings, with the transport bar where the live page has its status strip.

```
|  top bar                                                                             |
|--------------------------------------------------------------------------------------|
|  Environments / Flappy Bird / Replay            (context line, links back)     [pin] |
|  metadata (environment, session, seed, score, owner, dates)                          |
|  [⏮] [⏪] [ ▶ play ] [⏩] [⏭]  ───────●─────────  tick 120 / 300                  |
|                                                                                      |
|  +-------------------------------------+   Decision log                              |
|  |                                     |   Tick | Decision                           |
|  |          renderer canvas            |   -----+---------                           |
|  |                                     |    118 | flap                               |
|  |                                     |    119 | hold                               |
|  +-------------------------------------+    120 | flap                               |
```

The transport gains full keyboard operation (space toggles play, arrows step, Home and End jump) and the scrubber announces its position to assistive tech. The metadata block reuses the same component as the end-of-session card. Similarly, the decision log should reuse the same component.

### Styleguide (`/styleguide`, dev only)

Purpose: render every primitive in every variant and state, plus the token swatches (colors, spacing, type scale), so design review happens against the real components. Registered only in dev builds; the production bundle does not contain it.

## What later stages slot in

- Stage 5 (submissions): the `Agents` nav entry becomes a real section (agent profiles), and the environment hub gains the submission form section. The hub's section-column layout is the insertion point.
- Stage 6 (leaderboards): the `Leaderboards` nav entry becomes real, pointing at the per-environment boards on the hub; the hub gains the two boards and iteration history. The replay stage gains the rating prompt next to pinning.
- Stage 7 (LLM gateway): the replay stage gains per-tick call metadata, which also feeds the live stage's decision log with the agent's reasoning per tick; agent profiles gain the owner-only debug view. No new top-level sections.
- Stages 8 and 9 (multi-agent, chat): the live and replay stages gain slot assignment and the chat panel inside the existing stage layout; the start dialog grows slot pickers.

Each stage retires or fills its placeholder as it lands; the parent stage files get a one-line note about this when Stage 4.5 closes.
