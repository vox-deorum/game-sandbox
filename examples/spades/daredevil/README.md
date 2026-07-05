# Example: spades/daredevil

A Spades agent whose one idea is **nil, out loud**: it bids nil when its hand is safe enough to take no tricks, **broadcasts** a warning to the table, and covers a partner who did the same. It is the broadcast counterpart to the targeted `signaler` example, and it stores only its differences from the composed template:

- It overrides one template file (`agent.py`) with an agent that, during bidding, bids nil when its hand qualifies (nothing queen-high or above, and at most three low spades) and otherwise bids an honest small count. Its `chat` hook broadcasts `nil! cover me` to the whole table the turn it bids nil, and watches for that same broadcast from its partner. During play, a partner who dared a nil is covered (it grabs the tricks it can win so the opponents cannot steer one onto the nil bidder), while otherwise it plays its lowest legal card, exactly as the template does.
- It adds tests (`tests/test_daredevil.py`) that assert it bids nil and broadcasts the exact warning on a qualifying hand, never bids nil on a strong one, and that its cover play **provably changes** when the partner's warning arrives versus when it does not.

This is the stage's demo hand: on seed `1236`, seat 0 bids nil, broadcasts the warning, and its partner's cover **saves** the nil: the team scores `+121` with messaging on, but the nil is set for `-76` with messaging off, because the partner never hears the dare. A broadcast is heard by the whole table, unlike a targeted partner signal. Everything is read through the provided `sandbox.cards` helpers, and every message is recorded and shown in replays.

Compose the runnable repository:

```console
uv run python scripts/compose.py spades daredevil
```

The result is written to `build/examples/spades/daredevil/`.
