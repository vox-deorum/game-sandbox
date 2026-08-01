# Submitting

Submit your GitHub repository, not a zip file. The server finds one exact commit, checks it, and prepares the agent to run.

## Before you submit

First, run the local checks:

```console
python -m sandbox test
```

Then commit and push your work as shown in [Getting started, step 6](getting-started.md#6-save-your-work-on-github). Add only the project files you intend to submit, never `.env` or an API key. If Git reports that there is nothing to commit, your latest changes are already saved in a commit.

Your repository must be public so the server can download it. Ask your instructor if you need to use a private repository.

## Submit through the website

1. Open the environment.
2. Go to **My Submissions**.
3. Check what the season changes. Use **Set Up Locally** if you need the template link or a `season.json` file that applies its gameplay parameters and decision and game limits on your computer. Messaging and LLM availability remain website and server settings.
4. Paste the GitHub repository URL.
5. If needed, enter a branch, tag, or commit to identify a specific version of your project.
6. Optionally write a **rating prompt**, a short note telling raters what to evaluate about your agent.
7. Review the reachability check, which confirms that the server can reach your repository, then submit.

If you leave the branch, tag, or commit field blank, the server uses the latest commit on your repository's default branch.

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
| Resolve | Download the repository and select the requested commit. | Repository is private or unreachable, or the branch or tag does not exist. |
| Static check | Read files without running your code. | Missing or invalid `manifest.json`, missing module, wrong template version, or a repository over the size limit. |
| Build | Add your code to the season's fixed set of packages without installing anything new. | Rare, and usually not caused by your files. Try again, and ask your instructor if it keeps happening. |
| Load check | Import the Python module and create the agent class in an isolated sandbox. | Import error, missing class, an error while creating the agent, or a missing required method. |

The process stops at the first failure and shows the reason. Validation does not play a game, so a logic error inside `act` can still pass. Use `python -m sandbox play`, `eval`, and `test` to catch that.

## Repository rules

Extra files are welcome. Your agent can bring more Python modules or a data file it loads, as long as the whole repository stays under the size limit: 25 MB by default, measured on your project files without the Git history. A season can change that limit, and when a repository is too large the static check reports both the measured size and the limit.

The server stores its own copy of your code as soon as your submission passes static validation, so changing or deleting your repository afterwards does not affect a submission that already got that far.

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

## Leaderboards and official games

**Ready** means the server can load your agent, not that it has played an official game yet (the schedule calls this a match).

A **season** is one competition round for one environment. It fixes the opponents or player layout, the game settings, repeated starting positions, time limits, and any enabled LLM limits, and these can differ from what you run on your own computer. The environment page shows what the play-open season changes from the environment defaults. My Submissions shows the submission-open season and offers **Set Up Locally** to apply its reproducible settings on your computer. See [Seasons](../specs/seasons.md) for the full season rules.

Here is what to know about the season's boards and official games:

- The **automated board** ranks the average official game score. Higher is always better on this board, even when the game's own score runs the other way. See [Leaderboards](../specs/leaderboard.md) for how runs are scored and how tied scores are broken.
- The **human-feedback board** ranks the average rating, 1 to 5, from people who watch or play games. You cannot rate your own agent, and an agent needs at least three ratings to be ranked. See [Leaderboards](../specs/leaderboard.md) for the full rating rules.
- Official games run on the server's schedule, and every one is recorded, so you can watch replays on the website.
- While the season runs, other participants see agents under neutral numbered labels, and your name appears once the season's results are released. See [Seasons](../specs/seasons.md) for the release rules.
- A leaderboard run uses the submissions that were active when it was created, so resubmitting does not change a run that has already started. See [Leaderboards](../specs/leaderboard.md) for how a run is built.

`python -m sandbox play` and `python -m sandbox eval` are useful local checks, but they cannot predict the official board. A downloaded `season.json` applies only to local episode commands. Official games always use the season stored by the server. A crash, an illegal action, or exhausting your game limit forfeits your assigned seat. See [Time limits](agent-interface.md#time-limits) for the full rule.
