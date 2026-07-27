# Getting Started

This guide contains basic instructions for writing a game agent in Python and testing it on your own computer.

## Before you begin

Install:

- [Python 3.12](https://www.python.org/downloads/)
- [Git](https://docs.github.com/en/get-started/git-basics/set-up-git)
- A code editor, such as [Visual Studio Code](https://code.visualstudio.com/)

> _What's Git or GitHub?_ Git records changes to a project. GitHub stores a copy of that project online. A project tracked by Git is called a **repository**, often shortened to **repo**. Want to know more? Check out GitHub's [Hello World guide](https://docs.github.com/en/get-started/start-your-journey/hello-world).

> _What's Python?_ Python is the language you will use to describe your agent's decisions. It is widely used in machine learning today. Python's [official tutorial](https://docs.python.org/3/tutorial/) introduces the language from the beginning. Its sections on numbers, lists, dictionaries, functions, and classes are especially useful here.

## 1. Copy the template to your computer

Your assignment will have a link to a GitHub repository with the agent template. To **clone** a repository means to copy it to your computer.

Use Visual Studio Code "Start => Clone Git Repository..." for an interactive experience, or use command line:

```console
git clone <your-repository-url>
cd <your-repository-name>
```

See GitHub's [cloning guide](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository) if you need help finding the URL.

## 2. Set up the project and play

From the repository folder, run:

```console
python -m sandbox
```

The first run automatically creates a **virtual environment**, which keeps this project's Python packages separate from other projects. It then installs the exact package versions required by the template and opens the game in your browser. Select **Start** when you are ready. Your [environment page](environments/index.md) explains the controls. In Flappy Bird, for example, press **Space**, the **up arrow**, or **W** to flap.

After the first run installs the packages, the game runs only on your computer and does not need the website or an internet connection.

### Manual Installation

If automatic setup fails, follow Python's [virtual environment guide](https://docs.python.org/3/tutorial/venv.html) to create and activate `.venv`. With that environment active, install the template's packages:

```console
python -m pip install -r requirements.txt -r requirements-dev.txt
```

When a virtual environment is active, your terminal usually shows `(.venv)` at the start of the prompt. The requirements files list the exact package versions used by the template and its tests. Do not edit `requirements.txt` or install different versions in the project. Ask your instructor if you need a package that is not included.

## 3. Improve your agent

Open `agent.py`, which already contains a small working agent. Your job is to improve the agent. It has two required methods:

- `reset(seed)` prepares the agent for a new game.
- `act(observation)` reads the current game state and returns an action. A `TODO(you)` comment marks the line for you to change.

Each game gives its action numbers and observation fields different meanings. For example, for Flappy Bird, the observation describes the bird and nearby pipes in screen pixels.

Your [environment page](environments/index.md) explains the starting agent line by line and documents every value.

## 4. Play and evaluate

```console
python -m sandbox                     # play it yourself in a browser
python -m sandbox human               # the same as the command above
python -m sandbox play                # watch your agent in a browser
python -m sandbox play --headless     # run one game without a browser
python -m sandbox play --vs rivals/v1 # play against a saved copy of your agent
python -m sandbox eval --episodes 10  # run ten repeatable headless games
```

`python -m sandbox play` runs the game with every player as an instance of your agent. In contrast, `python -m sandbox` and `python -m sandbox human` let you control the selected player in a browser.

`python -m sandbox play --headless` runs one game without a browser. It runs your agent for the selected player and uses a legal default choice for every other player. `eval` repeats that same headless setup over several **episodes**, which are complete games, each starting from a repeatable condition called a **seed**. It plays a few (5 by default) episodes and reports the average score. Note that these results are not the same as the official leaderboard result, where your agent may play against different opponents or settings.

When a game has more than one player, `--vs` fills the players outside your seat with a different agent, so you can play, watch, or score your current agent against another agent. For example, if you want to compare with your previous agent, save the older version by copying `agent.py`, `manifest.json`, and other source files into a folder such as `rivals/v1`, then pass `--vs rivals/v1` to `play`, `human`, or `eval`. An absolute path to another copy of the project also works. In a team game, your own teammates keep your current agent.

> _Why save a rival?_ The default opponents never change, so two decent versions of your agent can score alike against them. Playing one version directly against the other shows which one is stronger.

Use `--player N` to select a player by number when a game has more than one; the commands control player `0` unless you choose another. `python -m sandbox setup` prepares the virtual environment without starting a game.

Two options help when you want to study one specific game: `play --seed N` repeats the same starting condition and random generator every time, and adding `--help` to any command lists all of its options.

## 5. Run the checks

```console
python -m sandbox test
```

The tests confirm that `manifest.json`, the small file that names your agent class, points to an agent that Python can load, and that the agent can run the environment. Keep them passing as you edit `agent.py`, and use any failure message to find the problem.

## 6. Save your work on GitHub

A **commit** is a named snapshot of your repository. Create a commit, then **push** it to send the commit to GitHub:

```console
git status
git add agent.py
git commit -m "Improve my agent"
git push
```

`git status` shows what changed. `git add` selects changes for the commit, `git commit` creates it, and `git push` sends it to GitHub. Check `git status` before adding files. Never add `.env` or an API key. GitHub's [About Git guide](https://docs.github.com/en/get-started/using-git/about-git) explains these commands in more detail.

## 7. Submit

Submit your repository URL through the course website. The server records one exact commit, so later edits do not change an existing submission. See [Submitting](submitting.md) for the validation process and common errors.

## Optional: use the LLM API

If your environment allows language model calls, follow [Using the LLM API](llm.md) to create a development key, save it in `.env`, and test it. Never commit `.env` or an API key to GitHub.
