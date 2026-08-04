# Game Sandbox Agent Template: Skirmish at Crane Reach

This is a working starter for a Skirmish at Crane Reach agent. Edit `agent.py`, then run the local commands supplied with your assignment to play and test it.

Your `Agent` class receives one observation on each unit's turn. Its `act` method must return an order with these two integer fields:

```python
{"path": 0, "target": 0}
```

The starter returns that order, which keeps the unit in place and leaves targeting automatic. It is always legal. Read [`environment.md`](environment.md) for a short game, observation, and action overview.

## LLM availability

Skirmish at Crane Reach does not enable model calls. The composed starter still includes `python -m sandbox llm` and the shared [Using the LLM API](llm.md) reference, which report the availability configured for an environment.
