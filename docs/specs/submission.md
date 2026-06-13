# Submissions

## Agent interface

Agents are written in Python. A participant implements a small documented interface:

- `reset(seed)` prepares the agent for a new episode. The seed comes from the harness, so repeated runs are controlled (see [leaderboard.md](leaderboard.md)).
- `act(observation)` returns an action in the environment's action space.
- `learn(observation, action, reward, terminated)` is optional. The harness calls it after each step with that step's transition, so reinforcement learning agents can keep updating during play.
- `chat(inbox)` is optional too. The harness calls it on the agent's turn with the messages addressed to that slot, and the agent returns messages to send or nothing to stay silent. See [communication.md](communication.md).

The same interface works whether the agent is a hand-written tree search, a trained neural network, or a hybrid of both, and agents always run server-side inside the session's Docker container regardless of style (see [execution.md](execution.md)). Agents may also call a provided OpenAI-compatible LLM API; see [llm.md](llm.md).

Learned state may persist across episodes within one leaderboard run, but never across submissions or iterations. Time spent in `learn` and `chat` counts against the same per-step and per-episode time limits as acting, so an agent that learns or talks heavily pays for it in the efficiency column rather than stalling the run.

## Packaging

So the workflow can build and run any submitted repo, each repo carries a small manifest at its root. The manifest names the entry-point module, the agent class, and the version of the template dependency set the repo targets. The template repos include a filled-in example.

Dependencies are not chosen per repo. The template carries the authoritative dependency set, and the set is versioned: each template release pins exact versions of everything an agent may import, and old set versions stay available, so a submission from years ago can be rebuilt exactly as it ran. A participant who needs a library the set lacks asks the operator for a new template release rather than pinning it in their own repo. Because every agent in an iteration runs on the same set version (see [leaderboard.md](leaderboard.md)), agents sharing a session container can never have conflicting dependencies (see [execution.md](execution.md)).

## Template repos and local development

Before submitting, a participant can develop and test their agent against vanilla PettingZoo on their own machine. We ship a single template repository (`vox-deorum/game-agent-template`) whose branches carry the per-environment starter kits — `main` is the default environment, `templates/<env>` each other environment, and `examples/<env>/<name>` complete worked agents — each including the agent interface stubs (the optional `chat` hook included), the manifest, the pinned dependency set for the current template release (one global set shared by all environments), the environment wrappers needed for single-agent games, a local play script, a simple evaluation harness, and a minimal LLM API example. For LLM use during local development, the template instructs participants to put the class-provided key in a `.env` file; server-side, the harness swaps it for a one-off key scoped to the session and acting slot (see [llm.md](llm.md)). The goal is that an agent can be written, run end to end, and iterated on without touching our backend at all.

For developers of the sandbox itself, a submission may also come from a **local folder** on the server rather than a git URL. A local-folder submission is not pinned to a commit and is gated off in normal deployments; it exists so the validation and build pipeline can be exercised end to end — against the worked example, additional agents, and intentionally malformed repos — without going through GitHub.

## Submission flow

Submission happens through the website. For each iteration (see [leaderboard.md](leaderboard.md)), a participant submits their GitHub repository link through the form on the environment page (see [frontend.md](frontend.md)). GitHub Classroom is not required; the same flow serves any kind of competition (see [overview.md](overview.md)).

A submission is a tuple of three things:

- The repository URL, pinned to a specific commit. The participant supplies the URL alone, or optionally a branch, tag, or commit; the system resolves it to an exact commit SHA at submission time and pins that. The default is the head of the repository's default branch. Later pushes do not silently change the submission for that iteration, and resubmitting re-resolves to the current commit.
- The GitHub username of the submitter, used as their identity throughout the system. See [frontend.md](frontend.md).
- The iteration the submission is for.

Each participant has one active submission per iteration. Submitting again while the iteration is open replaces the previous submission.

The submitter's GitHub identity is verified through the same OAuth login used by the rest of the website, so a participant cannot submit a repo under someone else's name.

If a deployment needs to pull from private repos, the operator provides a GitHub token at deploy time. Public repos do not need this.

## Validation

Every submission is validated before it can run, and never by running a game session. Validation has two layers, and either can reject the submission with a specific reason shown to the owner:

- **Static checks** read the submitted tree without executing any participant code: the repository must be reachable and (for git submissions) the ref must resolve to a commit; `manifest.json` must be present at the root, be valid JSON, and carry exactly the required fields with the right types (see [Packaging](#packaging)); the entry-point module file named by the manifest must exist; and the manifest's `template_version` must target a dependency-set version the deployment has a base image for.
- **A sandboxed load check** then confirms the agent actually loads: inside a locked-down container with no environment stepping, the entry-point module is imported, the named class is instantiated, and it is confirmed to expose the callable `reset` and `act` hooks. This runs the agent's import and constructor once but never starts an episode.

A submission that passes both is accepted and built into a session image (see [execution.md](execution.md)). A submission that fails either layer is stored and reported to its owner rather than run.
