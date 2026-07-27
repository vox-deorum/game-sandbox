# Submissions

Participants submit Python agents through GitHub. Every accepted submission is tied to a season, a verified user, and an exact commit.

## Agent interface

| Hook | Required? | Purpose |
| --- | --- | --- |
| `reset(seed)` | Yes | Prepare for a new episode and seed agent randomness. |
| `act(observation)` | Yes | Return an action in the environment's action space. |
| `learn(observation, action, reward, terminated)` | No | Update after a step. |
| `chat(inbox)` | No | Receive and send messages on the agent's turn. |

`act` receives the environment's object-shaped observation and returns an integer from its flat `Discrete` action space. See the [environment contract](environment.md#observations-and-actions).

The interface is independent of algorithm style. Agents run inside the server-side session container and may call the optional [LLM API](llm.md).

Learned state may persist between episodes in one session, never across sessions, submissions, or seasons. Time spent in optional hooks counts toward the same limits as time spent acting. The [LLM API](llm.md#determinism-and-timing) defines how official-session LLM calls affect timing.

A submission is assigned by seat. [Environments](environment.md#players-and-seats) defines how a seat may cover several separately constructed agent instances.

## Packaging

Every repository contains `manifest.json` at its root:

```json
{
  "entry_point": "agent",
  "class_name": "Agent",
  "template_version": 1
}
```

The manifest names the Python module, class, and template dependency version. The current template release provides the authoritative `template_version`.

Dependencies are set by the template, not by individual submissions. Each template release pins exact package versions, and old versions remain available for reproducibility. Every agent in a season uses the same dependency version, so agents can share a session container without conflicts.

A participant who needs a missing library asks the operator for a new template release instead of pinning a private dependency. This keeps local development, validation, and official runs on the same package set.

## Templates and local development

Participants develop against PettingZoo on their own computers. Each environment's published template supplies the agent interface, manifest, pinned dependency set, local play and evaluation commands, and worked examples. The environment's student guide is the authority on using that template.

While submissions are open for an LLM-enabled season, an active participant may request a development key from the backend and place the returned credentials in `.env`. Development access ends when submissions close. Rotating a key invalidates the previous credential without resetting that participant's usage for the season. Development usage has its own meter for each season.

Official sessions supply their own temporary player credentials. Participants do not need the backend to write an agent or run it without model calls. See [LLM API](llm.md).

## Submission flow

```text
Repository URL + optional ref
             ↓
Resolve exact commit
             ↓
Attach signed-in user and open season
             ↓
Validate and build
```

If the participant supplies no branch, tag, or commit, the system pins the current head of the default branch. Later pushes do not change an existing submission. Resubmitting resolves and pins a new commit.

Each participant has one active submission per season. A later submission replaces the active one and preserves history. The signed-in account identity is always the submitter identity.

A deployment may accept private GitHub repositories when its operator configures a GitHub token. Public repositories need no deployment credential. A repository need not belong to the participant's linked GitHub account because forks, collaborators, and organization repositories are valid. The token's repository scope defines which private repositories the deployment accepts.

## Validation

Validation never runs a game:

| Layer | Executes participant code? | Checks |
| --- | --- | --- |
| Static | No | Reachable commit, source size within the cap, exact manifest shape, existing entry point module, supported template version that matches the season |
| Load | Yes, in a sandbox | Module imports, class exists, constructor succeeds, `reset` and `act` are callable |

Every failure has a specific owner-visible reason. A successful submission becomes a runnable overlay image. See [Execution](execution.md).

### Maximum submission size

The static layer caps the size of the checked-out source without `.git` or other version-control history. A submission contains code, not repository history. The site default is 25 MB, configured by `SUBMISSION_MAX_SIZE_MB`. A season may set `overrides.submission_max_size_mb`, which takes precedence when present. If a submission exceeds the cap, the static stage fails and tells the owner both the measured size and the limit.

## Snapshots and downloads

After a submission passes the size cap and static checks, the server stores a compressed snapshot of its source tree under `<DATA_DIR>/submissions`. This is the same filtered tree used to build the overlay and excludes `.git`. The snapshot becomes the durable source of truth:

- **Reruns and rebuilds** create the overlay from the snapshot instead of cloning the repository again. They therefore continue to work if the participant force-pushes or deletes the pinned commit.
- **Operators** can download one submission's source or an entire season. A season download is a `.tar.gz` archive with each active participant's submission in a separate folder, a `submission.json` metadata file in each folder, and a top-level `season.json` index. Both download routes are restricted to operators under `/api/admin`.

On-disk snapshot storage is bounded by the size cap times the number of retained submissions.
