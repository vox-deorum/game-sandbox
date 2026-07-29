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

An **operator** is an authenticated user with `admin` status who manages seasons and runs. The specification uses **admin** when referring to the account status or roster administration.

## Pages

| Page | Main content |
| --- | --- |
| Environments | Cards with name, description, player count, human-play support, and thumbnail |
| Environment overview | Description, current boards, season history, play and watch entry points |
| Agent profile | Submission history, current submission state, placements, replays, rating prompts, and owner-only development access |
| Seasons | Public seasons, active gates, environment, optional description, release time, submission count, session count |
| My Agents | Signed-in user's current season submission state and recent submitted-season results across environments |
| Replays | Sortable environment recording list |
| Replay viewer | Renderer, transport, player attribution, chat, episode settings, public LLM summaries |
| Live session | Renderer, shared controls, decision log, result, pinning, ratings |
| Leaderboards | Automated and human-feedback boards for one environment and season |
| Manage | Operator-only season configuration, deletion of unused private seasons, workflow logs, preview, and release |
| Documentation | Student guides, rendered in-app with a section navigation |
| My Profile | Signed-in identity and capabilities |
| Users | Admin-only roster management, approval, bans, roles, and password resets |

The Documentation page renders shared guides from `docs/students/` and dynamically discovered game guides from `environments/<env>/environment.md`, with navigation between sections. Game guides keep the stable virtual `students/environments/<slug>.md` paths used by MkDocs and the frontend routes. It opens the student index by default. A deployment can use its own class home instead by setting `DOCS_INDEX_FILE` to a Markdown file. See [Configuration](../contributors/setup/configuration.md). Links to documentation outside the app, such as specifications or contributor guides, open the source on GitHub.

The environment overview may present three different seasons because the public gates are independent:

- Boards use the current released season.
- Watch and play use the current play-open season.
- My Submissions uses the current submission-open season.

