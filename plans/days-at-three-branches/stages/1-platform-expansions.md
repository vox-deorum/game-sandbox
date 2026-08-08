# Step 1: Platform contract expansions

Status: planned.

Part of [the plan](../README.md). This is build-order step 1: every contract change the design assumes, landed together as one reviewable platform change before any game code exists. The hands-on surface is a fixture simultaneous `Dict` environment passing the full conformance suite, with bounded broadcasts and public delivery visible in a harness test run.

## Why this is its own seam

These changes touch the harness, the metadata schema, and the backend, and every later step builds on them. Landing them alone, proven by a fixture instead of the real game, keeps the platform change small to review and keeps every existing environment green while the contract moves.

## What to build

### Mask-free Dict actions in simultaneous environments

The platform specification currently limits a `Dict` action space to sequential environments. The pinned PettingZoo `parallel_api_test` only breaks on a published `action_mask`: `sample_action` reduces a mask with `np.flatnonzero`, but an observation without an `action_mask` key samples through the action space itself, which handles a `Dict` correctly. Narrow the rule in [environment.md](../../../docs/specs/environment.md): a simultaneous environment may declare a `Dict` action space when it publishes no mask and every in-space value is legal in every reachable state. `Dict` plus a published mask stays sequential-only until the upstream fix reaches a release.

### Environment-limited broadcasts

`ChatRouter.deliver` sends a broadcast to every other active player. The environment gains an optional `broadcast_recipients(sender)` hook, discovered and validated like `chat_policy`, returning the players a broadcast from `sender` reaches this boundary. No hook keeps today's full delivery. Three Branches uses it to bound an NPC shout to shout range and the visitor's broadcast to talk range. Document the hook in [communication.md](../../../docs/specs/communication.md).

### Public messages

`EnvironmentMeta` gains `public_messages: bool = False`, threaded through `to_json`, the zod environment schema, the regenerated JSON schema, the backend registry, and the live-session visibility check. Today a spectator never sees a targeted message live, and every NPC talk is targeted, so watchers of this game would see only shouts. A declared-public environment's delivered lines reach every viewer socket; replays already show every line. The spectator-facing test lands with the chat panel in step 3.

### Per-agent seeds

The participant runner passes the one session seed to every agent's `reset`. Ten separately constructed instances of one submission seeded identically behave identically, and the design gives the scripted visitor its own match-play stream through its agent seed. The runner derives each agent's seed deterministically from the session seed and the player id. Replays are unaffected, because they replay recorded actions. Add the derivation sentence to [submission.md](../../../docs/specs/submission.md).

### The fixture

A minimal simultaneous environment with a mask-free `Dict` action space joins the harness test fixtures, exercising conformance, the broadcast hook, public visibility, and derived seeds end to end.

Human capability needs no platform work: the visitor is `player_0` in every plan, so `human_players` is the single entry `player_0` and resolves correctly everywhere today.

## Tests

- The fixture through PettingZoo's `parallel_api_test` and the platform's stricter parallel subset.
- Broadcast hook validation, the no-hook fallback, and delivery bounds.
- `public_messages` round-trip through the zod schema and the backend visibility check.
- Seed derivation distinct per player and stable per session seed.

## Done when

The fixture is green across the conformance suite, a fixture broadcast reaches exactly the hook's audience, a public fixture line is visible to a non-controller, agents receive derived seeds, and the revised specifications state each rule.
