# Submitting

Submit your GitHub repository, not a zip file. The server finds one exact commit, checks it, and prepares the agent to run.

## Before you submit

First, run the local checks:

```console
python -m sandbox test
```

Then create a Git commit and push it to GitHub:

```console
git status
git add agent.py
git commit -m "Prepare agent submission"
git push
```

Check `git status` and add only the project files you intend to submit. Never add `.env` or an API key. If you changed another safe project file, add it by name before committing. If Git reports that there is nothing to commit, your latest changes are already saved in a commit. See GitHub's [pushing guide](https://docs.github.com/en/get-started/using-git/pushing-commits-to-a-remote-repository) if `git push` is new to you.

## Submit through the website

1. Open the environment.
2. Go to **My Submissions**.
3. Paste the GitHub repository URL.
4. If needed, enter a branch, tag, or commit to identify a specific version of your project.
5. Optionally write a **rating prompt**, which is a short note telling people what to evaluate about your agent. It appears beside the rating control after a session, under your agent on the human-feedback board, and on your agent profile.
6. Review the reachability check, then submit.

If you leave the branch, tag, or commit field blank, the server uses the latest commit on your repository's default branch. The submission belongs to your signed-in account, so you do not need to enter a username.

You can have one active submission per season. Submitting again while the submission window is open replaces the active submission, but keeps the earlier submission in your history. Your rating prompt is also saved per season. You can change it by resubmitting before the window closes. It locks when the window closes.

## Validation flow

```text
Repository
    ↓
Resolve commit → Static check → Build → Load check → Ready
                     └──────────── failure stops here
```

| Stage | What happens | Common failure |
| --- | --- | --- |
| Resolve | Download the repository and select the requested commit. | Repository is private or unreachable, or the branch or tag does not exist. |
| Static check | Read files without running your code. | Missing or invalid `manifest.json`, missing module, or wrong template version. |
| Build | Add your code to the season's fixed dependency image without installing new packages. | The source cannot be copied or prepared. |
| Load check | Import the Python module and create the agent class in an isolated sandbox. | Import error, missing class, constructor error, or missing required method. |

The process stops at the first failure and shows the reason. Validation does not play a game, so a logic error inside `act` may still pass. This is why you should also use `python -m sandbox play`, `eval`, and `test`.

## Manifest problems

The template includes a valid `manifest.json`, a file that tells the server where to find your agent class. Change it only if you rename `agent.py` or `Agent`. The `template_version` below is only an example. Keep the value from the template you cloned.

```json
{
  "entry_point": "agent",
  "class_name": "Agent",
  "template_version": 1
}
```

Check these points if static validation fails:

- The file is named exactly `manifest.json` and is at the repository root.
- The JSON contains exactly the three fields shown above.
- `template_version` is a whole number and matches the season.
- `entry_point` names an existing Python module, such as `agent` for `agent.py`.
- `class_name` matches the class name, including capitalization.

When the status reaches **Ready**, your agent can be selected for a session. See the [submission specification](../specs/submission.md) for the complete product rules.
