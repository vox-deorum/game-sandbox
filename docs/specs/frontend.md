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

An [**operator**](overview.md) is an authenticated user with `admin` status who manages seasons and runs. The specification uses **admin** when referring to the account status or roster administration. See [Identity and Access](identity.md) for accounts, statuses, and sign-in.

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

### Documentation

The Documentation page renders shared guides from `docs/students/` and dynamically discovered game guides from `environments/<env>/environment.md`, with navigation between sections. Game guides keep the stable virtual `students/environments/<slug>.md` paths used by MkDocs and the frontend routes. The page opens the student index by default, or a deployment's own class home when `DOCS_INDEX_FILE` is set. See [Configuration](../contributors/setup/configuration.md). Links to documentation outside the app, such as specifications or contributor guides, open the source on GitHub.

### Environment overview

The environment overview may present three different seasons because the public gates are independent:

- Boards use the current released season.
- Watch and play use the current play-open season.
- My Submissions uses the current submission-open season.

While play is open, the overview names that season, shows its description, and lists only the settings that differ from the environment defaults. The difference list covers visible gameplay parameters, decision and game limits, messaging availability and length when supported, and LLM API availability when supported. Each item shows the default and season value. When nothing differs, the overview says **This season uses the default settings.** The overview also makes the season's play, watch, and rating choices available. When play is closed, the page says that no season is open for play. See [Seasons](seasons.md#public-gates) for the gate rules.

Every builtin declared by the environment is available to watch under its display label. Ready submissions for the play-open season are the other choices.

### Season description

An operator may set an optional **Season description** as display-only Markdown metadata. It is independent of run configuration and workflow execution and may be saved, replaced, or cleared at any time. The description becomes public when the season accepts submissions, is open for play, or is released. It remains hidden while all three gates are closed. Cross-game Seasons cards show the description only when it has content, with no placeholder when it is empty.

A Season description is one inline Markdown paragraph of at most 2,000 characters after line endings are normalized and surrounding whitespace is trimmed. Soft-wrapped lines are allowed, but a blank line that creates a second paragraph is rejected. The description supports emphasis, strong text, inline code, and absolute HTTP(S) links. Raw HTML, images, block Markdown, relative links, and other link schemes remain inactive. Links open in a new tab with safe external-link attributes.

### Replays and results

The replay viewer shows the visible gameplay settings and seed used by the episode.

