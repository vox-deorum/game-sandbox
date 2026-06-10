# Stage 9: Multi-Agent

Status: not started

## Goal

The system runs its first natively multi-agent environment end to end: multiple submissions share a session, the watch multi-agent flow exists, play-with-agent sessions have distinct human and agent slots, turn-based pacing works in practice, and chat finally has a product environment where it matters.

## Scope

Choose and integrate the first multi-agent PettingZoo environment at stage start; a simple turn-based board or card game is the proposed shape, since it exercises the turn-based session loop from [interaction.md](../specs/interaction.md) that Flappy Bird never touches. Give it the full public metadata, including slot counts above one, human-capable slots, messaging enabled with a sensible cap, and a renderer with on-screen input UI (board cells or action buttons, legal-move greying, turn indicators) in addition to or instead of raw device input.

Exercise the harness's multi-slot path for real: sequential stepping across several non-human slots, per-slot timing and timeouts, chat between distinct submissions, and the human occupying one slot among agents. Fix what the single-agent stages never had to get right.

Extend session image building per [execution.md](../specs/execution.md): a multi-agent session overlays every participating submission's code, each in its own per-slot directory, onto the base image for the iteration's pinned dependency-set version. Dependency conflicts cannot arise because every participant runs the same set; what this stage must get right is code isolation between checkouts (import paths, module name collisions between repos that both ship an `agent` module) and the harness loading each slot's class from its own directory.

Build the watch multi-agent flow from [frontend.md](../specs/frontend.md): pick agents for each slot in environments whose metadata allows more than one, then stream as usual. Extend play-with-agents so the human picks a slot and submitted agents fill the other non-human slots. Verify the leaderboard workflow on multi-agent match configurations, where opponents in the iteration's match configurations now name other submissions, and ratings apply per agent in shared sessions.

## Spec references

[environment.md](../specs/environment.md), [interaction.md](../specs/interaction.md) (turn-based loop, on-screen input), [frontend.md](../specs/frontend.md) (multi-agent flows), [execution.md](../specs/execution.md) (shared container, multi-submission images), [communication.md](../specs/communication.md), [leaderboard.md](../specs/leaderboard.md).

## Depends on

Stages 5 and 6 (submissions, workflow); Stage 7 in practice for chat between agents (a multi-agent stage without it just leaves messaging off).

## Done when

Two different submissions play each other in the new environment through the watch multi-agent flow, a human takes a slot against a submission using the on-screen input UI, the agents exchange chat visible per the visibility rules, a leaderboard iteration over the environment produces both boards, and the replay of a multi-agent match renders turns, messages, and per-slot scores correctly.

## Deviations

None yet.
