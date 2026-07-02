# Submitting

You submit a GitHub repository, not a zip file. The server resolves the repository to one exact commit, validates it, and prepares it to run.

## Before you submit

Run the local checks:

```console
pytest
```

Then save and push your current work:

```console
git status
git add agent.py
git commit -m "Prepare agent submission"
git push
```

Review `git status` and add only the project files you intend to submit. Never add `.env` or an API key. If you changed another safe project file, add it by name before committing. If Git says there is nothing to commit, your latest changes are already in a commit. If `git push` is new to you, see GitHub's [pushing guide](https://docs.github.com/en/get-started/using-git/pushing-commits-to-a-remote-repository).

## Submit through the website

1. Open the environment.
2. Go to **My Submissions**.
3. Paste the GitHub repository URL.
4. Optionally enter a branch, tag, or commit.
5. Optionally write a **rating prompt**: a short note telling people what to evaluate about your agent. It appears next to the rating control after a session, beneath your agent on the human-feedback board, and on your agent profile.
6. Review the reachability check, then submit.

If you leave the branch, tag, or commit field blank, the server uses the latest commit on the repository's default branch. The submission is attached to your signed-in account, so you do not enter a username.

You can have one active submission in each season. Submitting again while the window is open replaces the active submission, but the earlier one remains in your history. Your rating prompt is saved per season; you can change it by resubmitting while the submission window stays open, after which it locks.

## Validation flow

```text
Repository
    ↓
Resolve commit → Static check → Build → Load check → Ready
                     └──────────── failure stops here
```

| Stage | What happens | Common failure |
| --- | --- | --- |
| Resolve | Fetch the repository and pin the requested commit. | Repository is private, unreachable, or the branch/tag does not exist. |
| Static check | Read files without running your code. | Missing or invalid `manifest.json`, missing module, or wrong template version. |
| Build | Place your code on the season's fixed dependency image without installing new packages. | The source cannot be copied or prepared. |
| Load check | Import the module and construct the class in a sandbox. | Import error, missing class, constructor error, or missing required method. |

The process stops at the first failed stage and shows its reason. Validation does not play a game. A logic bug inside `act` may pass validation, which is why `python -m sandbox play`, `eval`, and `test` matter.

## Manifest problems

The template includes a valid `manifest.json`. Change it only if you rename `agent.py` or `Agent`. The `template_version` below is illustrative; keep whatever value the template you cloned ships, since the template sets it rather than you.

```json
{
  "entry_point": "agent",
  "class_name": "Agent",
  "template_version": 1
}
```

Check these points if static validation fails:

- The file is named exactly `manifest.json` and is at the repository root.
- The JSON has exactly the three fields above.
- `template_version` is a whole number and matches the season.
- `entry_point` names an existing Python module.
- `class_name` matches the class name, including capitalization.

When the status reaches **Ready**, the agent can be selected for a session. The [submission specification](../specs/submission.md) contains the complete product rules.