While play is open, the overview names that season, shows its description and visible effective gameplay settings, and makes its play, watch, and rating choices available. A season with no visible setting says **No special settings.** When play is closed, the page says that no season is open for play. See [Leaderboards](leaderboard.md#seasons) for the gate rules.

An operator may set an optional **Season description** as display-only Markdown metadata. It is independent of run configuration and workflow execution and may be saved, replaced, or cleared at any time. The description becomes public when the season accepts submissions, is open for play, or is released. It remains hidden while all three gates are closed. Cross-game Seasons cards show the description only when it has content, with no placeholder when it is empty.

A Season description is one inline Markdown paragraph of at most 2,000 characters after line endings are normalized and surrounding whitespace is trimmed. Soft-wrapped lines are allowed, but a blank line that creates a second paragraph is rejected. The description supports emphasis, strong text, inline code, and absolute HTTP(S) links. Raw HTML, images, block Markdown, relative links, and other link schemes remain inactive. Links open in a new tab with safe external-link attributes.

Every builtin declared by the environment is available to watch under its display label. Ready submissions for the play-open season are the other choices.

The replay viewer shows the visible gameplay settings and seed used by the episode.

A player uses the short label `PN`, and a seat uses `SN`. Player and seat numbers are independent because one seat may cover several players.

Replays are public and read-only. Each replay belongs to an environment and names its season when it has one. Owners may pin their own recordings. A naturally completed multiplayer replay says `SN won` for one top-ranked seat and **Tied** for several. A replay without eligible ranking data keeps its termination label.

Result labels, replay summaries, and final standings rank seats rather than players. Each row leads with the seat's controller attribution and names its players as secondary detail. A repeated agent is named once. A mixed human seat names both the human and companion.

Rating surfaces use blind labels while a season's play window is open. Non-operators see numbered submitted agents without owner or source details in the watch list, live sessions, rating panels, replay lists, and replay viewers. A viewer may rate an eligible unrated agent, while an agent they already rated or own is offered as a watch choice. Operators continue to see identities.

This masking applies to play and feedback surfaces. Released leaderboards and agent profiles remain identified even when the same season is still open for play.

## Submitting an agent

The **My Submissions** tab shows the form when a season accepts submissions. The participant enters a repository URL, an optional branch, tag, or commit, and an optional **rating prompt**.

The frontend checks that the repository can be reached before submission. The backend pins the commit and attributes it to the signed-in user. The page shows every validation stage and details of any failure. If no submission window is open, the form is unavailable even when another season remains open for play.

My Submissions identifies the selected season and shows whether its active attempt is absent, validating, ready, or failed. Status is always matched within that season, so an attempt in another season cannot satisfy it.

The **My Agents** page groups the user's current and recent submission seasons by environment. It marks the current submission-open season with text as well as color, shows each active attempt and validation status, and exposes released results only. A released result includes a placement earned by any of the user's attempts in that season, including one later replaced. A failed validation still counts as an attempt. Unreleased placements remain hidden, while zero and negative scores remain valid displayed results.

When the current submission-open season has effective LLM access, My Agents and the owner's agent profile show development usage and key management. The owner can inspect call history for an eligible current season and for historical submission seasons. See [LLM API](llm.md#budgets-and-limits).

See [Submissions](submission.md).

## Watch and play flows

| Flow | Configuration |
| --- | --- |
| Rate | Intended agent in every unrestricted seat; a restricted seat offers only Human or its designated builtin when human-capable; all other settings are locked |
| Watch single-agent | Agent, gameplay parameters, seed, supported overrides |
| Watch multi-agent | One agent per resolved seat, gameplay parameters, seed, supported overrides |
| Play | Human-capable seat assignment, companion agent for a wide human seat, remaining agents, gameplay parameters, seed, human timeout, supported overrides |

Any named builtin or submitted agent opens the same seat-assignment flow. The selected agent is preselected in each unrestricted seat, every editable seat can be reassigned, and all required seats must be filled before a multi-agent session starts. Agent controls use stable builtin names as values and show their declared labels.

Selecting **Human** is allowed when the seat contains a human-capable player. The environment's declared member order chooses the first human-capable member for the person. A wide unrestricted human seat then reveals a required **Companion agent** control populated from the same named-builtin and ready-submission choices used by ordinary agent seats. One selected companion drives every remaining player through separate instances. The user must choose it explicitly before starting. A singleton human seat has no companion control.

A restricted seat accepts only Human or its designated builtin. Play and Rate default a human-capable restricted seat to Human. Watch always assigns its builtin. If the person chooses another seat during Play, the restricted seat returns to its builtin. A restricted seat with no human-capable player stays locked to the builtin. A wide restricted human seat explains that its designated builtin controls the other players and shows no companion picker. See [Environments](environment.md#players-and-seats).

The **Rate** action is the exception: the intended agent fills every unrestricted seat, and those assignments and all ordinary session settings are locked. A human-capable restricted seat keeps its Human-or-designated-builtin control enabled, and when it is set to Human the rating run becomes a session the viewer plays. The viewer rates the intended agent after the session. **Watch again** and ordinary watch actions keep each unrestricted assignment and ordinary setting editable.

Each seat row keeps its name and player count together in a two-line heading to the left of the assignment control. The player count uses singular or plural wording, and the assignment control's accessible name remains the seat name alone. The heading column has a fixed minimum width so controls align when player counts have different text widths, including on a narrow viewport.

Start forms render visible effective environment parameters, including the synthesized `players` or `seat_plan` parameter, with labelled controls appropriate to their types. A numeric parameter is hidden when its minimum equals its maximum, and a `choice` is hidden when it has one option. A non-empty `multi_choice` remains visible because choosing none differs from choosing its one declared option. Invalid values show a field error and prevent starting. Hidden parameters stay in the complete submitted map. A single-seat watch starts immediately when it has no visible configuration.

The season config editor lists every effective parameter, including the synthesized layout parameter and values hidden from players. Each value either inherits the environment default or supplies an override, so an empty string remains valid. The editor validates and canonicalizes values before saving and serializes only current effective parameter names.

Each matchup row keeps one selector per seat it holds. A selector offers `submission` plus every builtin declared by the environment, displayed by label and saved as `builtin:<name>`. A seat the resolved layout restricts is set to its designated builtin and disabled. Changing the seat plan or the player count conforms every row to the newly resolved layout: its width, and every restricted seat's designated builtin. A row saved under an earlier layout keeps its stored seats until the operator conforms it. The editor reports the resolved seat count and projected game count for the match design, or in their place one reason the design cannot run, which carries a "Match the layout" action whenever a row's width or restricted seats disagree with the resolved layout.

## On-demand live play

Signed-in users with `normal` or `admin` status may run one session at a time. Environment limits, a human timeout, an idle timeout, and a maximum chargeable duration bound each session. Idle timeout always follows wall-clock time. See [Execution](execution.md) and [LLM API](llm.md#determinism-and-timing).

## Feedback

Every session is recorded, and the owner may pin the replay.

A session can be rated only while its season's play window remains open. A user has one effective rating from 1 to 5 for each agent in each season. A later rating replaces the earlier one.

The interface prevents:

- Rating the user's own agent.
- Rating after play closes.
- Rating a pure built-in-only session.

A named builtin may be rated in a mixed session. Ratings affect only the human-feedback board.

The rating panel appears after the session ends. It may show the operator's season instructions and the author's instructions for an agent. Both guide the same score.

The author sets the prompt in the submission form. It is season metadata, not part of the pinned submission. The same author prompt also appears beneath the agent on the human-feedback board and once for each season in the agent profile's submission history.

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
