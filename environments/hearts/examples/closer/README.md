# Example: hearts/closer

A Hearts agent that concentrates its whole policy on the last player position of a trick, where you play with perfect information about the three cards already down. The directory stores only its differences from the composed template:

- It overrides one template file (`agent.py`) with an agent that reads the trick when it plays last: it ducks under the winner when it can, and when winning is unavoidable it dumps its _highest_ card into a trick that carries no points (offloading a dangerous king or ace for free) while taking a trick that holds points with its lowest winning card. In earlier player positions it falls back to safe, `duck`-style play.
- It adds tests (`tests/test_closer.py`) on top of the inherited template tests, asserting the agent plays a full game to completion against the built-in opponents and that, in the last player position and forced to win a points-free trick, it dumps its highest card where `duck` clings to its lowest.

Reading the last player position is where Hearts points are quietly saved or spent, so concentrating the whole policy there is a clean, legible idea.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts closer
```

The result is written to `build/examples/hearts/closer/`.
