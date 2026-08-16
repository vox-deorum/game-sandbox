# Neighbor

`neighbor` is the Season 4 starter example for Days at Three Branches. Each villager owns a
separate memory dictionary, builds its route graph during `reset`, and follows the same static
role table through dawn, morning, midday, evening, and night.

Compose the example from the repository root, then use its normal local watch command:

```text
uv run python scripts/compose.py three_branches neighbor
cd build/examples/three_branches/neighbor
python -m sandbox watch
```

Use the Season 4 parameters when starting a local day. The ten residents leave home, work across
the village, gather at midday, light props in the evening, return home, and sleep at night. The
schedule is intentionally non-adaptive. `assign` in `agent.py` is the small seam to replace with
a different village story. Lanterns are optional generation dressing, so a layout without them
sends each lantern-tender back to that resident's unique role prop for the evening work period.

`routines.py` shows one working routing approach. It makes a graph from `layout.walkable`,
`layout.can_step`, and `layout.ground_at` once in `reset`, then searches the cached graph during
ticks. The graph includes every walkable village cell. Its cell resolution and route finder are
example choices, not requirements.

`dialogue.py` keeps one latest visitor line and uses the background LLM helper without blocking a
routine tick. It sends a direct raw chat dictionary only while the visitor is still in hearing
range with a clear line, and falls back to a canned reply when the request cannot run.

## Run the repository demo

From the repository root, rebuild the end-to-end fixture and start the demo:

```text
npm run demo -- --rerun-e2e
```

This requires Docker and can take several minutes. Open <http://localhost:8080>, sign in with the
printed student credentials, and open Three Branches. Under `Play and Rate: Village Life`, choose
the agent, select `Rate` or `Watch again`, then select `Start watching`.

Later launches can use `npm run demo`, which reuses the generated fixture.
