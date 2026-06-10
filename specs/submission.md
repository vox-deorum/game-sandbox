# Submissions

## Agent interface

Agents are written in Python. A participant implements a small documented interface:

- `reset(seed)` prepares the agent for a new episode. The seed comes from the harness, so repeated runs are controlled (see [leaderboard.md](leaderboard.md)).
- `act(observation)` returns an action in the environment's action space.
- `learn(observation, action, reward, terminated)` is optional. The harness calls it after each step with that step's transition, so reinforcement learning agents can keep updating during play.

The same interface works whether the agent is a hand-written tree search, a trained neural network, or a hybrid of both, and agents always run server-side inside the session's Docker container regardless of style (see [execution.md](execution.md)).

Learned state may persist across episodes within one leaderboard run, but never across submissions or iterations. Time spent in `learn` counts against the same per-step and per-episode time limits as acting, so an agent that learns heavily pays for it in the efficiency column rather than stalling the run.

## Packaging

So the workflow can build and run any submitted repo, each repo carries a small manifest at its root. The manifest names the entry-point module and agent class and points to a requirements file for dependencies. The template repos include a filled-in example.

## Template repos and local development

Before submitting, a participant can develop and test their agent against vanilla PettingZoo on their own machine. We ship template repositories that include the agent interface stubs, the manifest, the Shimmy wrappers needed for single-agent games, a local play script, and a simple evaluation harness. The goal is that an agent can be written, run end to end, and iterated on without touching our backend at all.

## Submission flow

Submission happens through the website. For each iteration (see [leaderboard.md](leaderboard.md)), a participant submits their GitHub repository link through the form on the environment page (see [frontend.md](frontend.md)). GitHub Classroom is not required; the same flow serves any kind of competition (see [overview.md](overview.md)).

A submission is a tuple of three things:

- The GitHub repository URL, pinned to a specific commit ref. Later pushes do not silently change the submission for that iteration.
- The GitHub username of the submitter, used as their identity throughout the system. See [frontend.md](frontend.md).
- The iteration the submission is for.

Each participant has one active submission per iteration. Submitting again while the iteration is open replaces the previous submission.

The submitter's GitHub identity is verified through the same OAuth login used by the rest of the website, so a participant cannot submit a repo under someone else's name.

If a deployment needs to pull from private repos, the operator provides a GitHub token at deploy time. Public repos do not need this.
