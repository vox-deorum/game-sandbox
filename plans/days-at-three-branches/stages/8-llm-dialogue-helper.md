# Step 8: The Season 5 dialogue helper

Status: planned.

Part of [the plan](../README.md). This is the closing delivery and ships before Season 5. The template-layer dialogue controller carries LLM dialogue across ticks, with a worked pattern. The hands-on surface is a villager holding an in-character conversation with the visitor in a local day, falling back to canned lines when its budget runs out.

## Why this is its own seam

Season 5 unlocks platform LLM access for in-character replies to the visitor's freeform chat. A reply takes far longer than the 0.25 second decision window, so dialogue must ride across ticks: the controller starts a request on one tick, keeps the villager acting on the following ticks, delivers the reply as a talk when it arrives, and falls back to canned lines when the budget is gone. The gateway, credentials, budgets, and uncharged proxy waiting already exist on the platform.

## What to build

- An environment-specific dialogue controller in `environments/three_branches/template`, using `templates/base`'s existing `sandbox.llm.BackgroundLLM`.
- The controller owns one in-flight request and at most one waiting visitor line. A newer waiting line replaces an older one, and it starts only after the current reply is consumed.
- Before sending a talk, it normalizes whitespace and truncates the reply to 200 Unicode code points. Budget exhaustion and proxy errors use a canned fallback.
- The controller stores the latest `act(observation)` state and checks that the visitor is still a valid talk recipient before starting a waiting request or returning a reply. If the visitor has left talk range or moved behind a wall, it discards the waiting line or completed reply. It never returns a direct message that the current policy would drop.
- An internal in-character dialogue pattern extending the step 7 example: persona plus world-state prompting and the canned fallback.

## Tests

- Controller behavior against a fake proxy: request lifecycle across ticks, reply delivery as a talk, fallback on exhaustion or errors, over-cap replies, concurrent visitor input, and a visitor leaving talk range while a request or waiting line exists.
- The dialogue example completes a healthy day with the LLM enabled and disabled, within the decision and episode budgets.

## Done when

The hands-on conversation works in a local day, and the controller and pattern are covered by tests on both the enabled and disabled paths.
