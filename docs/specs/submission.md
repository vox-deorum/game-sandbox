# Submissions

Participants submit Python agents through GitHub. Every accepted submission is tied to a season, a verified user, and an exact commit.

## Agent interface

| Hook | Required? | Purpose |
| --- | --- | --- |
| `reset(seed)` | Yes | Prepare for a new episode and seed agent randomness. |
| `act(observation)` | Yes | Return an action in the environment's action space. |
| `learn(observation, action, reward, terminated)` | No | Update after a step. |
| `chat(inbox)` | No | Receive and send messages on the agent's turn. |

The interface is independent of algorithm style. Agents always run inside the server-side session container. They may also call the optional [LLM API](llm.md).

Learned state may persist across episodes in one leaderboard run, but not across submissions or seasons. Time spent in optional hooks and model calls counts toward the same limits as acting.

## Packaging

Every repository contains `manifest.json` at its root:

```json
{
  "entry_point": "agent",
  "class_name": "Agent",
  "template_version": 1
}
```

The manifest names the Python module, class, and template dependency version. The `template_version` shown above is illustrative; the authoritative value is whatever the current template release ships.

Dependencies are set by the template, not by individual submissions. Each template release pins exact package versions, and old versions remain available for reproducibility. Every agent in a season uses the same dependency version, so agents can share a session container without conflicts.

A participant who needs a missing library asks the operator for a new template release rather than adding a private dependency pin. This keeps local development, validation, and official runs on the same package set.

## Template repos and local development

Participants develop against PettingZoo on their own computers. The `vox-deorum/game-agent-template` repository provides:

- `main` for the default environment.
- `templates/<env>` for each additional environment.
- `examples/<env>/<name>` for complete worked agents.

Each starter kit includes:

- The required agent hooks and optional `chat` hook.
- The manifest.
- The global pinned dependency set for the current template release.
- Any wrapper needed for a single-agent game.
- Local play and evaluation scripts.
- A minimal LLM API example.

Local LLM credentials go in `.env`. The server replaces them with a temporary session-and-slot key. Participants do not need the Game Sandbox backend to write or test an agent.

Developers may enable a local-folder source to test the validation pipeline without GitHub. It is disabled in normal deployments and is not a participant feature.

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

If no branch, tag, or commit is supplied, the system pins the head of the default branch. Later pushes do not change the existing submission. Resubmitting resolves a new commit.

Each participant has one active submission per season. A later submission replaces the active one and preserves history. The signed-in GitHub identity is always the submitter identity.

If a deployment needs to pull from private repos, the operator provides a GitHub token at deploy time. Public repos do not need this.

## Validation

Validation never runs a game:

| Layer | Executes participant code? | Checks |
| --- | --- | --- |
| Static | No | Reachable commit, source size within the cap, exact manifest shape, existing entry-point module, supported template version that matches the season |
| Load | Yes, in a sandbox | Module imports, class exists, constructor succeeds, `reset` and `act` are callable |

Every failure has a specific owner-visible reason. A successful submission becomes a runnable overlay image. See [Execution](execution.md).

### Maximum submission size

The static layer caps the checked-out source size, measured without `.git`/VCS history (a submission is code, not repository history). The cap is a site default (`SUBMISSION_MAX_SIZE_MB`, 25 MB) that a season may override with `overrides.submission_max_size_mb`; the override, when set, takes precedence. An over-cap submission fails the static stage with an owner-visible reason naming the measured size and the limit.

## Snapshots and downloads

When a submission passes the size cap and the static checks, the server stores a compressed snapshot of its source tree (the same filtered tree the overlay is built from, excluding `.git`) under `<DATA_DIR>/submissions`. The snapshot is the durable source of truth:

- **Re-runs and rebuilds** materialize the overlay from the snapshot rather than re-cloning, so a re-run no longer breaks if the participant force-pushed or deleted the pinned commit. (A submission predating its snapshot falls back to re-cloning the pinned source.)
- **Operators** can download an individual submission's source, or a whole season as one `.tar.gz` containing each active participant's submission in its own folder plus a `submission.json` metadata file and a top-level `season.json` index. Both downloads are operator-gated under `/api/admin`.

On-disk snapshot storage is bounded by the size cap times the number of retained submissions.
