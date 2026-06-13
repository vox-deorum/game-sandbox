# Stage 2: Agent Interface and Manifest

Part of [Stage 2](../stage-02-harness-and-first-environment.md). This file fixes the agent interface from [submission.md](../specs/submission.md) and the manifest that lets the harness load an agent from a repository, which is exactly what the Stage 3 session container will do.

## The interface, defined twice on purpose

The harness package gains `game_sandbox_harness.agent` with an abstract base class:

```python
class AgentBase(ABC):
    @abstractmethod
    def reset(self, seed: int) -> None: ...
    @abstractmethod
    def act(self, observation: Any) -> Any: ...
```

`learn(observation, action, reward, terminated)` and `chat(inbox)` are deliberately **not** declared on the base, not even as no-op defaults. The harness detects them by presence (`callable(getattr(agent, "learn", None))`), so a default implementation would make every agent look like it learns and chats, and the harness would burn a hook call (and clock time, since hook time counts against the limits) on agents that do nothing. The base class documents the optional hooks in its docstring instead. In Stage 2 `chat` is documented and detected but never called; routing arrives in Stage 9.

The template repo carries its own stub of the same interface as a plain class with docstrings (see [template-and-examples.md](template-and-examples.md)), because participants develop against vanilla PettingZoo and never install the harness, per [submission.md](../specs/submission.md). That makes the duck-typed detection load-bearing rather than a convenience: the loader checks structurally that `reset` and `act` exist and are callable, never `isinstance`. `AgentBase` exists for our own in-repo agents and tests, where pyright strict mode can verify signatures; a test asserts the template stub and `AgentBase` agree method-for-method so the two copies cannot drift silently.

## The manifest

`manifest.json` at the repository root, three required fields, closed to unknown keys so typos fail loudly:

```json
{
  "entry_point": "agent",
  "class_name": "Agent",
  "template_version": 1
}
```

`entry_point` is a module path importable from the repo root, `class_name` the agent class inside it, and `template_version` the integer N of the `template-v<N>` dependency set the repo targets, per [submission.md](../specs/submission.md). JSON over TOML or YAML because the project already standardizes on JSON contracts, the Stage 5 TypeScript backend will read this same file when verifying submissions, and three fields need no comments.

## Loading

`game_sandbox_harness.manifest` exposes `load_manifest(repo_root)` and `load_agent(repo_root)`. Loading parses and validates the manifest, prepends the repo root to `sys.path`, imports the entry-point module, resolves the class, and instantiates it with no arguments — the constructor takes nothing; all episode state is established in `reset(seed)`. Every failure mode raises a `ManifestError` with a message naming the repo, the field, and the failure (missing file, malformed JSON, unknown key, non-integer version, import error, missing class, missing or non-callable `reset`/`act`), because in Stage 5 these messages are surfaced to the participant whose build failed rather than to us.

The `sys.path` manipulation is deliberately the same mechanism the Stage 3 container will use with per-slot directories: one repo root per slot, each loaded by this same function. Stage 2 does not sandbox the import — participant code runs in-process with the harness by design ([execution.md](../specs/execution.md)); isolation is the container's job, not the loader's.

`template_version` is recorded but not enforced in Stage 2: the local harness runs whatever is installed. Stage 5 is where the version selects a base image and mismatches become errors.
