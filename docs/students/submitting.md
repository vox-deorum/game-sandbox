# Submitting

Submit your GitHub repository, not a zip file. The server finds one exact commit, checks it, and prepares the agent to run.

## Before you submit

First, run the local checks:

```console
python -m sandbox test
```

Then commit and push your work as shown in [Getting started, step 6](getting-started.md#6-save-your-work-on-github). Add only the project files you intend to submit, never `.env` or an API key. If Git reports that there is nothing to commit, your latest changes are already saved in a commit.

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

## After Ready

**Ready** means the server can load your agent. It does not mean that the agent has played an official game yet.

A **season** is one competition round for one environment. Its settings choose the opponents or player layout, game settings, repeated starting positions, time limits, and any enabled LLM limits. Those settings can differ from your local computer.

The season has two separate boards:

- The **automated board** ranks the average official game score. Higher is always better on this board, even when the game's own score uses the opposite direction.
- The **human-feedback board** ranks the average rating from people who watch or play games. It is separate from the automated score, and an agent needs at least three ratings before it is ranked.

`python -m sandbox play` and `python -m sandbox eval` are useful local checks, but they cannot predict the official board because they use a local setup. In an official game, a crash, illegal action, or exhausted total-computation limit forfeits your assigned seat. A single late `act` call instead uses a legal default action and the game continues.

When two automated scores are exactly equal, average computation time per decision breaks the tie. It does not change the score itself.
