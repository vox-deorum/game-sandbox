# Live Session Health

Status: complete and current. The health badge ships on both live surfaces, and the socket keepalive behind it is in the relay.

## Goal

Tell a player why a live session's picture is standing still.

A stalled session and a dropped connection look identical on screen, and the two need different things from the person watching: one is worth waiting out, the other is worth reloading. Until now the page could not tell them apart. It showed `Reconnecting…` when the socket announced its own death, and a bare `Waiting…` spinner for a watch buffer that had run dry, with nothing at all for a live human session whose agents had simply gone quiet.

Days at Three Branches is where this hurts most. It is simultaneous, paces at 250 ms, and can run ten agent-driven villagers whose hooks execute one after another on the single harness thread. A tick that needs all ten can legitimately take seconds, `run_live_loop` never tries to catch up, and nothing reaches the browser until `episode.advance()` returns. The lag is by design. Being unable to explain it was not.

This feature explains the lag. It does not reduce it.

## Mechanism

Every state already carried the evidence and nothing read it. Each agent reports the time its hooks took (`timing.decision_ms`, plus `chat_ms` and `learn_ms` when those optional hooks ran) and the state as a whole reports `timing.duration_ms`, the wall clock for the step including the environment transition. Pairing those with the moment the frame actually reached the browser separates three causes that used to look the same. Silence uses the environment's actual `pace_interval_ms`, which is the session's work cadence and stays separate from any playback view cadence.

| What the numbers say | What it means | Badge |
| --- | --- | --- |
| Agent time is past the cadence, one player owning most of it | That villager is the problem | `P3 2.1s` |
| Agent time is past the cadence, spread across the cast | The agents as a group | `Agents 3.2s` |
| The step outran the hooks charged inside it | The server: the environment transition, or a blocking model call | `Server 1.4s` |
| Frames arrive far later than the work they describe | Delivery | `Link slow` |
| Nothing has arrived for a few seconds | Cannot attribute it yet | `No signal` |
| The socket reported a drop | The transport, which knows for certain | `Reconnecting…` |
| Everything within tolerance | Nothing worth saying | no badge |

The badge sits beside the existing status badge and appears only when something is wrong:

```text
+-----------------------------------------------------------------------+
| * Live   * P3 2.1s                   Score --  Ticks --  Started 14:02 |
|                                                    [ Pause ] [ Stop ] |
+-----------------------------------------------------------------------+
|                                                                       |
|                   (game stage, entirely unchanged)                    |
|                                                                       |
+-----------------------------------------------------------------------+
```

The takeaway is that one short badge carries the whole distinction. The dot colors it and the label states it, the stage is untouched, and a healthy session shows only `Live`.

Measurement rules:

- **Samples are taken at the transport boundary**, in the socket's `onState` before the watch jitter buffer and the live throttle. A watch run holds frames back on purpose, and sampling after that would read a deliberate delay as a carrier problem.
- **Samples are smoothed**, so one expensive tick among fast ones does not flap the badge on and off.
- **Each player's smoothing stays separate.** Smoothing never assigns one player's hook time to another player.
- **Silence is judged against measured work and the session's actual pace.** A village taking four seconds a tick is quiet for four seconds every tick, so a fixed threshold would flash `No signal` over the true answer once per tick. The allowance is twice the greater of the smoothed measured step duration and the environment's `pace_interval_ms`, with a three second floor. Playback view cadence does not change this allowance.
- **Unpaced human turns have no generic next-turn authority in the browser.** For an unpaced session containing human players, suppress silence and delivery warnings. Continue reporting measured agent and server work, and do not count time waiting for a human turn as server cost.
- **The tracker follows the session lifecycle.** Clear it on an automatic physical reconnect and on pause or the initial Start gate. Resume begins with a fresh measurement baseline.
- **Terminal envelopes end health immediately.** Once the transport receives the terminal envelope, stop health reporting even if buffered animation still has frames to play.
- **Chrome that already explains the stillness wins.** A paused, starting, awaiting-Start, or finished session shows no health badge, and the transport's own verdict outranks the timing one.

Agent time is chargeable time, so an official LLM session discounts verified proxy time from it. That is the right reading rather than a distortion: agents are expected to make their model calls asynchronously, so a well-behaved agent's hook time is real compute. An agent that blocks its hook on a synchronous model call is the one case the split cannot attribute, because the wait is discounted out of its charge while still sitting in the step. That is why the third row names the server rather than the environment: it is true whether the time went to the transition or to a blocking call.

### The socket keepalive

The transport half of the distinction needed a fix before it could be honest. There was no WebSocket ping anywhere in the stack, so a socket that died without a clean close (a sleeping laptop, a dropped VPN, a NAT timeout) never fired `close` and simply lingered.

That was a bug well beyond the badge. Releasing the human's controls and re-arming the idle timer both hang off `close`, so a vanished viewer kept the idle timer cleared and left the container believing the human still held the controls, draining their move budget until the wall-clock backstop fired. The relay now pings each attached socket every 15 seconds and ends one when an unanswered ping is detected at the next 15-second interval, which runs the ordinary detach path and lets the browser's own reconnect take over.

## Limitations

Per-payload timing explains a tick after it lands. During a long stall no payload arrives, so for that window the page reports silence and the previous tick's cost rather than live attribution. Unpaced sessions containing humans are the exception: without an authoritative next-turn indicator, they intentionally provide no silence or delivery diagnosis, and their server step cost excludes time spent waiting for a human. In paced sessions, recent ticks that each report seconds of agent time still make a slow-agent session visible. The measurements do not prove that a container is alive while it is quiet; only a heartbeat from the relay, which unlike the container is never blocked by a participant hook, could do that. Nothing here bounds a slow step either: `step_limit_ms` is still checked only after `act()` returns, and hard-interrupting a participant call would contradict the sequential-hook guarantee in [Execution](../docs/specs/execution.md).

## Files

- `frontend/src/lib/session-health.ts` holds the whole verdict, pure and free of Vue, with `frontend/test/session-health.test.ts` covering the wording and the discrimination.
- `frontend/src/composables/useSessionSocket.ts` samples each arrival and exposes `health`.
- `frontend/src/composables/useLiveFramePresentation.ts` composes the transport state and the measured verdict into one badge for both surfaces.
- `frontend/src/pages/SessionPage.vue` and `frontend/src/local/LocalPlayPage.vue` render it, each replacing its own inline reconnecting badge.
- `backend/src/session/routes.ts` holds `startKeepalive`, tested in `backend/test/session/keepalive.test.ts`.
- [Interaction](../docs/specs/interaction.md) states what a viewer is told, and [Execution](../docs/specs/execution.md) states that the relay pings its sockets.
