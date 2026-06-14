# Submitting

When your agent is ready, you submit it by linking a **GitHub repository**, not by uploading files. The website pins your code to one exact commit, checks it, and — if it passes — builds it into an image you can watch play. Nothing about your code runs a game during this check; validation only confirms the repo is shaped right and the agent loads.

## Before you submit

Push your work to GitHub and run the inherited checks locally first — they mirror what the server checks:

```
pytest
```

A green `pytest` means your `manifest.json` names a loadable agent and your agent can drive the environment. Submitting code that fails locally just means the server rejects it a minute later with the same reason.

## How to submit

On the environment page, open the **Submit agent** form and paste your repository URL. You can optionally target a branch, tag, or commit; leave the ref blank to take the head of the default branch. The form verifies the repository and ref are reachable before it lets you submit, then the server resolves your choice to an exact commit and pins it. You never type a username — the submission is recorded under the account you are signed in as.

**One active submission per iteration.** Submitting again while the iteration is open replaces your active submission; your earlier submissions stay visible as history on your agent profile. The full rules are in the [submission spec](../specs/submission.md).

## What gets validated, in order

After you submit, the form shows a per-stage timeline. Each stage runs in turn and stops at the first failure, and the reason for that failure appears on the stage that rejected — on the form and on your [agent profile](../specs/frontend.md), so you can read it later:

1. **Resolve** — the server fetches your repo and pins the commit. Fails if the repository or ref cannot be reached, or a private repo needs credentials the deployment does not have.
2. **Static check** — the server reads your files without running any of your code. It checks `manifest.json` (see below).
3. **Build** — your code is overlaid onto the pinned dependency set for the iteration. No new dependencies are installed; everything comes from the template's versioned set.
4. **Load check** — the server imports your module and constructs your agent once, in a locked-down sandbox, with no game running. This is where a crash on import or a broken constructor is caught.

## The manifest

Every submittable repo has a `manifest.json` at its root. The template ships a correct one; you rarely touch it:

```json
{
  "entry_point": "agent",
  "class_name": "Agent",
  "template_version": 1
}
```

- `entry_point` — the module to import (`agent` means `agent.py`; a package works too).
- `class_name` — the agent class inside that module.
- `template_version` — the dependency-set version your repo targets. It must match the iteration's version, which is also the `requirements.txt` you installed locally.

## Why a submission is rejected

The static check rejects with a specific reason rather than a generic failure:

- **No `manifest.json`**, or it is not valid JSON.
- **A missing or wrong-typed field** — all three of `entry_point`, `class_name`, `template_version` are required, and `template_version` must be a whole number.
- **An unknown key** in the manifest — only the three fields above are allowed.
- **The entry point names no file** — `entry_point` must point at a module that exists in the repo.
- **An unknown or mismatched `template_version`** — the deployment must have that version, and it must match the iteration you are submitting to. If yours is behind, update to the current template release (ask the operator) and resubmit.

The load check rejects when your code is shaped right but does not load: the module **fails to import**, the manifest **names a class that does not exist**, the **constructor raises**, or the instance is **missing a required hook** (`reset` or `act`). The exact error is captured and shown to you. Because validation never steps the game, a logic bug inside `act` is not caught here — that is what your own `evaluate.py` runs are for (see [Getting Started](getting-started.md)).

Once a submission reaches **ready**, it is built and can be picked in the watch flow and run in a session.
