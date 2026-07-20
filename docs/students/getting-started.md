# Getting Started

You write a Game Sandbox agent in Python and test it on your own computer with the environment and PettingZoo tools included in the template. You do not need to run the Game Sandbox website or backend.

## Before you begin

Install:

- [Python 3.12](https://www.python.org/downloads/)
- [Git](https://docs.github.com/en/get-started/git-basics/set-up-git)
- A code editor, such as [Visual Studio Code](https://code.visualstudio.com/)

Git tracks changes to a project. GitHub stores a copy of that project online. A Git project is called a **repository**, often shortened to **repo**. If these ideas are new, GitHub's [Hello World guide](https://docs.github.com/en/get-started/start-your-journey/hello-world) is a friendly introduction.

## 1. Copy the template to your computer

Your instructor will give you a GitHub repository created from the agent template. Copy, or **clone**, it to your computer:

```console
git clone <your-repository-url>
cd <your-repository-name>
```

Replace the angle-bracket placeholders with the URL and folder name your instructor provides. See GitHub's [cloning guide](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository) if you need help finding the URL.

## 2. Set up and play with one command

From the repository folder, run:

```console
python -m sandbox
```

The first time, this creates a local virtual environment, installs the pinned packages, and opens the game for you to play yourself (press **space** or the **up arrow** to flap). There is no separate install step, and you can re-run it any time. The other commands in this guide (`python -m sandbox play`, `eval`, `test`) work the same way.

Prefer to manage the virtual environment yourself? A **virtual environment** keeps this project's Python packages separate from packages used by other projects. Create one inside the repository.

On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt -r requirements-dev.txt
```

On macOS or Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt -r requirements-dev.txt
```

When the environment is active, your terminal usually shows `(.venv)` at the start of the prompt. Python's [virtual environment guide](https://docs.python.org/3/tutorial/venv.html) explains why this isolation is useful.

The two requirements files list the exact package versions used by the template and its tests. Do not edit `requirements.txt` or install a different version into the project. If you need a package that is not included, ask your instructor.

## 3. Improve your agent

Open `agent.py`. It already contains a small working agent, so the game runs before you change anything; your job is to make it play better. The two required methods are:

- `reset(seed)`, which prepares the agent for a new game.
- `act(observation)`, which looks at the current state and returns an action. A `TODO(you)` comment marks the line where you take over.

For Flappy Bird, the observation is an object describing the bird and nearby pipes in real screen pixels, and an action is `0` for do nothing or `1` for flap. For Hearts and Spades, the observation carries your hand and the table as card objects `{"suit", "rank"}` beside a legal-move mask, and an action is the integer for the card (or bid) you chose.

The meaning of each action number and each observation field is specific to your game. Your [environment page](environments/index.md) walks through that starting agent line by line, then documents each action and observation field in full, along with a `sandbox` helper module (`sandbox.features` for Flappy Bird, `sandbox.cards` for Hearts and Spades) that reads the observation for you so you work with named values and card objects instead of raw arrays.

See [Agent interface](agent-interface.md) for the complete method contract and a small example.

## 4. Play and evaluate

```console
python -m sandbox play
python -m sandbox play --headless
python -m sandbox eval --episodes 10
python -m sandbox            # play it yourself
```

`play` runs one visible game with your agent. `--headless` runs without opening a game window. `eval` runs several seeded games and reports the mean score, which is more useful than judging an agent from one lucky run. With no command, `python -m sandbox` lets you play the game yourself.

## 5. Run the checks

```console
python -m sandbox test
```

The template tests confirm that the manifest points to a loadable agent and that the agent can drive the environment. They pass on the fresh template because it ships a working starting agent, so keep them passing as you change `agent.py`, and use the test output to find any problems you introduce.

## 6. Save your work on GitHub

A **commit** is a named snapshot of your repository. Create one and push it to GitHub:

```console
git status
git add agent.py
git commit -m "Implement Flappy Bird agent"
git push
```

`git status` shows what changed, `git add` selects changes for the snapshot, `git commit` creates it, and `git push` sends your commits to GitHub. Review `git status` before adding files, and never add `.env` or an API key. GitHub's [About Git guide](https://docs.github.com/en/get-started/using-git/about-git) explains these commands in more detail.

## 7. Submit

Submit the repository URL through the course website. The server records one exact commit, so later edits do not silently change an existing submission. See [Submitting](submitting.md) for the validation process and common errors.

## Optional: use the LLM API

If your environment allows model calls, follow [Using the LLM API](llm.md) to create a season development key, add the returned endpoint and key to `.env`, and run `python -m sandbox llm` for the default `small` tier. To test another tier, run `python -m sandbox llm medium`. Your agent sends the same literal `small`, `medium`, or `large` tier in local development and official sessions. Never commit `.env` or an API key to GitHub.
