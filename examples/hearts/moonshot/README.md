# Example: hearts/moonshot

An aggressive Hearts agent that tries to shoot the moon: take every heart and the queen of spades so its score flips to 0 while each opponent takes 26. The directory stores only its differences from the composed template:

- It overrides one template file (`agent.py`) with an agent that plays to _win_ tricks rather than avoid them: it leads high, follows suit with the highest card that can still take the trick, and when void hoards its points instead of spilling them. This is the deliberate opposite of the `duck` example.
- It adds tests (`tests/test_moonshot.py`) on top of the inherited template tests, asserting the agent plays a full game to completion against the built-in opponents and that, given a trick it can win by following suit, it plays high to take it.

The moon rarely comes off against careful opponents, so this is a showcase of a clear, aggressive idea rather than a strong policy.

Compose the runnable repository:

```console
uv run python scripts/compose.py hearts moonshot
```

The result is written to `build/examples/hearts/moonshot/`.
