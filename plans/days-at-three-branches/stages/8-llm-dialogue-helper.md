# Step 8: The Season 5 dialogue helper

Status: planned.

Part of [the plan](../README.md). This is build-order step 8: the template-layer helper that carries LLM dialogue across ticks, with a worked pattern. The hands-on surface is a villager holding an in-character conversation with the visitor in a local day, falling back to canned lines when its budget runs out.

## Why this is its own seam

Season 5 unlocks platform LLM access for in-character replies to the visitor's freeform chat. A reply takes far longer than the 0.25 second decision window, so dialogue must ride across ticks: the helper starts a request on one tick, keeps the villager acting on the following ticks, delivers the reply as a talk when it arrives, and falls back to canned lines when the budget is gone. The gateway, credentials, budgets, and uncharged proxy waiting already exist on the platform; this is template work plus a worked pattern, and it closes the plan.

Timing is a course-ops choice recorded here: this step ships before Season 5 needs it, either as the plan's closing step or planned again nearer the season. The plan carries it as step 8 until that is settled.

## What to build

- The background-request helper in the template layer, over the existing LLM proxy credentials.
- An internal in-character dialogue pattern extending the step 7 example: persona plus world-state prompting, and the budget-exhaustion fallback.

## Tests

- Helper behavior against a fake proxy: request lifecycle across ticks, reply delivery as a talk, fallback on exhaustion.
- The dialogue example completes a healthy day with the LLM enabled and disabled.

## Done when

The hands-on conversation works in a local day, and the helper and pattern are covered by tests on both the enabled and disabled paths.
