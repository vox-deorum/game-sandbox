# Web Frontend

The frontend is organized into a small number of clearly scoped pages and a shared identity layer.

## Pages

- **Home.** Lists environments as cards. Each card shows the display name, a short description, the number of agent slots, whether a human can play, and a thumbnail.
- **Environment page.** Shows the environment's description, the two leaderboards for the current iteration, links to historical iterations, recent replays, entry points into the play and watch flows, and the agent submission form (see below).
- **Agent profile.** One page per submitted agent. Linked to the participant's GitHub. Shows submission history across iterations, leaderboard placements, and recent replays. The agent's owner additionally gets a debug view with the agent's full LLM telemetry, prompts and completions included (see [llm.md](llm.md)).
- **Replay viewer.** Plays back a recorded run step by step, including chat messages and per-tick LLM call metadata (model, token counts, latency). Full prompts and completions stay owner-only (see [llm.md](llm.md)). Linkable by URL. See [recording.md](recording.md).
- **Live play.** Hosts an active session, which can be self-play, multi-agent, or human with agent.
- **Leaderboards.** Per environment, per iteration. The automated board and the human-feedback board sit side by side. See [leaderboard.md](leaderboard.md).

## Submitting an agent

The environment page carries a "Submit agent" form for the currently open iteration. The participant pastes their repository URL and the commit ref to pin. The frontend verifies that the repo and commit are reachable before accepting, and records the submission under the signed-in GitHub identity. The submission rules (one active submission per iteration, resubmitting replaces) live in [submission.md](submission.md).

## Flows

- **Watch self-play.** Pick an agent, run it against the environment or itself, stream the state to the renderer.
- **Watch multi-agent.** Pick agents for each slot in environments whose metadata allows more than one slot. This flow arrives together with the first multi-agent environment (see [environment.md](environment.md)).
- **Play with or against agents.** Available when the environment metadata exposes a human slot. The human controls one slot and agents fill the others. Feedback is collected at the end of the session.

## On-demand live play

Signed-in users on the deployment's allowlist can start a new live session whenever they want, one concurrent session per user. The allowlist is configured by the operator and is typically a class roster or a GitHub org. The session orchestrator launches one session container for the duration of the session (see [execution.md](execution.md)). Sessions are bounded by the environment's time limits and by a session-level idle timeout, so a forgotten browser tab does not hold resources forever.

## Feedback

Every session is recorded automatically (see [recording.md](recording.md)). At the end of a session, next to the feedback prompt, the user can pin the replay to keep it past the retention window.

After any session, watch or play, the user can rate each agent involved on a 1 to 5 scale. A user has one effective rating per agent per iteration; rating the same agent again overwrites the previous value. Ratings of the user's own agent are excluded. Ratings feed the per-environment, per-iteration human-feedback leaderboard (see [leaderboard.md](leaderboard.md)) and do not affect the automated leaderboard.

## Identity: GitHub OAuth

Web users sign in to the frontend with GitHub OAuth. Their GitHub identity is the same identity used everywhere else in the system:

- Feedback they leave is attributed to their GitHub username.
- Sessions they play are attributed to their GitHub username.
- Submissions they make (see [submission.md](submission.md)) are verified against the same OAuth session, so a participant can only submit under their own handle.

Because there is one identity path (GitHub OAuth) and one identifier (GitHub username), everything a person does on the site lines up under the same handle automatically.
