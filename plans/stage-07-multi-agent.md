# Stage 7: Multi-Agent

Status: not started

## Goal

The system runs its first natively multi-agent environment end to end: multiple submissions share a session, the watch multi-agent flow exists, play-with-agent sessions have distinct human and agent slots, and the unpaced multi-slot session loop works in practice. The environment for this stage is the card game **Hearts**. Hearts is a natural home for agent-to-agent messaging, but messaging itself lands in Stage 8; this stage ships Hearts chat-less and Stage 8 lights chat up on it.

## Scope

Integrate **Hearts** as the first multi-agent environment, chosen at stage start. Hearts is a four-player trick-taking card game, which makes it a good fit: it has a fixed slot count above one, it runs the same single session loop with no pace interval (the turn-based path from [interaction.md](../specs/interaction.md), advancing as each slot acts), so it exercises the multi-slot stepping that Flappy Bird's single paced slot never did, it has obvious legal-move structure for the on-screen input UI, and it will later give agent messaging a real reason to exist (coordinating against a player who looks like they are shooting the moon). Hearts is not in the PettingZoo classic set, so implement it as a custom environment against the PettingZoo **AEC** (Agent Environment Cycle) API, which is the API designed for sequential turn-based games.

Hearts specifics to build:

- **Slots and scoring.** Four slots. For this stage, one connected human can occupy one slot and submitted agents fill the rest, but the slot metadata and session assignment must not assume Hearts can only ever have one human-controlled seat. Native Hearts scoring is penalty-based: each heart is one point, the queen of spades is thirteen, lower total is better, and "shooting the moon" (taking every heart and the queen) flips to zero for the shooter and twenty-six for everyone else. The renderer shows those native penalty scores. For automated ranking, Hearts reports a normalized leaderboard score, such as negative penalty total, so the Stage 6 board can keep its higher-is-better rule. Per-slot display scores and leaderboard scores must both render and replay correctly where they appear.
- **Rules to enforce in the environment.** Follow suit if able; hearts may not be led until broken; the two of clubs leads the first trick; no hearts or queen of spades on the first trick. The first cut may use the no-pass variant of Hearts to avoid modeling the opening three-card pass as a separate decision round; note the pass as a follow-up if we want it, since it is itself an interesting multi-agent signaling moment.
- **Renderer and on-screen input.** Draw the player's hand, the current trick, a turn indicator, and the running per-slot penalty scores. Clicking a card plays it; cards that are not legal on the current turn (wrong suit when the led suit is held, hearts before broken, first-trick restrictions) are greyed out. This is the on-screen input UI from [interaction.md](../specs/interaction.md), in place of raw device input.
- **Messaging stays off here.** Hearts is built with the messaging flag disabled in this stage; Stage 8 enables it (a low per-step cap, moon-shot broadcast-versus-targeted coordination) using this same environment as its test bed. Building Hearts chat-less keeps the multi-slot stepping, isolation, and turn-based work separate from the chat-routing work.
- **Template layer.** Hearts lands as a second environment template on the existing two-layer machinery: a `templates/hearts/` layer (its `agent.py` stub, README, and generated `sandbox_env/`) over the shared `templates/base/`, registered in `TEMPLATE_ENVS`, with at least one `examples/hearts/<name>` example. It shares the single global dependency set, so no new `template-v<N>` axis is introduced. See [Examples and the template](../docs/contributors/examples-and-template.md).

Exercise the harness's multi-slot path for real: sequential stepping across the non-human slots, per-slot timing and timeouts, and a human-controlled slot among agents. Fix what the single-agent stages never had to get right.

Extend session image building per [execution.md](../specs/execution.md): a multi-agent session overlays every participating submission's code, each in its own per-slot directory, onto the base image for the iteration's pinned dependency-set version. Dependency conflicts cannot arise because every participant runs the same set; what this stage must get right is code isolation between checkouts (import paths, module name collisions between repos that both ship an `agent` module) and the harness loading each slot's class from its own directory.

Build the watch multi-agent flow from [frontend.md](../specs/frontend.md): pick agents for each slot in environments whose metadata allows more than one, then stream as usual. Extend play-with-agents so the connected human picks a slot for this stage and submitted agents fill the other non-human slots, with the UI and session payloads expressed as slot assignments so later multi-human play can attach more connected users. Verify the leaderboard workflow on multi-agent match configurations, where opponents in the iteration's match configurations now name other submissions, and ratings apply per agent in shared sessions.

## Human-slot timeout use

The human-slot timeout is defined and exposed before this stage (Stages 2 through 4, and [interaction.md](../specs/interaction.md)). Stage 7 only needs to exercise it in an unpaced (turn-based) product environment: Hearts provides a legal default action for a timed-out human-controlled slot, for example the lowest legal card, and the renderer shows the active move clock using the session value.

## Spec references

[environment.md](../specs/environment.md), [interaction.md](../specs/interaction.md) (unpaced multi-slot loop, on-screen input, human-slot pacing), [frontend.md](../specs/frontend.md) (multi-agent flows, session controls), [execution.md](../specs/execution.md) (shared container, multi-submission images), [leaderboard.md](../specs/leaderboard.md) (timeouts, overrides).

## Depends on

Stages 5 and 6 (submissions, workflow). Messaging is not required here; it arrives in Stage 8, which uses this Hearts environment as its test bed.

## Done when

Two different submissions play a full game of Hearts against each other through the watch multi-agent flow, one connected human takes a slot against three submissions using the on-screen card UI with illegal cards greyed out, the human-slot timeout auto-plays a legal move when that slot stalls past the configured window, a leaderboard iteration over Hearts produces both boards with lower native penalties ranked through higher normalized leaderboard scores, and the replay of a multi-agent match renders trick-by-trick turns and per-slot penalty scores correctly.
