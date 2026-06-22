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

## 2. Create a Python environment

A **virtual environment** keeps this project's Python packages separate from packages used by other projects. Create one inside the repository.

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

## 3. Write your agent

Open `agent.py`. The two required methods are:

- `reset(seed)`, which prepares the agent for a new game.
- `act(observation)`, which looks at the current state and returns an action.

For Flappy Bird, the observation is a NumPy array of 12 normalized numbers describing the bird and nearby pipes. An action is `0` for do nothing or `1` for flap. If NumPy arrays are new to you, read the first sections of [NumPy's beginner guide](https://numpy.org/doc/stable/user/absolute_beginners.html).

See [Agent interface](agent-interface.md) for the complete method contract and a small example.

## 4. Play and evaluate

```console
python play.py
python play.py --headless
python evaluate.py --episodes 10
```

`play.py` runs one visible game. `--headless` runs without opening a game window. `evaluate.py` runs several seeded games and reports the mean score, which is more useful than judging an agent from one lucky run.

## 5. Run the checks

```console
pytest
```

The template tests confirm that the manifest points to a loadable agent and that the agent can drive the environment. The unfinished template fails because `act` raises `NotImplementedError`. After you implement the method, use the test output to find any remaining problems.

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

If your environment allows model calls, copy `.env.example` to `.env`, add the endpoint and key from your instructor, and run:

```console
python llm_example.py
```

Your agent reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` locally and on the server. Never commit the `.env` file or an API key to GitHub. The [LLM specification](../specs/llm.md) explains server-side budgets and telemetry.
