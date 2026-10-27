# Torch support

Status: implemented, pending GPU verification on the cloud deployment.

Agents may use PyTorch in official games, and a season may give its containers more CPU, more memory, or one GPU each. The [Seasons spec](../docs/specs/seasons.md#sandbox-resources) defines the per-season resources, the [execution guide](../docs/contributors/runtime/execution.md#gpu-access) covers GPU leasing and host setup, and [Getting Started](../docs/students/getting-started.md#optional-use-pytorch) tells students how to opt in.

## Scope

- **Torch in the session base image.** `deps-v1` gains a server-only platform layer that installs torch in its own image layer after the shared set. It has two variants, each an intent file plus a compiled pin file: `requirements.platform.cpu.*` (`torch==2.14.1+cpu`, the default) and `requirements.platform.cuda.*` (`torch==2.14.1`, the regular PyPI wheel). Both compile against the shared `requirements.txt` as a constraint. The Dockerfile's `TORCH_VARIANT` argument picks one, and the build-time import check imports torch. `SANDBOX_GPU_VENDOR=nvidia` builds `cuda` under the image prefix `<DOCKER_IMAGE_TAG_PREFIX>-cuda`, overlays included; `none` builds `cpu`. `scripts/bump_template_version.py` carries the platform files into a new snapshot. Both a bump and `--check` require each variant's `.txt`, its Dockerfile copy, and agreement with overlapping shared pins. Conflicts name the variant to recompile against the shared constraints, and a rejected bump leaves the version touchpoints unchanged.
- **Additive dependency rule.** A published `deps-v<N>` accepts additive changes only. A new package may join through a republish; changing or removing a pin needs `deps-v<N+1>`.
- **Per-season resources.** `overrides.sandbox` takes optional `cpus`, `memory_mb`, and `gpu`. It applies to live sessions, leaderboard games and their automatic concurrency, and the submission load check, which never takes a GPU.
- **Thread pools.** Every container sets `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, and `OPENBLAS_NUM_THREADS` to the whole number of CPUs in its quota, with a minimum of 1.
- **GPU access.** NVIDIA GPUs only. Three settings describe the host: `SANDBOX_GPU_VENDOR`, `SANDBOX_GPU_DEVICES`, and `SANDBOX_GPU_SLOTS_PER_DEVICE`. `driver/gpu-pool.ts` leases the least-loaded device for a container's lifetime. A live session is refused with 503 `gpus_busy` when every slot is busy, leaderboard games wait, and a GPU season's leaderboard concurrency is capped at the slot count. Run cancellation, shutdown, and fatal worker failures abort queued GPU acquisition without waiting for another session to finish. The leased device maps through an NVIDIA device request. A lease is released only after Docker confirms removal or reports the container already absent. Failed removal retains the lease and retries every five seconds, including after a failed launch or a cancelled run drops its process. A kill fails only when Docker cannot confirm that the container stopped. Once it has stopped (natural exit, a successful stop, or an "already stopped" reply), a failed removal is logged and left to the retry, so the owner finishes its game or run. The rest of the hardening is unchanged. The admin API rejects `gpu: true` on a deployment without GPUs, and the season view reports `sandbox_defaults`.
- **Admin season editor.** The Session Behavior card gains **Submission size limit (MB)** (the existing `submission_max_size_mb`, which the editor used to drop on save), **CPU cores**, **Memory (MB)**, and **GPU**. The two quota fields show the deployment defaults as placeholders. The GPU field offers Off or "On, one per container" and is disabled with the hint "This deployment has no GPUs." when the deployment has none.

The Session Behavior card now reads:

```text
+-- Session Behavior -------------------------------------------------------+
| Step timeout (ms)      Per-player timeout (ms)      Messaging             |
| [ default 1000 ]       [ default 120000 ]           [ Env default v ]     |
| Submission size limit (MB)   CPU cores        Memory (MB)     GPU         |
| [ default ]                  [ default 1 ]    [ default 512 ] [ Off v ]   |
|                              Per container.   Per container.  This        |
|                                                               deployment  |
|                                                               has no GPUs.|
+---------------------------------------------------------------------------+
```

The takeaway is that an empty quota field keeps the deployment default, which the placeholder shows, and the GPU choice is visible but locked on a deployment that cannot serve it.

## Owner decisions

- Torch joins `deps-v1` in place, under the additive rule.
- A deployment without GPUs builds the CPU-only torch wheel, which keeps the base image at about 1.7 GB instead of 9 GB. Enabling GPUs later means building the CUDA image.
- GPU support covers NVIDIA only; there is no ROCm build.
- Templates do not gain torch. The Skirmish at Crane Reach `imitation` example (below) is the one place a student project ships with it.
- CPU, memory, and GPU are set per season.
- `SANDBOX_GPU_SLOTS_PER_DEVICE` defaults to 1, so a device is exclusive unless the operator chooses to share it.

## Imitation example

`environments/skirmish_crane/examples/imitation/` is a published worked example (branch `examples/skirmish_crane/imitation`) in which a teacher agent's choices train a small PyTorch attention policy. It came from the course's imitation learning assignment and was adapted to the platform's example layout.

- **Learner.** `agent.py`, `encoder.py`, and `imitation_model.py` form the submitted agent. It loads `imitation-policy.pt` beside it and plays on one CPU thread. `routes.py` supports the README's route-cost exercise and is unused until a student adds that feature.
- **Experiment.** `imitation/` holds the offline collect, train, and evaluate scripts, run as `python -m imitation.<script>`. They write to `runs/`, which the example's `.gitignore` excludes. The learner never imports them.
- **Stand-in teacher.** `teacher.py` and `blocks.py` are verbatim copies of the published Banner example's `agent.py` and `blocks.py`, so the branch runs before a student brings their own agent. The duplication is deliberate: compose overlays one example directory, and the copies need not track later Banner changes.
- **Season.** `season.json` carries the Season 4 parameters Banner was built for. Under the default parameters Banner loses every seat-0 match against Naive, which makes a poor teacher.
- **Torch pin.** `requirements.extra.txt` adds `torch==2.14.1`, the same pin [Getting Started](../docs/students/getting-started.md#optional-use-pytorch) asks for.
- **Tests.** `tests/test_imitation.py` covers the model's padding and ordering invariance, checkpoint and record validation, mirrored observations, collector isolation, a full match by the shipped learner, and a two-seed collect and train run.

Any change to the encoder's features, and so to its `VERSION`, needs `imitation-policy.pt` regenerated, or the shipped-learner test fails. From the repository root:

```console
uv run python scripts/compose.py skirmish_crane imitation
cd build/examples/skirmish_crane/imitation
uv venv .venv
uv pip install --python .venv/Scripts/python.exe --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match -r requirements.txt -r requirements-dev.txt
.venv/Scripts/python.exe -m imitation.experiment collect --episodes 10
.venv/Scripts/python.exe -m imitation.train runs/demonstrations.jsonl
```

Then copy `imitation-policy.pt` back into the example directory and update the agreement figure quoted in its README. (On macOS or Linux the interpreter is `.venv/bin/python`.) The October 2026 model trained on 4,407 Season 4 decisions in about 40 seconds on a CPU, reached 86.9% tile agreement against a 9.6% random baseline, and won every evaluation match against Naive at under 1 ms per `act`.

**CI.** An example whose `requirements.extra.txt` pins `torch` is a slow example. The `examples` job skips it, and the manually dispatched `examples-slow` job (`.github/workflows/examples-slow.yml`) installs CPU-only torch from the PyTorch wheel index, the same build the session image's cpu layer uses, and runs it. `ci.py all`, which the publish workflow's verify job runs, includes `examples-slow`, so a published slow example is always checked before release.

## Implementation choices for owner review

- The submission load check never takes a GPU. Its timeout covers the launch, so waiting behind running GPU games would fail checks on a busy deployment. Agents must therefore construct on CPU, which the student guide already asks for.
- The CUDA build is separated by image prefix (`<prefix>-cuda`) rather than by tag suffix, so base images, overlays, and the eviction sweep stay apart with no tag parsing changes.

## Verification

- Unit tests cover the GPU pool (`backend/test/driver/gpu-pool.test.ts`), cancellable launches, lease retention during failed cleanup, and kills that succeed once the container has stopped (`backend/test/driver/docker/session-process.test.ts`), the Docker create options (`backend/test/driver/docker/create-options.test.ts`), configuration loading, season overrides in the sandbox profile, session, submission worker, and workflow runner, the admin API, and the season editor (`frontend/test/admin-console.test.ts`). The workflow tests cancel or shut down a run while a separate session holds its GPU and check that cancellation lets the next run proceed. Template-bump tests check overlapping platform pins and rollback on a conflict.
- The Docker-gated `backend/test/integration/driver-sandbox.test.ts` checks the thread-count variables inside a real container.
- The GPU-gated `backend/test/integration/gpu-sandbox.test.ts` builds the CUDA base image, leases one GPU, and checks that torch sees exactly one working device. It is skipped without GPU settings and still has to run on the cloud deployment. The [runbook](../docs/contributors/runtime/execution.md#verifying-gpus-on-a-deployment) gives the command.
