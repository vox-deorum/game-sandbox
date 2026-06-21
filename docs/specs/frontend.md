# Web Frontend

The frontend is organized into a small number of clearly scoped pages and a shared identity layer.

## Navigation

Navigation is two tiers. A persistent, collapsible **left sidebar** carries the cross-environment sections: **Environments** (the home gallery), **Seasons** (the cross-environment competition view), **Documentation**, and **My Agents** (the signed-in user's agents across environments), with the account block (**My Profile**, and a log-out affordance once OAuth lands) at the bottom. Inside an environment, a **contextual tab strip** carries that environment's tasks: **Overview**, **Leaderboards**, **My Submissions**, and an operator-only **Manage** tab. My Submissions always targets the signed-in user's agent profile for that environment, which contains the submit and resubmit form. Historical released seasons remain reachable from the Leaderboards page. Operators also see unreleased seasons in that page's season table and can open them as clearly labelled private previews.

The site uses **Environment** and **Season** as its front-facing names, matching the `environment` and `season` entity names used throughout the API and the operator console.

## Pages

- **Home (Environments).** Lists environments as cards. Each card shows the display name, a short description, the number of agent slots, whether a human can play, and a thumbnail.
- **Environment page (Overview).** Shows the environment's description, the two leaderboards for the current released season, links to historical seasons, and entry points into the play and watch flows. The play and watch entry points target the current play-open season when one exists, which may be a different season from the submission target. The human entry point sits in the page header next to the title as **Play Yourself**. A labelled Playable badge identifies the play-open season and deep-links to the same play dialog for an allowlisted user when the environment supports human play. The watch list always offers the environment's built-in **Naive agent** pinned at the top, a baseline that behaves like a submitted agent, followed by the ready submissions for the selected playable season. Any Watch action opens the same watch configuration dialog with the chosen row preselected.
- **Agent profile.** One page per participant and environment, reached through the **My Submissions** tab for the signed-in user's own profile and through agent links for another participant. For the owner it carries the agent submission form (see below) and uses the heading **My Submissions**; another participant's page uses a possessive submissions heading. The page shows submission history across seasons, leaderboard placements, and recent replays. The agent's owner additionally gets a debug view with the agent's full LLM telemetry, prompts and completions included (see [llm.md](llm.md)).
- **Seasons, My Agents, Documentation, My Profile.** The cross-environment sidebar destinations. Seasons lists every public-facing season as its own row, meaning a season appears when submissions are open, play is open, or results are released. Open seasons lead the list. Each row shows the active gate tags, the environment thumbnail, the release time when applicable, the number of active participant submissions, and the number of completed public sessions attributed to the season. The tags link directly to My Submissions, Play, or that season's Leaderboards. The card itself follows lifecycle priority: released results go to that season's boards, otherwise a submission-open season goes to My Submissions, otherwise a play-open season goes to Play. My Agents indexes the signed-in user's submissions across environments; Documentation hosts the student guides (a placeholder for now); My Profile shows the signed-in identity and what it may do.
- **Replays.** A per-environment tab listing the environment's recordings as a sortable table: each row is one replay, with its id (linking to the viewer), a summary of who played, the owner, the season the producing session ran in, the run's outcome, and when it was created. Replays have no visibility model: the listing is open to everyone and read-only, scoped to the environment and ordered newest-first; a viewer's own pinned replay carries a "Pinned" badge. A replay belongs to the environment, not a season; the Season column surfaces the play-open (or submission) season the session competed in, the only place that play-open assignment is visible.
- **Replay viewer.** Plays back a recorded run step by step, including chat messages and per-tick LLM call metadata (model, token counts, latency). It states who played each slot, a human (annotated with the user) or the agent that ran (the Naive agent, or a submission owner's agent), read from the recording header's attribution. Full prompts and completions stay owner-only (see [llm.md](llm.md)). Linkable by URL. See [recording.md](recording.md).
- **Live play.** Hosts an active session, which can be self-play, multi-agent, or human with agent.
- **Leaderboards.** Per environment, per season. The automated board and the human-feedback board stack in one full-width column so each table has room for its data. See [leaderboard.md](leaderboard.md).
- **Operator admin console.** Visible only to operators (an allowlist in the deployment configuration, checked against the signed-in identity). The operator declares and configures a season and its match design, opens and closes its submission window, opens and closes its public play window, triggers and re-runs the automated workflow while watching the match containers' logs stream live, inspects the resulting boards privately, and releases the season so its boards appear on the environment page. This replaces the configuration-file-and-CLI model; see [leaderboard.md](leaderboard.md).

## Submitting an agent

The owner's agent profile (the **My Submissions** tab) carries a "Submit agent" form for the environment's currently open submission season. The participant pastes their repository URL, optionally with a branch, tag, or commit to target; the frontend verifies the repo and ref are reachable before accepting, and the backend pins the resolved commit (the default-branch head when no ref is given). The submission is recorded under the signed-in GitHub identity. If validation rejects the submission, the specific reason is shown back on the form and on the owner's agent profile. If no season is open for submissions, the form is unavailable even when another season remains open for play. The submission rules (one active submission per season, resubmitting replaces) and the validation layers live in [submission.md](submission.md).

## Flows

- **Watch self-play.** Pick an agent from the selected play-open season, confirm the configured seat assignment, set the random seed and any supported session overrides, then stream the state to the renderer. The built-in Naive agent is always available as the pinned first choice, so a watch run works before any agent is submitted.
- **Watch multi-agent.** Pick agents for each required slot in environments whose metadata allows more than one slot. The same watch configuration dialog is used for built-in and submitted agents, and all required seats must be assigned before a session can start. This flow arrives together with the first multi-agent environment (see [environment.md](environment.md)).
- **Play with or against agents.** Available when the environment metadata exposes human-capable slots. The initial flow can assign one connected human to one slot and fill the others with agents, but the session model should be slot-based so a later flow can assign multiple connected humans in the same session. Feedback is collected at the end of the session.

Live-session controls include slot assignment for human-capable environments and any session-level overrides, including the human-slot timeout described in [interaction.md](interaction.md). Watch-session controls include agent slot assignment, a seed, and the same supported session overrides. A renderer that has an active human timeout should show it as part of the play UI.

## On-demand live play

Signed-in users on the deployment's allowlist can start a new live session whenever they want, one concurrent session per user. The allowlist is configured by the operator and is typically a class roster or a GitHub org. The session orchestrator launches one session container for the duration of the session (see [execution.md](execution.md)). Sessions are bounded by the environment's time limits and by a session-level idle timeout, so a forgotten browser tab does not hold resources forever.

## Feedback

Every session is recorded automatically (see [recording.md](recording.md)). At the end of a session, next to the feedback prompt, the user can pin the replay to keep it past the retention window.

After any rateable session, watch or play, the user can rate each agent involved on a 1 to 5 scale. A session is rateable only when it is attached to a season that still has its play window open; old sessions from before season attribution, sessions for a closed play window, and operator-only dry runs are read-only. A user has one effective rating per agent per season; rating the same agent again overwrites the previous value while the play window is open. Ratings of the user's own agent are excluded. The built-in baseline has no author and can be rated when it appears alongside a submitted agent, but a pure baseline-only watch recording does not show a feedback panel. Ratings feed the per-environment, per-season human-feedback leaderboard (see [leaderboard.md](leaderboard.md)) and do not affect the automated leaderboard.

Each rating can be guided by up to two **rating prompts**, shown next to the agent at rating time: one the operator set on the season, and one the agent's own author set for their submission. Authors set their agent's prompt from their agent profile; the prompt is presentation metadata about what to evaluate and is not part of the pinned, validated submission. The prompts are context for the single rating, not extra scores.

## Identity: GitHub OAuth

Web users sign in to the frontend with GitHub OAuth. Their GitHub identity is the same identity used everywhere else in the system:

- Feedback they leave is attributed to their GitHub username.
- Sessions they play are attributed to their GitHub username.
- Submissions they make (see [submission.md](submission.md)) are verified against the same OAuth session, so a participant can only submit under their own handle.

Because there is one identity path (GitHub OAuth) and one identifier (GitHub username), everything a person does on the site lines up under the same handle automatically.
