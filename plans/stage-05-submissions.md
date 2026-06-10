# Stage 5: Submissions

Status: not started

## Goal

Participants can submit agents through the website and watch them play. A submission is verified, stored, built into a session image, and runnable in the watch flow for the current single-agent environment. Environments with separate human and agent slots can use the same machinery for play-with-agent sessions later; the first Flappy Bird slice does not pretend there is an opponent slot.

## Scope

Implement submission storage and rules from [submission.md](../specs/submission.md): a submission is the repo URL pinned to a commit ref, the submitter's GitHub username, and the iteration. One active submission per participant per iteration; resubmission replaces. This stage creates or seeds a minimal current open iteration record so submissions have the right identity boundary and dependency-set version. Stage 6 replaces that placeholder workflow with the operator CLI, full configuration, open and close controls, and historical iteration views.

Build the "Submit agent" form on the environment page per [frontend.md](../specs/frontend.md): paste repo URL and commit ref, verify both are reachable before accepting (through the GitHub API, using the operator-provided token when one is configured for private repos), and record the submission under the signed-in identity.

Implement the build pipeline from [execution.md](../specs/execution.md): clone the pinned commit, read the manifest, and overlay the code into its per-slot directory on the base image for the dependency-set version the iteration pins. There is no per-submission dependency installation; dependencies come from the versioned template set (see [submission.md](../specs/submission.md)). A failed build (missing or malformed manifest, an entry point or class that does not load, a manifest targeting a dependency-set version with no base image) is stored and shown to the owner rather than run. Builds go through the Stage 3 execution driver, and caching is driver configuration; the default proposal is to build on first use and keep images until their submission is replaced.

Extend the session orchestrator so a session can name submissions for its non-human slots and run the corresponding image. Wire the watch self-play flow for Flappy Bird (pick an agent, run it in the single slot, stream to the renderer). Keep human Flappy Bird play as a human-controlled single-slot session; choosing submitted opponents for human-capable slots appears when an environment actually exposes both human and agent slots, with the first full multi-agent version in Stage 8.

Build the agent profile page: submission history across iterations, recent replays, and placeholders for leaderboard placements (Stage 6) and the LLM debug view (Stage 7).

## Spec references

[submission.md](../specs/submission.md), [frontend.md](../specs/frontend.md) (form, agent profile, flows), [execution.md](../specs/execution.md) (build pipeline, images).

## Depends on

Stage 3 (orchestrator, base image), Stage 4 (identity, environment page, flows).

## Done when

A signed-in participant submits the template repo pinned to a commit, sees it verified and accepted, and a second submission replaces the first for the current iteration. The backend builds the image, and a viewer runs the submitted agent in a Flappy Bird watch session. Human-controlled Flappy Bird sessions still work through the Stage 3 path. An unreachable commit is rejected at the form, and a repo whose manifest names a class that does not exist shows a build failure on the owner's profile instead of a session.
