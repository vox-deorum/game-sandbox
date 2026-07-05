# Example: spades/signaler

A Spades agent whose one idea is a **partner signal**: it tells its partner which side suit it is strong in, and leads its partner's strong suit once it has been told. It is the messaging counterpart to the chat-less `counter` example, and it stores only its differences from the composed template:

- It overrides one template file (`agent.py`) with an agent that bids the same honest count as `counter` (high spades plus side aces, never nil), but adds a `chat` hook. On its turn the hook sends one **targeted** message to its partner, `strong:<suit>`, naming the non-spade suit it holds the ace of (longest suit as the tiebreak), and reads the same signal coming the other way. During play, when it has the lead and knows its partner's strong suit, it leads that suit; absent a signal it plays its lowest legal card, exactly as the template does.
- It adds tests (`tests/test_signaler.py`) that fix a deal and assert the exact message it sends, and that its lead **provably changes** when the partner's message arrives versus when it does not: the same agent, same observation, different play.

A targeted message to your partner is structurally different from a broadcast to the table, and Spades' seats-across partnership is what makes that distinction real. Everything is read through the provided `sandbox.cards` helpers, so the agent never decodes the combined `Discrete(66)` action space by hand. Your partner is the seat across, `player_((your_seat + 2) % 4)`; every message is recorded and shown in replays.

Compose the runnable repository:

```console
uv run python scripts/compose.py spades signaler
```

The result is written to `build/examples/spades/signaler/`.
