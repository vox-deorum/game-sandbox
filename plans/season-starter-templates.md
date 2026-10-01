# Season starter templates

Status: complete.

A season names the starter code its students clone with a template repository URL and an optional branch. This lets a season start students from a published worked example, such as `examples/skirmish_crane/banner`, instead of the environment template. The [Seasons spec](../docs/specs/seasons.md#per-season-configuration) defines the behavior and the [frontend spec](../docs/specs/frontend.md#manage) defines the admin controls.

## How a season resolves its starter

| Stored URL | Stored branch | Students clone |
| --- | --- | --- |
| blank | blank | deployment repository, `templates/<env>` |
| blank | set | deployment repository, that branch |
| the deployment repository | blank | deployment repository, `templates/<env>` |
| another repository | blank | that repository, default branch |
| any | set | that repository, that branch |

A stored URL counts as the deployment repository when it matches `TEMPLATE_REPO_URL` after trailing slashes are removed, so `https://github.com/org/repo` and `https://github.com/org/repo/` resolve the same way.

`backend/src/environments/routes.ts` serves the result as `template_repo` in the season settings. The frontend's setup dialog already renders `git clone -b <branch> --single-branch` or a plain clone, so students see no new UI.

## What it touched

- **Storage.** `seasons.template_repo_branch` is a nullable text column. `seasons.template_repo_operator_owned` is a 0 or 1 flag that the admin save sets, and it stays off the wire. Migration `0003_season_template_branch` adds both to deployed version 2 databases and marks every season with a saved URL as operator-owned. `0002` is frozen, and `CURRENT_SCHEMA_VERSION` is 3.
- **Admin API.** `PUT /api/admin/seasons/:id/template-repository` takes `{ template_repo_url, template_repo_branch }`, both nullable and trimmed. `isSafeTemplateBranch` accepts only a conservative subset of Git branch names, because the branch appears in a shell command students copy. A bad branch returns 400 `invalid_template_repo_branch`.
- **Admin console.** The season editor shows a **Template branch** field beside **Template repository**, saved by the same button.
- **Preset defaults.** `EnvPreset.example` names a published example. Generation rejects one missing from `PUBLISHED_EXAMPLES`. The season seed turns it into `examples/<env>/<name>` when it creates a template season. It refreshes the branch while the seed still owns the row and no operator has saved the template repository. Any save counts, including a blank URL with a hand-picked branch.
- **Seeded defaults.** Skirmish at Crane Reach `season_4` through `season_6` start from `banner`. Days at Three Branches `season_5` and `season_6` start from `neighbor`, whose README now frames it as the Season 5 starting point.

## Limits

- The backend does not check that a typed branch exists. A typo surfaces when a student clones. Preset defaults are checked at generation time.
- The seed stamps defaults only in unconfigured environments, so an existing deployment with operator seasons sets the branch by hand.
- Retiring an example from `PUBLISHED_EXAMPLES` deletes its branch at the next publish, which breaks setup for any season still pointing at it.
