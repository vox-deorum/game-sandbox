# Web Frontend

The frontend is organized into a small number of clearly scoped pages and a shared identity layer.

## Pages

- **Home.** Lists environments as cards. Each card shows the display name, a short description, the number of agent slots, whether a human can play, and a thumbnail.
- **Environment page.** Shows the environment's description, the two leaderboards for the current iteration, links to historical iterations, recent replays, and entry points into the play and watch flows.
- **Agent profile.** One page per submitted agent. Linked to the participant's GitHub. Shows submission history across iterations, leaderboard placements, and recent replays.
- **Replay viewer.** Plays back a recorded run step by step. Linkable by URL. See [recording.md](recording.md).
- **Live play.** Hosts an active session, which can be self-play, multi-agent, or human with agent.
- **Leaderboards.** Per environment, per iteration. The automated board and the human-feedback board sit side by side. See [leaderboard.md](leaderboard.md).

## Flows

- **Watch self-play.** Pick an agent, run it against the environment or itself, stream the state to the renderer.
- **Watch multi-agent.** Pick agents for each slot in environments whose metadata allows more than one slot.
- **Play with or against agents.** Available when the environment metadata exposes a human slot. The human controls one slot and agents fill the others. Feedback is collected at the end of the session.

## On-demand live play

Any signed-in user can start a new live session whenever they want. The session orchestrator allocates agent execution for each non-human slot for the duration of the session (see [execution.md](execution.md) for where each slot runs). Sessions are bounded by the environment's time limits and by a session-level idle timeout, so a forgotten browser tab does not hold resources forever.

## Feedback

After any session, watch or play, the user can rate the agents involved. Ratings feed the per-environment, per-iteration human-feedback leaderboard. They do not affect the automated leaderboard.

## Identity: GitHub OAuth

Web users sign in to the frontend with GitHub OAuth. Their GitHub identity is the same identity used everywhere else in the system:

- Feedback they leave is attributed to their GitHub username.
- Sessions they play are attributed to their GitHub username.
- Submissions they make (see [submission.md](submission.md)) are verified against the same OAuth session, so a participant can only submit under their own handle.

Because there is one identity path (GitHub OAuth) and one identifier (GitHub username), everything a person does on the site lines up under the same handle automatically.
