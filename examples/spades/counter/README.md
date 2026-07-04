# Example: spades/counter

A Spades agent whose one idea is to bid honestly and then play to make that bid. The directory stores only its differences from the composed template:

- It overrides one template file (`agent.py`) with an agent that, during the bidding round, counts its likely tricks — the high spades (ace, king, queen) and the side-suit aces — and bids that number, never gambling on nil. During play it reads the team's combined contract and the tricks the partnership has already taken: while the team still needs tricks it wins the ones it can as cheaply as possible, and once the contract is safe it ducks with its lowest legal card to avoid taking bags it did not need.
- It adds tests (`tests/test_counter.py`) on top of the inherited template tests, asserting the agent plays a full game to completion against the built-in opponents and that the honest-bid heuristic counts high spades plus side aces on a fixed hand (and never bids nil on a thin one).

Counting the hand is the first thing a Spades player learns, so an honest bidder that plays to make its number is the clean baseline every fancier strategy is measured against. Everything is read through the provided `sandbox.cards` helpers, so the agent never decodes the combined `Discrete(66)` action space by hand.

Compose the runnable repository:

```console
uv run python scripts/compose.py spades counter
```

The result is written to `build/examples/spades/counter/`.
