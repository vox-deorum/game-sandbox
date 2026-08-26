# Submitting

Submit your GitHub repository, not a zip file. The server finds one exact commit, checks it, and prepares the agent to run.

## Before you submit

First, run the local checks:

```console
python -m sandbox test
```

Then commit and push your work as shown in [Getting started, step 6](getting-started.md#6-save-your-work-on-github). Add only the project files you intend to submit, never `.env` or an API key. If Git reports that there is nothing to commit, your latest changes are already saved in a commit.

Normally, submit a public GitHub repository. You can use a private repository only with instructor and deployment support.

## Submit through the website

1. Open your repository on GitHub and copy its URL from the browser address bar.
2. Open your environment on the course website and go to **My Submissions**.
3. Review the season changes shown on the page (a **season** is one competition round for this environment). Use **Set Up Locally** if you need the template setup commands or a `season.json` file that applies its gameplay parameters and decision and game limits on your computer. Messaging and LLM availability remain website and server settings.
4. Paste the GitHub URL.
5. Optionally write a **rating prompt**, a short note telling raters what to evaluate about your agent.
6. Review the reachability check, which confirms that the server can reach your repository, then submit.

> _Need a different version?_ Enter a branch, tag, or commit. Normally leave these fields blank: the server then uses the latest commit on your repository's default branch.

The submission belongs to your signed-in account, so you do not need to enter a username.

You can have one active submission per season. Submitting again while the submission window is open replaces the active submission and keeps the earlier one in your history. Your rating prompt is also saved per season: change it by resubmitting before the window closes, after which it locks.

## Validation flow

```text
Repository
    ↓
Resolve commit → Static check → Build → Load check → Ready
                     └──────────── failure stops here
```

| Stage | What happens | Common failure |
| --- | --- | --- |
| Resolve | Download your repository and find the requested commit. | The repository is private or unreachable, or the branch or tag does not exist. |
| Static check | Check the project files without running your code. | `manifest.json` is missing or invalid, the module is missing, the template version is wrong, or the repository is over the size limit. |
| Build | Combine your code with the season's fixed packages. It cannot install new packages. | Usually temporary and not caused by your files. Try again, then ask your instructor if it continues. |
| Load check | Import your module and create the agent class in an isolated sandbox. | An import error, missing class or required method, or an error while creating the agent. |

The process stops at the first failure and shows the reason. Validation does not play a game, so a logic error inside `act` can still pass. Use `python -m sandbox watch`, `eval`, and `test` to catch that, and consider [writing your own tests](testing.md).

## Repository rules

Extra files are welcome. Your agent can include more Python modules or data files it loads, as long as the counted project files stay under the size limit: 25 MB by default. Source and data files count. `.git`, `.venv`, `node_modules`, `build`, `dist`, caches, and compiled Python bytecode do not. A season can change the limit. If a repository is too large, the static check reports its measured size and the limit.

The server stores its own copy of your code as soon as your submission passes static validation. Changing or deleting your repository afterward does not affect that submission.

## Manifest problems

The template includes a valid `manifest.json`, the file that tells the server where to find your agent class. Change it only if you rename `agent.py` or `Agent`. The `template_version` below is only an example, so keep the value from the template you cloned.

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

If the Load check fails with a missing class, make sure `class_name` in your manifest matches your class's name exactly, including capitalization. Static validation only confirms that `class_name` is a non-empty string, and the Load check is what looks for a class with that exact name in your module.

## Leaderboards and official matches

**Ready** means the server can load your agent, not that it has played an official match yet. A **match** is one scheduled, recorded episode.

A **season** is one competition round for one environment. It fixes opponents or player layout, game settings, repeated starting positions, time limits, and enabled LLM limits. The environment page shows play-open changes, and **My Submissions** shows the submission-open season and its reproducible local settings. See [Seasons](../specs/seasons.md) for the full rules.

Here is what to know about the season's boards and official matches:

- The **automated board** ranks the average official match score. Higher is always better on this board. See [Leaderboards](../specs/leaderboard.md) for how runs are scored and how tied scores are broken.
- The **human-feedback board** ranks the average rating, 1 to 5, from people who watch or play games, plus a written feedback. See [Leaderboards](../specs/leaderboard.md) for the full rating rules.
- Official matches run on the server's schedule, and you can watch their replays on the website.
- While the season's play window is open, watch, play, and rating surfaces show anonymized agents under neutral numbered labels. See [Frontend](../specs/frontend.md) for the exact rule.

`python -m sandbox watch` and `python -m sandbox eval` are useful local checks, but they cannot predict the official board. A downloaded `season.json` applies only to local episode commands. The server always uses its stored season. A crash, an illegal action, or exhausting your game limit forfeits your assigned seat. See [Time limits](agent-interface.md#time-limits) for the full rule.
