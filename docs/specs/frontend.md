# Web Frontend

The frontend is organized into a small number of clearly scoped pages and a shared identity layer.

## Pages

- **Home.** Lists environments as cards. Each card shows the display name, a short description, the number of agent slots, whether a human can play, and a thumbnail.
- **Environment page.** Shows the environment's description, the two leaderboards for the current iteration, links to historical iterations, recent replays, entry points into the play and watch flows, and the agent submission form (see below). The human entry point sits in the page header next to the title as **Play Yourself**. The watch list always offers the environment's built-in **Naive agent** pinned at the top, a baseline that behaves like a submitted agent, followed by the ready submissions. Any Watch action opens the same watch configuration dialog with the chosen row preselected.
- **Agent profile.** One page per submitted agent. Linked to the participant's GitHub. Shows submission history across iterations, leaderboard placements, and recent replays. The agent's owner additionally gets a debug view with the agent's full LLM telemetry, prompts and completions included (see [llm.md](llm.md)).
- **Replay viewer.** Plays back a recorded run step by step, including chat messages and per-tick LLM call metadata (model, token counts, latency). It states who played each slot, a human (annotated with the user) or the agent that ran (the Naive agent, or a submission owner's agent), read from the recording header's attribution. Full prompts and completions stay owner-only (see [llm.md](llm.md)). Linkable by URL. See [recording.md](recording.md).
- **Live play.** Hosts an active session, which can be self-play, multi-agent, or human with agent.
- **Leaderboards.** Per environment, per iteration. The automated board and the human-feedback board sit side by side. See [leaderboard.md](leaderboard.md).
- **Operator admin console.** Visible only to operators (an allowlist in the deployment configuration, checked against the signed-in identity). The operator declares and configures an iteration and its match design, opens and closes its submission window, triggers and re-runs the automated workflow while watching the match containers' logs stream live, inspects the resulting boards privately, and publishes the iteration so its boards appear on the environment page. This replaces the configuration-file-and-CLI model; see [leaderboard.md](leaderboard.md).

## Submitting an agent

The environment page carries a "Submit agent" form for the currently open iteration. The participant pastes their repository URL, optionally with a branch, tag, or commit to target; the frontend verifies the repo and ref are reachable before accepting, and the backend pins the resolved commit (the default-branch head when no ref is given). The submission is recorded under the signed-in GitHub identity. If validation rejects the submission, the specific reason is shown back on the form and on the owner's agent profile. The submission rules (one active submission per iteration, resubmitting replaces) and the validation layers live in [submission.md](submission.md).

## Flows

- **Watch self-play.** Pick an agent, confirm the configured seat assignment, set the random seed and any supported session overrides, then stream the state to the renderer. The built-in Naive agent is always available as the pinned first choice, so a watch run works before any agent is submitted.
- **Watch multi-agent.** Pick agents for each required slot in environments whose metadata allows more than one slot. The same watch configuration dialog is used for built-in and submitted agents, and all required seats must be assigned before a session can start. This flow arrives together with the first multi-agent environment (see [environment.md](environment.md)).
- **Play with or against agents.** Available when the environment metadata exposes human-capable slots. The initial flow can assign one connected human to one slot and fill the others with agents, but the session model should be slot-based so a later flow can assign multiple connected humans in the same session. Feedback is collected at the end of the session.

Live-session controls include slot assignment for human-capable environments and any session-level overrides, including the human-slot timeout described in [interaction.md](interaction.md). Watch-session controls include agent slot assignment, a seed, and the same supported session overrides. A renderer that has an active human timeout should show it as part of the play UI.

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
