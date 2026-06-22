# Web Frontend

The frontend lets people discover environments, submit agents, watch or play sessions, inspect replays, rate agents, and manage seasons.

## Navigation

Navigation has two levels:

| Global sidebar | Environment tabs      |
| -------------- | --------------------- |
| Environments   | Overview              |
| Seasons        | Leaderboards          |
| Documentation  | Replays               |
| My Agents      | My Submissions        |
| My Profile     | Manage, for operators |

The site uses **Environment** and **Season** as its front-facing names, matching the `environment` and `season` entity names used throughout the API and the operator console.

## Pages

| Page | Main content |
| --- | --- |
| Environments | Cards with name, description, slot count, human-play support, and thumbnail |
| Environment overview | Description, current boards, season history, play and watch entry points |
| Agent profile | Submission history, status, placements, replays, author prompt, owner-only LLM debug data |
| Seasons | Public seasons, active gates, environment, release time, submission count, session count |
| My Agents | Signed-in user's submissions across environments |
| Replays | Sortable environment recording list |
| Replay viewer | Renderer, transport, player attribution, chat, public LLM summaries |
| Live session | Renderer, shared controls, decision log, result, pinning, ratings |
| Leaderboards | Automated and human-feedback boards for one environment and season |
| Manage | Operator-only season configuration, workflow logs, preview, and release |
| Documentation | Student guides |
| My Profile | Signed-in identity and capabilities |

The environment overview targets three potentially different seasons:

- Boards use the current released season.
- Watch and play use the current play-open season.
- My Submissions uses the current submission-open season.

The built-in **Naive agent** is always the first watch option. Ready submissions for the play-open season follow it.

Replays are public and read-only. They belong to an environment, while a season column records the season associated with the producing session. Owners may pin their own recordings.

Human feedback is blind while a season's play window is open. Non-operators see numbered submitted agents in the watch list, without owner profiles or source details. An unrated agent is presented as a **Rate** action; an agent the viewer already rated, or the viewer's own agent, is a **Watch again** action. Operators retain the identified view. Submitted-agent attribution stays anonymous for non-operators on the live session, post-session rating panel, replay list, and replay viewer until play closes. Released leaderboards and agent profiles remain identified.

## Submitting an agent

The **My Submissions** tab shows the form when a season accepts submissions. The participant enters a repository URL and optional branch, tag, or commit.

The frontend checks reachability before submission. The backend pins the commit and attributes it to the signed-in user. The page shows each validation stage and its failure detail. If no submission window is open, the form is unavailable even when another season remains open for play.

See [Submissions](submission.md).

## Watch and play flows

| Flow | Configuration |
| --- | --- |
| Watch single-agent | Agent, seed, supported overrides |
| Watch multi-agent | One agent per required seat, seed, supported overrides |
| Play | Human-capable slot assignment, remaining agents, seed, human timeout, supported overrides |

All required seats must be assigned before a multi-agent session starts. The session model identifies every slot even when the first interface supports only one connected human.

## On-demand live play

Signed-in allowlisted users may start one concurrent session. Environment limits, a human timeout, an idle timeout, and a wall-clock backstop bound the session. See [Execution](execution.md).

## Feedback

Every session is recorded, and the owner may pin the replay.

A rateable session must belong to a season whose play window is still open. A user can submit one effective 1 to 5 rating per agent per season, and a later rating replaces it.

The interface prevents:

- Rating the user's own agent.
- Rating after play closes.
- Rating a pure built-in-only session.

The built-in baseline may be rated in a mixed session. Ratings affect only the human-feedback board.

The rating panel appears only after the session ends, immediately above the game stage. It enters with a short downward reveal that uses the shared motion tokens. The rating view may show the operator's season instructions once and the agent author's instructions beside that agent. Both guide one score. The author's prompt is profile metadata, not part of the pinned submission.

## Identity: GitHub OAuth

Web users sign in with GitHub OAuth. One GitHub identity is used for:

- Submissions.
- Sessions and recordings.
- Ratings.
- Operator and session allowlists.

The backend derives identity from the authenticated session, never from a user ID supplied in a request body.
