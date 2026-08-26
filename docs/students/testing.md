# Testing Your Agent

Run `python -m sandbox test` after changing your agent. The template tests check that `manifest.json` points to an agent Python can load, that the agent has the required methods, and that it can play a short episode. Beyond the pre-configured tests, you can add tests for your agent. Start by creating files named `tests/test_*.py`, which will be automatically recognized by the command `python -m sandbox test`.

## Test a small decision

A unit test imports a function from your agent and uses `assert` to state the result it expects. Hence, before adding a unit test, try extracting reusable code into a named function from `Agent.act`. Give the function only the values it needs. It will be easier to read and test without building a whole game observation.

For example, this Flappy Bird agent decides from the bird's height and the screen height:

```python
from sandbox.features import FLAP, IDLE, player_y, screen_height

def should_flap(y: float, height: float) -> bool:
    # Screen coordinates increase downward, so a larger Y value is lower on screen.
    return y > height / 2

class Agent:
    def reset(self, seed, observation) -> None:
        pass

    def act(self, observation) -> int:
        # Flap when the bird is below the middle of the screen.
        return FLAP if should_flap(player_y(observation), screen_height(observation)) else IDLE
```

To test the function `should_flap`, create `tests/test_my_agent.py`:

```python
import agent

def test_flaps_below_the_middle():
    # A bird in the lower half should flap.
    assert agent.should_flap(60, 100)
    # A bird in the upper half should stay idle.
    assert not agent.should_flap(40, 100)
```

The first assertion checks a bird below the middle of the screen. The second checks one above it. An `assert` fails when its condition is `False`. Run the test with:

```console
python -m sandbox test
```

## Use recorded observations when you need them

Some decisions need several values from an observation. The `record_observations` helper below runs one headless, seeded episode using your normal `Agent`. Its `Recorder` wrapper leaves the agent's decisions unchanged and saves an independent snapshot immediately before every `act` call. The helper returns those snapshots in decision order, so `[0]` is the observation for the first decision.

Observation formats are environment-specific and may contain arrays. To add the helper to `tests/test_my_agent.py`, first place these imports below `import agent`:

```python
import copy

from sandbox.env import META, make_env
from sandbox.features import player_y, screen_height
from sandbox.harness.environment import resolve_parameters
from sandbox.play import play_episode
```

Then add the recorder and test below the earlier test:

```python
class Recorder:
    def __init__(self) -> None:
        # Wrap the real agent so it makes the same decisions as usual.
        self.inner = agent.Agent()
        self.observations = []

    def reset(self, seed, observation) -> None:
        # Forward reset so the wrapped agent starts the episode normally.
        self.inner.reset(seed, observation)

    def act(self, observation):
        # Environments can reuse observation objects, so save an independent copy.
        self.observations.append(copy.deepcopy(observation))
        return self.inner.act(observation)


def record_observations(seed: int = 0):
    recorder = Recorder()
    # Build the environment with its default settings.
    env = make_env(resolve_parameters(META))
    try:
        # Use the normal episode loop so the recorder sees what the agent sees.
        play_episode(recorder, env, seed=seed)
    finally:
        # Close the environment even if the episode raises an error.
        env.close()
    return recorder.observations


def test_first_observation_does_not_flap():
    observation = record_observations(seed=0)[0]
    assert not agent.should_flap(player_y(observation), screen_height(observation))
```

The sandbox imports create an environment with its default parameters and run it without opening a browser. `play_episode` gives any unassigned players that environment's default action. With a deterministic agent, the same seed repeats the sequence as long as the agent code, environment code and settings, and dependencies stay unchanged. Try another seed when you need a different situation.

You can also build test data by hand when the relevant values are simple. Use the helpers documented for your environment instead of reconstructing a complete observation.

## Check whole games separately

Unit tests check individual decisions. For whole-game changes, compare seeded `python -m sandbox eval` results before and after your change, as [Getting started](getting-started.md#4-play-and-evaluate) describes.

Your test files are ordinary project files and count toward the repository size limit. Submission validation does not run tests or step the environment. It checks the project files, then imports your module and creates the agent class. See [Submitting](submitting.md#validation-flow) for the full validation flow.