A player uses the short label `PN`, and a seat uses `SN`. See [Environments](environment.md#players-and-seats) for what each covers. Player and seat numbers are independent because one seat may cover several players.

Replays are public and read-only. Each replay belongs to an environment and names its season when it has one. Owners may pin their own recordings. A naturally completed multiplayer replay says `SN won` when a single seat is top-ranked and **Tied** when several seats share the top rank. A replay without eligible ranking data keeps its termination label.

Result labels, replay summaries, and final standings rank seats rather than players. Each row leads with the seat's controller attribution and names its players as secondary detail. A repeated agent is named once. A mixed human seat lists both the human and the companion.

### Rating visibility

Rating surfaces use blind labels while a season's play window is open. Non-operators see numbered submitted agents without owner or source details in the watch list, live sessions, rating panels, replay lists, and replay viewers. A viewer may rate an eligible unrated agent, while an agent they already rated or own is offered as a watch choice. Operators see identities.

This masking applies to play and feedback surfaces. Released leaderboards and agent profiles remain identified even when the same season is still open for play.

## Submitting an agent

The **My Submissions** tab shows the submission form when a season accepts submissions. The participant enters a repository URL, an optional branch, tag, or commit, and an optional **agent rating prompt**.

The frontend checks that the repository can be reached before submission. The backend pins the commit and attributes it to the signed-in user. The page shows every validation stage and details of any failure. If no submission window is open, the form is unavailable even when another season remains open for play.

My Submissions identifies the selected season and shows whether its active attempt is absent, validating, ready, or failed. Status is always matched within that season, so an attempt in another season cannot satisfy it.

For the submission-open season, My Submissions shows the same default-to-season difference list as the environment overview. **Set Up Locally** provides the season's template clone command and downloads `season.json` when the season has locally reproducible gameplay or time-limit changes. The setup dialog links to Getting Started and explains where to put the file. The action remains available when the season uses all defaults because the template link is still useful.

The **My Agents** page groups the user's current and recent submission seasons by environment. It marks the current submission-open season with text as well as color, shows each active attempt and validation status, and exposes released results only. A released result includes a placement earned by any of the user's attempts in that season, including one later replaced. A failed validation still counts as an attempt. Unreleased placements stay hidden, while zero and negative scores remain valid displayed results.

When the current submission-open season has effective LLM access, My Agents and the owner's agent profile show development usage and key management. The owner can inspect call history for an eligible current season and for historical submission seasons. See [LLM API](llm.md#budgets-and-limits).

See [Submissions](submission.md).

## Watch and play flows

| Flow | Configuration |
| --- | --- |
| Rate | Intended agent in every unrestricted seat; a human-capable restricted seat remains editable; all other settings are locked |
| Watch single-agent | Agent, gameplay parameters, seed, supported overrides |
| Watch multi-agent | One agent per resolved seat, gameplay parameters, seed, supported overrides |
| Play | Human-capable seat assignment, companion agent for a wide human seat, remaining agents, gameplay parameters, seed, human timeout, supported overrides |

Any named builtin or submitted agent opens the same seat-assignment flow. The chosen agent is preselected in each unrestricted seat, every editable seat can be reassigned, and all required seats must be filled before a multi-agent session starts. Agent controls use stable builtin names as values and show their declared labels.

Selecting **Human** is allowed when the seat contains a human-capable player; see [Interaction](interaction.md#human-play) for how the human player and companion instances are chosen. A wide unrestricted human seat reveals a required **Companion agent** control, populated from the same named-builtin and ready-submission choices used by ordinary agent seats. The user must choose the companion explicitly before starting. A singleton human seat has no companion control.

Play and Rate default a human-capable restricted seat to Human. Watch always assigns its builtin. If the user chooses another seat during Play, the restricted seat returns to its builtin. A restricted seat with no human-capable player stays locked to the builtin. A wide restricted human seat explains that its designated builtin controls the other players and shows no companion picker. See [Environments](environment.md#builtin-agents-and-restricted-seats) for the restricted-seat rule.

For **Rate**, a human-capable restricted seat set to Human turns the rating run into a session the viewer plays, and afterward the viewer rates the intended agent. **Watch again** and ordinary watch actions keep each unrestricted assignment and ordinary setting editable.

Each seat row's assignment control uses the seat name alone as its accessible name.

Start forms render visible effective environment parameters, including the synthesized `players` or `seat_plan` parameter, with labelled controls appropriate to their types. A numeric parameter is hidden when its minimum equals its maximum, and a `choice` is hidden when it has one option. A non-empty `multi_choice` remains visible because choosing none differs from choosing its one declared option. Invalid values show a field error and prevent starting. Hidden parameters stay in the complete submitted map. A single-seat watch starts immediately when it has no visible configuration.

### Manage

The season config editor lists every effective parameter, including the synthesized layout parameter and values hidden from players. Each value either inherits the environment default or supplies an override, so an empty string remains valid. The editor validates and canonicalizes values before saving, and it serializes only current effective parameter names.

The season text editor also accepts an optional absolute HTTP(S) template repository URL. A blank field uses the deployment's published template repository and the environment's `templates/<environment>` branch. Operators may correct this URL after runs or submissions exist.

Each matchup row keeps one selector per seat it holds. A selector offers `submission` plus every builtin declared by the environment, displayed by label and saved as `builtin:<name>`. A seat the resolved layout restricts is set to its designated builtin and disabled. Changing the seat plan or the player count conforms every row to the newly resolved layout, updating its width and every restricted seat's designated builtin. A row saved under an earlier layout keeps its stored seats until the operator conforms it. The editor reports the projected game count for the whole match design beside the resolved seat and roster sizes, and each match's heading shows that match's own share. When the design cannot be counted, the editor shows one reason in place of those counts. The editor flags a row that no longer matches the resolved layout and offers a one-step action to conform it.

## On-demand live play

Signed-in users with `normal` or `admin` status may run one session at a time. Environment limits, a human timeout, an idle timeout, and a maximum chargeable duration bound each session. Idle timeout always follows wall-clock time. See [Execution](execution.md) and [LLM API](llm.md#determinism-and-timing).

## Feedback

Every session is recorded, and the owner may pin the replay.

A session can be rated only while its season's play window remains open. A user has one effective rating from 1 to 5 for each agent in each season. A later rating replaces the earlier one.

The interface prevents:

- Rating the user's own agent.
- Rating after play closes.
- Rating a builtin-only session.

A named builtin may be rated in a mixed session. Ratings affect only the human-feedback board.

The rating panel appears after the session ends. It may show the **season rating prompt** set by the operator and the agent rating prompt set by the agent's author. Both guide the same score.

The author sets the agent rating prompt in the submission form. It is season metadata, not part of the pinned submission. The same prompt also appears beneath the agent on the human-feedback board and once for each season in the agent profile's submission history.
