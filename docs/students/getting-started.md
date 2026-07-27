# Getting Started

You will write a Game Sandbox agent in Python and test it on your own computer. The project template includes the game environment and the PettingZoo tools that run it. You do not need to run the Game Sandbox website or server.

## Before you begin

Install:

- [Python 3.12](https://www.python.org/downloads/)
- [Git](https://docs.github.com/en/get-started/git-basics/set-up-git)
- A code editor, such as [Visual Studio Code](https://code.visualstudio.com/)

Git records changes to a project. GitHub stores a copy of that project online. A project tracked by Git is called a **repository**, often shortened to **repo**. GitHub's [Hello World guide](https://docs.github.com/en/get-started/start-your-journey/hello-world) is a friendly introduction if these ideas are new.

Python is the language you will use to describe your agent's decisions. You can begin by changing the marked line in the working agent, then learn more as you need it. Python's [official tutorial](https://docs.python.org/3/tutorial/) introduces the language from the beginning. Its sections on numbers, lists, dictionaries, functions, and classes are especially useful here.

## 1. Copy the template to your computer

Your instructor will give you a GitHub repository created from the agent template. To **clone** a repository means to copy it to your computer. Clone yours with:

```console
git clone <your-repository-url>
cd <your-repository-name>
```

Replace both `<...>` placeholders with the URL and folder name from your instructor. See GitHub's [cloning guide](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository) if you need help finding the URL.

## 2. Set up the project and play

From the repository folder, run:

```console
python -m sandbox
```

The first run creates a **virtual environment**, which keeps this project's Python packages separate from other projects. It then installs the exact package versions required by the template and opens the game in your browser. Select **Start** when you are ready. Your [environment page](environments/index.md) explains the controls. In Flappy Bird, for example, press **Space**, the **up arrow**, or **W** to flap.

There is no separate installation step, and you can run the command again at any time. After the first run installs the packages, the game runs only on your computer and does not need the Game Sandbox website or an internet connection. The other commands in this guide, such as `python -m sandbox play`, `eval`, and `test`, set up the project in the same way.

Usually, you do not need to manage the virtual environment yourself. If automatic setup fails or your instructor asks you to create one manually, follow Python's [virtual environment guide](https://docs.python.org/3/tutorial/venv.html) to create and activate `.venv`. With that environment active, install the template's packages:

```console
python -m pip install -r requirements.txt -r requirements-dev.txt
```

When a virtual environment is active, your terminal usually shows `(.venv)` at the start of the prompt. The requirements files list the exact package versions used by the template and its tests. Do not edit `requirements.txt` or install different versions in the project. Ask your instructor if you need a package that is not included.

## 3. Improve your agent

Open `agent.py`. It contains a small working agent, so you can run the game before changing any code. Your job is to make that agent play better. It has two required methods:

- `reset(seed)` prepares the agent for a new game.
- `act(observation)` reads the current game state and returns an action. A `TODO(you)` comment marks the line for you to change.

For Flappy Bird, the observation describes the bird and nearby pipes in screen pixels. An action is `0` to do nothing or `1` to flap. For Hearts and Spades, the observation contains your hand and the cards on the table. A card looks like `{"suit": 2, "rank": 12}`. The template helpers list the choices that are allowed right now, so you can choose a card or bid without working with the game's internal action numbers.

Each game gives its action numbers and observation fields different meanings. Your [environment page](environments/index.md) explains the starting agent line by line and documents every value. It also covers a `sandbox` helper module (`sandbox.features` for Flappy Bird or `sandbox.cards` for Hearts and Spades). These helpers let you use named values and card objects instead of reading raw arrays.

See [Agent interface](agent-interface.md) for the complete method contract and a small example.

## 4. Play and evaluate

```console
python -m sandbox                    # play it yourself in a browser
python -m sandbox human              # the same as the command above
python -m sandbox play               # watch your agent in a browser
python -m sandbox play --headless    # run one game without a browser
python -m sandbox eval --episodes 10 # run ten repeatable headless games
```

`python -m sandbox` and `python -m sandbox human` let you control the selected player in a browser. Every other player is a separate instance of your agent. `python -m sandbox play` opens a browser game in which every player is a separate instance of your agent, so you can watch how your strategy behaves.

`python -m sandbox play --headless` runs one game without a browser. It runs your agent for the selected player and uses a legal default choice for every other player. `eval` repeats that same headless setup over several **episodes**, which are complete games, each starting from a repeatable condition called a **seed**. It plays five episodes unless you pass `--episodes`, and reports the average score. These local results show whether a change made your agent better or worse, but they do not predict an official leaderboard result because a season can use different opponents, player layouts, settings, and limits.

Use `--player N` to select a player by number when a game has more than one; the commands control player `0` unless you choose another. `python -m sandbox setup` prepares the virtual environment without starting a game. Every browser game uses the same controls to start, pause, resume, and stop.

Two options help when you want to study one specific game: `play --seed N` repeats the same starting condition every time, and adding `--help` to any command lists all of its options.

## 5. Run the checks

```console
python -m sandbox test
```

The tests confirm that `manifest.json`, the small file that names your agent class, points to an agent that Python can load, and that the agent can run the environment. They pass in a fresh template because it includes a working agent. Keep them passing as you edit `agent.py`, and use any failure message to find the problem.

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
