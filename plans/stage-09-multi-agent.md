# Stage 9: Multi-Agent

Status: not started

## Goal

The system runs its first natively multi-agent environment end to end: multiple submissions share a session, the watch multi-agent flow exists, play-with-agent sessions have distinct human and agent slots, turn-based pacing works in practice, and chat finally has a product environment where it matters. The environment for this stage is the card game **Hearts**.

## Scope

Integrate **Hearts** as the first multi-agent environment, chosen at stage start. Hearts is a four-player trick-taking card game, which makes it a good fit: it has a fixed slot count above one, it is naturally turn-based so it exercises the turn-based session loop from [interaction.md](../specs/interaction.md) that Flappy Bird never touches, it has obvious legal-move structure for the on-screen input UI, and it has a real reason for agents to talk to each other (coordinating against a player who looks like they are shooting the moon). Hearts is not in the PettingZoo classic set, so implement it as a custom environment against the PettingZoo **AEC** (Agent Environment Cycle) API, which is the API designed for sequential turn-based games.

Hearts specifics to build:

- **Slots and scoring.** Four slots. For this stage, one connected human can occupy one slot and submitted agents fill the rest, but the slot metadata and session assignment must not assume Hearts can only ever have one human-controlled seat. Scoring is penalty-based: each heart is one point, the queen of spades is thirteen, lower total is better, and "shooting the moon" (taking every heart and the queen) flips to zero for the shooter and twenty-six for everyone else. Per-slot scores are part of the per-step state object and must render and replay correctly.
- **Rules to enforce in the environment.** Follow suit if able; hearts may not be led until broken; the two of clubs leads the first trick; no hearts or queen of spades on the first trick. The first cut may use the no-pass variant of Hearts to avoid modeling the opening three-card pass as a separate decision round; note the pass as a follow-up if we want it, since it is itself an interesting multi-agent signaling moment.
- **Renderer and on-screen input.** Draw the player's hand, the current trick, a turn indicator, and the running per-slot penalty scores. Clicking a card plays it; cards that are not legal on the current turn (wrong suit when the led suit is held, hearts before broken, first-trick restrictions) are greyed out. This is the on-screen input UI from [interaction.md](../specs/interaction.md), in place of raw device input.
- **Messaging.** Enabled with a low per-step cap. Hearts gives broadcast vs. targeted visibility a real test: agents can openly warn the table about a suspected moon shot (broadcast) or quietly coordinate (targeted), and the visibility rules from [communication.md](../specs/communication.md) decide who sees what during play versus in the recording.

Exercise the harness's multi-slot path for real: sequential stepping across the non-human slots, per-slot timing and timeouts, chat between distinct submissions, and a human-controlled slot among agents. Fix what the single-agent stages never had to get right.

Extend session image building per [execution.md](../specs/execution.md): a multi-agent session overlays every participating submission's code, each in its own per-slot directory, onto the base image for the iteration's pinned dependency-set version. Dependency conflicts cannot arise because every participant runs the same set; what this stage must get right is code isolation between checkouts (import paths, module name collisions between repos that both ship an `agent` module) and the harness loading each slot's class from its own directory.

Build the watch multi-agent flow from [frontend.md](../specs/frontend.md): pick agents for each slot in environments whose metadata allows more than one, then stream as usual. Extend play-with-agents so the connected human picks a slot for this stage and submitted agents fill the other non-human slots, with the UI and session payloads expressed as slot assignments so later multi-human play can attach more connected users. Verify the leaderboard workflow on multi-agent match configurations, where opponents in the iteration's match configurations now name other submissions, and ratings apply per agent in shared sessions.

## Human-slot timeout use

The human-slot timeout is defined and exposed before this stage (Stages 2 through 4, and [interaction.md](../specs/interaction.md)). Stage 9 only needs to exercise it in a turn-based product environment: Hearts provides a legal default action for a timed-out human-controlled slot, for example the lowest legal card, and the renderer shows the active move clock using the session value.

## Spec references

[environment.md](../specs/environment.md), [interaction.md](../specs/interaction.md) (turn-based loop, on-screen input, human-slot pacing), [frontend.md](../specs/frontend.md) (multi-agent flows, session controls), [execution.md](../specs/execution.md) (shared container, multi-submission images), [communication.md](../specs/communication.md), [leaderboard.md](../specs/leaderboard.md) (timeouts, overrides).

## Depends on

Stages 5 and 6 (submissions, workflow); Stage 7 in practice for chat between agents (a multi-agent stage without it just leaves messaging off).

## Done when

Two different submissions play a full game of Hearts against each other through the watch multi-agent flow, one connected human takes a slot against three submissions using the on-screen card UI with illegal cards greyed out, the human-slot timeout auto-plays a legal move when that slot stalls past the configured window, the agents exchange chat visible per the visibility rules, a leaderboard iteration over Hearts produces both boards, and the replay of a multi-agent match renders trick-by-trick turns, messages, and per-slot penalty scores correctly.

## Deviations

None yet.
