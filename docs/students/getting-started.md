# Getting Started

This guide walks you through writing a game agent in Python and testing it on your own computer.

## Before you begin

Install:

- [Python 3.12](https://www.python.org/downloads/)
- [Git](https://docs.github.com/en/get-started/git-basics/set-up-git)
- A code editor, such as [Visual Studio Code](https://code.visualstudio.com/)

> _What's Git or GitHub?_ Git records changes to a project. GitHub stores a copy of that project online. A project tracked by Git is called a **repository**, often shortened to **repo**. Want to know more? Check out GitHub's [Hello World guide](https://docs.github.com/en/get-started/start-your-journey/hello-world).

> _What's Python?_ Python is the language you will use to describe your agent's decisions. It is widely used in machine learning today. Python's [official tutorial](https://docs.python.org/3/tutorial/) introduces the language from the beginning. Its sections on numbers, lists, dictionaries, functions, and classes are especially useful here.

## 1. Copy the template to your computer

Open the environment's **My Submissions** page on the course website and choose **Set Up Locally**. It shows the exact commands for your season, ready to copy. They look like this:

```console
git clone -b <season-branch> --single-branch <template-repository-url> <environment>-<season>
cd <environment>-<season>
git branch -M main
git remote remove origin
```

Run them in a terminal. **Cloning** a repository means copying it to your computer. The first command copies the season's template into a new folder named after your environment and season, so copies for different seasons never collide. The second command enters that folder, the third renames your working branch to the usual `main`, and the last one disconnects your copy from the template. Because of that last command, nothing you do later can accidentally push to the template: instead, your editor offers to publish the project to your own GitHub account, as [step 6](#6-save-your-work-on-github) shows.

If you use Visual Studio Code, select **File > Open Folder** on the new folder after running the commands, then select **Terminal > New Terminal**. Use that terminal for the rest of this guide. It should start in the folder containing `agent.py` and `manifest.json`.

See GitHub's [cloning guide](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository) if you need more background.

## 2. Set up the project and play

From the repository folder, run:

```console
python -m sandbox
```

The first run normally creates a **virtual environment** to keep this project's Python packages separate from other projects, then installs the exact versions required by the template. If your current Python interpreter already passes the template's dependency checks, the launcher can use it as-is. It then opens the game in your browser. Select **Start** when you are ready. Your [environment page](environments/index.md) explains the controls.

After the first run, local play and tests work with no website or internet connection required. Optional LLM calls need access to the course website.

### Manual installation

If automatic setup fails, follow Python's [virtual environment guide](https://docs.python.org/3/tutorial/venv.html) to create and activate `.venv`. After activating that environment, install the template's packages:

```console
python -m pip install -r requirements.txt -r requirements-dev.txt
```

When a virtual environment is active, your terminal usually shows `(.venv)` at the start of the prompt. The requirements files list the packages used by the template and its tests, so do not edit `requirements.txt` or install different versions in the project. The one exception is PyTorch, which you may add as [Optional: use PyTorch](#optional-use-pytorch) describes. Ask your instructor if you need a package that is not included.

## 3. Improve your agent

Open `agent.py`, which already contains a small working agent for you to improve. It has two required methods:

- `reset(seed, observation)` prepares the agent for a new game from its first-turn observation.
- `act(observation)` reads the current game state and returns an action. In most templates, a `TODO(you)` comment marks the line for you to change.

See [Agent interface](agent-interface.md) for more about these methods and the optional methods you can add.

Action numbers and observation fields mean different things in each game. In Flappy Bird, for example, the observation describes the bird and nearby pipes in screen pixels. Your [environment page](environments/index.md) explains the starting agent line by line and documents every value.

## 4. Play and evaluate

Use these commands most often:

```console
python -m sandbox play                # play it yourself in a browser (same as `python -m sandbox`)
python -m sandbox watch               # watch your agent in a browser
python -m sandbox eval --episodes 10  # run ten repeatable games without a browser
```

A **seat** is one position, side, or team scored together, with one or more players. `watch` and `eval` give your agent one seat and fill the opposing seats that accept student agents with **Naive**, a simple built-in agent; `eval` does it without a browser. When you play by hand, your own agent takes those seats instead, so you can play against what you built. Each complete game is an **episode** and starts from a repeatable condition called a **seed**. `eval` runs five episodes by default and reports your seat's average score.

Use the same seeds before and after a change to compare your results. Local results cannot predict the official board, where your agent may face different opponents or settings.

## 5. Run the checks

```console
python -m sandbox test
```

`manifest.json` is the small file that names your agent class. The tests confirm that it points to an agent Python can load and that the agent can run the environment. Keep them passing as you edit `agent.py`, and use any failure message to find the problem. You can also add your own test files following [this guide](testing.md).

## 6. Save your work on GitHub

Create a **commit**, a named snapshot of your repository:

```console
git status
git add agent.py
git commit -m "Improve my agent"
```

`git status` shows what changed, `git add` selects changes for the commit, and `git commit` creates it. Check `git status` before adding files. GitHub's [About Git guide](https://docs.github.com/en/get-started/using-git/about-git) explains these commands in more detail.

Your copy starts with no GitHub repository of its own, so publish it once:

- In Visual Studio Code, open the **Source Control** view and select **Publish Branch**, then choose the option that creates a **public** repository. VS Code creates the repository under your GitHub account and pushes your commits.
- In a terminal, first create an empty public repository at [github.com/new](https://github.com/new) (pick a name and add no starter files), then connect your copy to it and push:

```console
git remote add origin https://github.com/<your-username>/<your-repository>.git
git push -u origin main
```

After that first publish, plain `git push` sends each new commit to GitHub.

## 7. Submit

Submit your repository URL through the course website. The server records one exact commit, so later edits do not change an existing submission. See [Submitting](submitting.md) for the validation process and common errors.

## More local-run options

| Option or command | What it does |
| --- | --- |
| `--vs PATH` | Use a saved agent in opposing seats that accept student agents, in place of Naive or your own agent. Your controls, companions, and fixed built-in roles do not change. `PATH` may be the agent folder or its `manifest.json` file. |
| `--seat N` | Choose seat `N`. Seats start at `0`. Without this option, `play` chooses a human seat, while `watch` and `eval` choose the first seat that accepts your agent. |
| `--companion NAME_OR_PATH` | Let an agent control your teammates while you play. Pass a built-in name or agent folder; omit this option, or pass `self`, to control the whole team when every member allows it. A seat with members you cannot control yourself needs an explicit `--companion`. |
| `season.json` | Apply the season's gameplay parameters and time limits to `play`, `watch`, and `eval`. Download the file through **Set Up Locally** and put it beside `manifest.json`. Delete it to return to environment defaults. |
| `--preset NAME` | Use one named gameplay preset for `play` or `watch`. It replaces the gameplay parameters from `season.json` for that command but keeps the time limits. If you also pass `--parameter`, that value takes priority. |
| `--parameter NAME=VALUE`, `--decision-limit-ms N`, `--game-limit-ms N` | Change a setting or time limit from `season.json` for one `play`, `watch`, or `eval` command. Repeat `--parameter` to change several settings. |
| `python -m sandbox setup` | Prepare the virtual environment without starting a game. |
| `python -m sandbox watch --seed N` | Repeat one starting condition and random generator. |
| `--help` | List the options for any command. |

To compare an older version, copy its project files to `rivals/v1`, then add `--vs rivals/v1` to `play`, `watch`, or `eval`. An absolute path also works.

## Optional: use PyTorch

[PyTorch](https://pytorch.org/tutorials/beginner/basics/intro.html) is a Python library for building and running neural networks. The course server already has it installed, so your agent may use it even though the template does not include it.

> _What's a neural network?_ It is a model made of layers of numbers, called **weights**, that turn an input (here, an observation) into an output (such as a score for each action). Training adjusts the weights. PyTorch's [beginner tutorial](https://pytorch.org/tutorials/beginner/basics/intro.html) walks through one from the start.

To use it:

1. Add this exact line to the end of `requirements.txt`, then run `python -m sandbox setup` to install it into your project:

   ```text
   torch==2.14.1
   ```

   Use exactly this version. The server ignores your `requirements.txt` and always runs its own copy of torch, so any other version would only make your computer behave differently from the official games.

2. Make your agent work on a CPU. Many seasons have no GPU, and the submission check always runs on a CPU. Pick the device in one line, so your agent uses a GPU only when the season provides one:

   ```python
   device = "cuda" if torch.cuda.is_available() else "cpu"
   ```

3. Save trained weights to a file in your repository with `torch.save(model.state_dict(), "model.pt")`, and load them in `__init__`. The file counts toward the season's [size limit](submitting.md#repository-rules), so keep the model small.

A minimal agent that loads saved weights looks like this:

```python
from pathlib import Path

import torch

WEIGHTS = Path(__file__).parent / "model.pt"


class Agent:
    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = torch.nn.Sequential(
            torch.nn.Linear(8, 32),
            torch.nn.ReLU(),
            torch.nn.Linear(32, 2),
        )
        state = torch.load(WEIGHTS, map_location=self.device)
        self.model.load_state_dict(state)
        self.model.to(self.device)
        self.model.eval()

    def reset(self, seed: int, observation) -> None:
        torch.manual_seed(seed)

    def act(self, observation):
        # Turn the observation into the list of numbers your model was trained on.
        inputs = torch.as_tensor(observation, dtype=torch.float32, device=self.device)
        with torch.no_grad():
            scores = self.model(inputs)
        return int(scores.argmax())
```

The layer sizes (`8` inputs and `2` actions here) must match your game and the model you trained. `Path(__file__).parent` finds `model.pt` beside `agent.py` no matter which folder the game starts in.

Torch uses as many threads as the season's CPU allowance. A small model rarely gets faster beyond 2 to 4 threads, so a smaller model is usually the surest way to make decisions quicker.

## Optional: use the LLM API

If your environment allows language model calls, follow [Using the LLM API](llm.md) to create a development key, save it in `.env`, and test it. Never commit `.env` or an API key to GitHub.
