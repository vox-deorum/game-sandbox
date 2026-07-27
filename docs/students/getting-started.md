# Getting Started

You will write a Game Sandbox agent in Python and test it on your own computer. The project template includes the game environment and the PettingZoo tools that run it. You do not need to run the Game Sandbox website or server.

## Before you begin

Install:

- [Python 3.12](https://www.python.org/downloads/)
- [Git](https://docs.github.com/en/get-started/git-basics/set-up-git)
- A code editor, such as [Visual Studio Code](https://code.visualstudio.com/)

Git records changes to a project. GitHub stores a copy of that project online. A project tracked by Git is called a **repository**, often shortened to **repo**. GitHub's [Hello World guide](https://docs.github.com/en/get-started/start-your-journey/hello-world) is a friendly introduction if these ideas are new.

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

There is no separate installation step, and you can run the command again at any time. The game runs only on your computer, so it does not need the Game Sandbox website or an internet connection. The other commands in this guide, such as `python -m sandbox play`, `eval`, and `test`, set up the project in the same way.

If you prefer to manage the virtual environment yourself, create one inside the repository.

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

The two requirements files list the exact package versions used by the template and its tests. Do not edit `requirements.txt` or install different versions in the project. Ask your instructor if you need a package that is not included.

## 3. Improve your agent

Open `agent.py`. It contains a small working agent, so you can run the game before changing any code. Your job is to make that agent play better. It has two required methods:

- `reset(seed)` prepares the agent for a new game.
- `act(observation)` reads the current game state and returns an action. A `TODO(you)` comment marks the line for you to change.

For Flappy Bird, the observation describes the bird and nearby pipes in screen pixels. An action is `0` to do nothing or `1` to flap. For Hearts and Spades, the observation contains your hand and the cards on the table as objects such as `{"suit", "rank"}`. It also contains a **legal-move mask**, an array that marks which actions are currently allowed. The action is the number for the card or bid you chose.

Each game gives its action numbers and observation fields different meanings. Your [environment page](environments/index.md) explains the starting agent line by line and documents every value. It also covers a `sandbox` helper module (`sandbox.features` for Flappy Bird or `sandbox.cards` for Hearts and Spades). These helpers let you use named values and card objects instead of reading raw arrays.

See [Agent interface](agent-interface.md) for the complete method contract and a small example.

## 4. Play and evaluate

```console
python -m sandbox play
python -m sandbox play --headless
python -m sandbox eval --episodes 10
python -m sandbox            # play it yourself
```

`play` opens one game with your agent in a local browser. `--headless` runs the game without opening a browser. `eval` runs several games with repeatable starting conditions, called **seeds**, and reports their average score. An average is more useful than one game that may have been lucky.

With no command, `python -m sandbox` lets you play the game yourself. `python -m sandbox human` does the same, while `python -m sandbox setup` prepares the virtual environment without starting a game. Every environment uses the same browser controls to start, pause, resume, and stop.

## 5. Run the checks

```console
python -m sandbox test
```

The tests confirm that the manifest points to an agent that Python can load and that the agent can run the environment. They pass in a fresh template because it includes a working agent. Keep them passing as you edit `agent.py`, and use any failure message to find the problem.

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
