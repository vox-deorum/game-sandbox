# Web Frontend

The frontend lets people discover environments, submit agents, watch or play sessions, inspect replays, rate agents, and manage seasons.

## Navigation

Navigation has two levels:

| Global sidebar    | Environment tabs      |
| ----------------- | --------------------- |
| Environments      | Overview              |
| Seasons           | Leaderboards          |
| Documentation     | Replays               |
| My Agents         | My Submissions        |
| My Profile        | Manage, for operators |
| Users, for admins |                       |

The site uses **Environment** and **Season** as its front-facing names, matching the `environment` and `season` entity names used throughout the API and the operator console.

## Pages

| Page | Main content |
| --- | --- |
| Environments | Cards with name, description, slot count, human-play support, and thumbnail |
| Environment overview | Description, current boards, season history, play and watch entry points |
| Agent profile | Submission history (with each Season's rating prompt), current Season submission state, status, placements, replays, owner-only LLM debug data |
| Seasons | Public seasons, active gates, environment, release time, submission count, session count |
| My Agents | Signed-in user's current Season submission state and recent submitted-Season results across environments |
| Replays | Sortable environment recording list |
| Replay viewer | Renderer, transport, player attribution, chat, public LLM summaries |
| Live session | Renderer, shared controls, decision log, result, pinning, ratings |
| Leaderboards | Automated and human-feedback boards for one environment and season |
| Manage | Operator-only season configuration, workflow logs, preview, and release |
| Documentation | Student guides, rendered in-app with a section navigation |
| My Profile | Signed-in identity and capabilities |
| Users | Admin-only roster management, approval, bans, roles, and password resets |

The Documentation page renders the student guides from `docs/students/` inside the app, with a section navigation over the guides. Its landing is the students index by default, and a deployment can replace that landing with its own class home by pointing `DOCS_INDEX_FILE` at a markdown file (see [Configuration](../contributors/configuration.md)). Links to documentation the site does not serve, such as the specification or contributor guides, open their source on GitHub.

The environment overview targets three potentially different seasons:

- Boards use the current released season.
- Watch and play use the current play-open season.
- My Submissions uses the current submission-open season.

The built-in **Naive agent** is always the first watch option. Ready submissions for the play-open season follow it.

Replays are public and read-only. They belong to an environment, while a season column records the season associated with the producing session. Owners may pin their own recordings.

Human feedback is blind while a season's play window is open. Non-operators see numbered submitted agents in the watch list, without owner profiles or source details. An unrated agent is presented as a **Rate** action; an agent the viewer already rated, or the viewer's own agent, is a **Watch again** action. Operators retain the identified view. Submitted-agent attribution stays anonymous for non-operators on the live session, post-session rating panel, replay list, and replay viewer until play closes. Released leaderboards and agent profiles remain identified.

## Submitting an agent

The **My Submissions** tab shows the form when a season accepts submissions. The participant enters a repository URL and optional branch, tag, or commit, plus an optional **rating prompt**.

The frontend checks reachability before submission. The backend pins the commit and attributes it to the signed-in user. The page shows each validation stage and its failure detail. If no submission window is open, the form is unavailable even when another season remains open for play.

For the profile owner, My Submissions leads with the current submission-open Season and whether the owner has submitted to it. An active attempt shows its submission date and validation status, including a failed validation. A Season with no active attempt says **Not submitted yet**. If no Season accepts submissions, the page says so once and does not repeat the closed-window state beside the form. Submission status is matched within the current Season, so an active attempt in another Season cannot make the current Season appear submitted.

The **My Agents** page groups this summary by environment. An environment appears when it has a submission-open Season or the user has submission history there. The current submission-open Season appears first, including **Not submitted** when there is no active attempt, followed by at most the three most recent earlier Seasons the user submitted to. Each submitted Season shows the active attempt's submission date and validation status. A failed attempt still counts as submitted.

Previous Seasons show **Score N** when released automated results include a placement for any of the user's attempts in that Season, including an attempt later superseded by a resubmission. A released Season without a placement says **No score**. An unreleased Season says **Results not released**, and an unreleased placement is never exposed. Zero and negative scores are displayed as scores.

Each Season block on My Agents is itself a link to that Season on My Submissions. The selected current Season focuses the current-Season summary even when it has no submission. A selected historical Season expands and focuses its submission history. Unknown Season identifiers do not change the page.

See [Submissions](submission.md).

## Watch and play flows

| Flow | Configuration |
| --- | --- |
| Watch single-agent | Agent, seed, supported overrides |
| Watch multi-agent | One agent per required seat, seed, supported overrides |
| Play | Human-capable slot assignment, remaining agents, seed, human timeout, supported overrides |

Any agent row, built-in or submitted, opens the same seat-assignment view with the clicked agent preselected for its seat and every seat reassignable before starting. All required seats must be assigned before a multi-agent session starts. The session model identifies every slot even when the first interface supports only one connected human.

## On-demand live play

Signed-in users with `normal` or `admin` status may start one concurrent session. Environment limits, a human timeout, an idle timeout, and a wall-clock backstop bound the session. See [Execution](execution.md).

## Feedback

Every session is recorded, and the owner may pin the replay.

A rateable session must belong to a season whose play window is still open. A user can submit one effective 1 to 5 rating per agent per season, and a later rating replaces it.

The interface prevents:

- Rating the user's own agent.
- Rating after play closes.
- Rating a pure built-in-only session.

The built-in baseline may be rated in a mixed session. Ratings affect only the human-feedback board.

The rating panel appears only after the session ends, immediately above the game stage. It enters with a short downward reveal that uses the shared motion tokens. The rating view may show the operator's season instructions once and the agent author's instructions beside that agent. Both guide one score. The author sets the prompt in the submit form; it is season metadata, not part of the pinned submission. The same author prompt is also surfaced beneath each agent on the human-feedback board and once per season in the agent profile's submission history.

## Identity and access

Visitors may browse public environments, seasons, leaderboards, recordings, agent profiles, and documentation without signing in. A user signs in through GitHub OAuth when the deployment enables it, or with an email and password for an account created by an admin. Public email and password registration does not exist.

Every signed-in user has one status. A `pending` user may browse and inspect their own account data but may not start sessions, submit agents, or rate. A `normal` user may participate in those flows. An `admin` has the same participation access and may also use the administration pages and APIs. New GitHub users begin as `pending`; admin-created accounts begin as `normal` unless the admin explicitly chooses another status.

A ban is separate from status. Banning a user revokes their login sessions and prevents another sign-in until an admin unbans them. Ban is the retirement path because deleting a user would orphan the submissions, recordings, ratings, and placements attributed to that identity, so user deletion is not available through either the interface or the API.

The Users page lets an admin list and search the roster, create an email and password account, approve a pending user, promote or demote an admin, ban or unban a user, and reset a password. The configured bootstrap admin is a stable system identity whose email, display name, password, admin status, and ban state are restored from deployment configuration at startup.

The backend derives identity and authorization from the authenticated session, never from a user ID supplied in a request body, header, or query parameter. Public payloads show a user's display name wherever attribution is presented; opaque internal user IDs remain available only where needed for links, ownership checks, and diagnostics.
