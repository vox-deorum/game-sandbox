# Implementation Plans

The [specification](../docs/specs/index.md) defines the system. This folder tracks how it is built.

- [skirmish-crane/](skirmish-crane/README.md) holds active work: the Skirmish at Crane Reach specification and its staged implementation plan.
- [days-at-three-branches/](days-at-three-branches/README.md) holds active work: the Days at Three Branches design and its staged implementation plan.
- [fullscreen.md](fullscreen.md) is the completed, current feature: full-screen presentation for every renderer on the shared stage.
- [branding.md](branding.md) is the completed, current deployment-branding feature: the bundled Game Sandbox icon and third-party overrides.
- [guest-accounts.md](guest-accounts.md) is the completed, current feature: guest accounts and anonymous name masking.
- [admin-log-viewer.md](admin-log-viewer.md) is the completed, current feature: the admin current-process structured log viewer.
- [live-session-health.md](live-session-health.md) is the completed, current feature: the live badge that says whether a still picture is a slow agent or a slow link, and the socket keepalive behind it.
- [season-starter-templates.md](season-starter-templates.md) is the completed, current feature: a season's starter template as a repository plus an optional branch, with preset defaults for published examples.
- [player-identity.md](player-identity.md) is the completed, current feature: the player profiles (in-game names and teams) a renderer reports to the host chrome, the sender colors and recipient badges the chat reads from them, and the view-only highlight behind every compact player id.
- [replay-ratings.md](replay-ratings.md) is the completed, current feature: rating agents from a replay while a season's play window is open, the Leaderboards page section order, and per-seat scores in the Matchups table.
- [torch-support.md](torch-support.md) is the implemented feature, pending GPU verification on the cloud deployment: PyTorch in the session base image, per-season CPU, memory, and GPU resources, GPU leasing, and the Skirmish at Crane Reach imitation example.
- [archived/](archived/README.md) holds the completed platform stages (1 through 19) and the conventions they followed.

Except for archived/, the plan is a living description of the current intended build path. Read the relevant specification and stage file before implementation, update the stage status when work starts and finishes, and revise the stage file in the same change when an implementation choice, interface, scope, or stage boundary changes. A pull request that changes planned behavior without touching the corresponding stage file is incomplete.
