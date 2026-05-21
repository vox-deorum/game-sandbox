# Submissions

## Agent interface

Participants implement an agent that satisfies a small documented interface:

- A `reset` step that prepares the agent for a new episode.
- An `act(observation)` step that returns an action.
- An optional `learn` hook for reinforcement learning agents that update during play.

The same interface works whether the agent is a hand-written tree search, a trained neural network, or a hybrid of both. Where an agent runs at session time is decided by the routing rule in [execution.md](execution.md), not by the interface.

## Template repos and local development

Before submitting, a participant can develop and test their agent against vanilla PettingZoo on their own machine. We ship template repositories that include the agent interface stubs, the Shimmy wrappers needed for single-agent games, a local play script, and a simple evaluation harness. The goal is that an agent can be written, run end to end, and iterated on without touching our backend at all.

## Submission flow

Submission is by GitHub repository link. For each iteration (see [leaderboard.md](leaderboard.md)), a participant sends the link to the repo that contains their agent. There is no requirement to use GitHub Classroom. The same flow works for a class that uses Classroom, for a class that just collects repo links, and for a workshop or open competition that has no class behind it at all.

A submission is a tuple of three things:

- The GitHub repository URL, pinned to a specific commit ref. Later pushes do not silently change the submission for that iteration.
- The GitHub username of the submitter, used as their identity throughout the system. See [frontend.md](frontend.md).
- The iteration the submission is for.

The submitter's GitHub identity is verified through the same OAuth login used by the rest of the website, so a participant cannot submit a repo under someone else's name.

If a deployment needs to pull from private repos, the operator provides a GitHub token at deploy time. Public repos do not need this.
