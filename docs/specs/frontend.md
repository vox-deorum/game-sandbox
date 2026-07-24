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
| Agent profile | Submission history (with each Season's rating prompt), current Season submission state, status, placements, replays, and owner-only development access for the current submission-open season |
| Seasons | Public seasons, active gates, environment, optional description, release time, submission count, session count |
| My Agents | Signed-in user's current Season submission state and recent submitted-Season results across environments |
| Replays | Sortable environment recording list |
| Replay viewer | Renderer, transport, player attribution, chat, public LLM summaries |
| Live session | Renderer, shared controls, decision log, result, pinning, ratings |
| Leaderboards | Automated and human-feedback boards for one environment and season |
| Manage | Operator-only season configuration, deletion of unused private seasons, workflow logs, preview, and release |
| Documentation | Student guides, rendered in-app with a section navigation |
| My Profile | Signed-in identity and capabilities |
| Users | Admin-only roster management, approval, bans, roles, and password resets |

The Documentation page renders shared guides from `docs/students/` and dynamically discovered game guides from `environments/<env>/environment.md`, with navigation between sections. Game guides keep the stable virtual `students/environments/<slug>.md` paths used by MkDocs and the frontend routes. It opens the student index by default. A deployment can use its own class home instead by setting `DOCS_INDEX_FILE` to a Markdown file. See [Configuration](../contributors/setup/configuration.md). Links to documentation outside the app, such as specifications or contributor guides, open the source on GitHub.

The environment overview targets three potentially different seasons:

- Boards use the current released season.
- Watch and play use the current play-open season.
- My Submissions uses the current submission-open season.

An operator may set an optional **Season description** as display-only Markdown metadata. It is independent of run configuration and workflow execution and may be saved, replaced, or cleared at any time. The description becomes public when the season accepts submissions, is open for play, or is released. It remains hidden while all three gates are closed. Cross-game Seasons cards show the description only when it has content, with no placeholder when it is empty.

A Season description is one inline Markdown paragraph of at most 2,000 characters after line endings are normalized and surrounding whitespace is trimmed. Soft-wrapped lines are allowed, but a blank line that creates a second paragraph is rejected. The description supports emphasis, strong text, inline code, and absolute HTTP(S) links. Raw HTML, images, block Markdown, relative links, and other link schemes remain inactive. Links open in a new tab with safe external-link attributes.

The built-in **Naive agent** is always the first watch option. Ready submissions for the play-open season follow it.

Replays are public and read-only. Each replay belongs to an environment, and a season column shows the season associated with the session that produced it. The replay list shows only the final section of each recording identifier and lists the owner first. In a naturally completed multiplayer replay, one top-ranked player produces the label `player_N won`, while multiple top-ranked players produce `Tied`. A replay without eligible ranking data keeps its general termination label. Owners may pin their own recordings.

Human feedback is blind while a season's play window is open. In the watch list, non-operators see numbered submitted agents without owner profiles or source details. An unrated agent has a **Rate** action. An agent that the viewer has already rated, or that belongs to the viewer, has a **Watch again** action. Operators continue to see agent identities.

Until play closes, submitted agents remain anonymous to non-operators in live sessions, post-session rating panels, replay lists, and replay viewers. Released leaderboards and agent profiles continue to identify them.

## Submitting an agent

The **My Submissions** tab shows the form when a season accepts submissions. The participant enters a repository URL and optional branch, tag, or commit, plus an optional **rating prompt**.

The frontend checks that the repository can be reached before submission. The backend pins the commit and attributes it to the signed-in user. The page shows every validation stage and details of any failure. If no submission window is open, the form is unavailable even when another season remains open for play.

For the profile owner, My Submissions adds two tags to the plain **Submit an Agent** heading for the current submission-open Season. The tags show the Season label and whether the owner has submitted to it. An active attempt shows its validation status, including a failed validation. A Season with no active attempt shows **Not submitted**.

If no Season accepts submissions, the heading says so once and does not repeat the closed-window state beside the form. Submission status is matched within the current Season. An active attempt in another Season cannot make the current Season appear submitted.

The **My Agents** page groups this summary by environment in one flat list of compact Season rows. An environment appears when it has a submission-open Season or the user has submitted there before.

The current submission-open Season appears first. A distinct stripe marks the current Season visually, while a **Current season** label conveys the same meaning without color for assistive technology. The row shows **Not submitted** when there is no active attempt. Up to three of the most recent earlier Seasons that the user submitted to appear next. Their stripes reflect the status of the active attempt. Each submitted Season shows the active attempt's submission date and validation status. A failed attempt still counts as submitted.

When the current submission-open Season has effective LLM access, its row also shows a compact development usage meter. The meter presents weighted budget units used against the season limit as both a visual value and text. A key-management action sits above the row link.

The current Season shows a result only after results are released. A previous Season shows **Score N** when released automated results include a placement for any of the user's attempts in that Season, including an attempt later replaced by a new submission. A released Season without a placement shows **No score**. An unreleased previous Season shows **Results not released**, and never exposes an unreleased placement. Zero and negative values are displayed as scores.

Each Season row on My Agents is itself a link to that Season on My Submissions. The selected current Season focuses the current-Season summary even when it has no submission. A selected historical Season expands and focuses its submission history. Unknown Season identifiers do not change the page.

For the owner, an agent profile shows a **Development access** section above Submission History when the environment has a submission-open Season with effective LLM access. It lists allowed model aliases and their price multipliers, shows used and remaining weighted budget units, and provides actions to create or rotate a key and view call history. An expanded submission-history row provides read-only call history for its own Season. The section is absent when there is no eligible current Season.

See [Submissions](submission.md).

## Watch and play flows

| Flow | Configuration |
| --- | --- |
| Watch single-agent | Agent, seed, supported overrides |
| Watch multi-agent | One agent per required seat, seed, supported overrides |
| Play | Human-capable slot assignment, remaining agents, seed, human timeout, supported overrides |

Any agent row, whether built-in or submitted, opens the same seat-assignment view. The selected agent is preselected for its seat, and every seat can be reassigned before the session starts. All required seats must be assigned before a multi-agent session starts. The session model identifies every slot even when the first interface supports only one connected human.

## On-demand live play

Signed-in users with `normal` or `admin` status may run one session at a time. Environment limits, a human timeout, an idle timeout, and a wall-clock maximum duration bound each session. See [Execution](execution.md).

## Feedback

Every session is recorded, and the owner may pin the replay.

A session can be rated only while its season's play window remains open. A user has one effective rating from 1 to 5 for each agent in each season. A later rating replaces the earlier one.

The interface prevents:

- Rating the user's own agent.
- Rating after play closes.
- Rating a pure built-in-only session.

The built-in baseline may be rated in a mixed session. Ratings affect only the human-feedback board.

The rating panel appears only after the session ends, immediately above the game stage. It enters with a short downward reveal that uses the shared motion tokens. The rating view may show the operator's season instructions once and the author's instructions beside that agent. Both sets of instructions guide one score.

The author sets the prompt in the submission form. It is season metadata, not part of the pinned submission. The same author prompt also appears beneath the agent on the human-feedback board and once for each Season in the agent profile's submission history.

## Identity and access

Visitors may browse public environments, seasons, leaderboards, recordings, agent profiles, and documentation without signing in. When enabled for the deployment, GitHub OAuth provides one sign-in method. The other is an email and password for an account created by an admin. The site does not offer public email and password registration.

An email entered by an admin counts as verified. A GitHub sign-in with the same verified email links to that existing account instead of creating a duplicate.

A signed-in user may explicitly connect one GitHub account from My Profile, even when its verified email differs. The GitHub email then becomes the Game Sandbox account email, so later email and password sign-in uses the new address. The connection is refused if another user already owns that address. Disconnecting GitHub does not restore the previous email. A user cannot disconnect their only remaining sign-in method.

Users created through GitHub receive their GitHub display name and avatar. Connecting GitHub to an existing account preserves the current display name and avatar but records the GitHub username. My Profile and the account menu show the connected username, and an agent profile links its owner to GitHub. Leaderboards, recordings, and live-session payloads do not expose the username.

Every signed-in user has one status:

- A `pending` user may browse and inspect their own account data but may not start sessions, submit agents, or rate.
- A `normal` user may participate in those flows.
- An `admin` has the same participation access and may also use administration pages and APIs.

New GitHub users begin as `pending`. Accounts created by an admin begin as `normal` unless the admin chooses another status.

A ban is separate from status. Banning a user revokes their login sessions and prevents another sign-in until an admin removes the ban. Banning is the way to retire an account because deletion would leave its submissions, recordings, ratings, and placements without an owner. User deletion is therefore unavailable through both the interface and the API.

The Users page lets an admin list and search the roster, create an email and password account, approve a pending user, promote or demote an admin, ban or unban a user, and reset a password. The configured bootstrap admin has a stable system identity. Its email, display name, password, admin status, and ban state are restored from deployment configuration at startup.

The backend derives identity and authorization from the authenticated session, never from a user ID supplied in a request body, header, or query parameter. Public payloads show a user's display name wherever attribution appears. Opaque internal user IDs are available only when needed for links, ownership checks, and diagnostics.
