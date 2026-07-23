# Example: hearts/assassin

A Hearts agent built entirely around the queen of spades, which is worth thirteen of a hand's twenty-six penalty points. The directory stores only its differences from the composed template:

- It overrides one template file (`agent.py`) with an agent that hunts the queen: it leads low spades to drag the queen out of opponents' hands, sheds the king and ace of spades safely when it can stay under a trick, and when void unloads its most dangerous card (the queen first, then the high spades).
- It adds tests (`tests/test_assassin.py`) on top of the inherited template tests, asserting the agent plays a full game to completion against the built-in opponents and that, given the lead, it opens with a low spade where `duck` would open with its lowest card of any suit.

Leading spades while it may still hold the queen is a calculated risk, which is the point: a sharp, one-idea policy rather than a balanced one.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts assassin
```

The result is written to `build/examples/hearts/assassin/`.
