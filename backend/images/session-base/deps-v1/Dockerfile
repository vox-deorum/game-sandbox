# The session base image for dependency-set version 1, tagged game-sandbox/session-base:deps-v1.
#
# It carries everything a Stage 3 live session needs inside the sandbox: Python, the pinned v1
# dependency set, the harness and environment packages, and the built-in scripted agent. Stage 5
# overlays submission code on top of an image like this; the versioned v1 `hello` agent lets
# watch-style sessions exercise the real submission load path before any
# submission exists.
#
# Built with the REPO ROOT as the build context (see backend/src/driver/docker/image.ts), because
# the image includes the two Python packages plus this versioned definition's requirements and
# built-in agent. The whole definition becomes immutable when template-v1 is published.
FROM python:3.12-slim

# Read-only-root friendly: avoid bytecode writes onto the root filesystem. Stdout is the protocol
# channel; the runner flushes every line itself, and unbuffered mode keeps diagnostics prompt.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /opt/src

# 1. The versioned v1 dependency set installs first and alone. It may be regenerated with the matching
#    template until template-v1 is published. Publication freezes it so later templates cannot change
#    a cold rebuild of the deps-v1 tag.
COPY backend/images/session-base/deps-v1/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 2. The harness and environment packages from source. The environments package installs --no-deps
#    because its dependencies ARE the student set already installed above, so the set stays exactly
#    authoritative for those shared libraries. The harness installs WITH its dependencies because
#    its jsonschema and websockets infrastructure must be available independently of the environment
#    package. Pip leaves the matching pinned student dependencies untouched.
COPY harness ./harness
COPY environments ./environments
RUN pip install --no-cache-dir ./harness \
    && pip install --no-cache-dir --no-deps ./environments

# 3. The versioned v1 built-in scripted agents, one per environment under
#    /opt/agents/builtin/<env_id>, each loaded through the manifest loader a Stage 5 submission uses.
#    They may be regenerated with the matching template until template-v1 is published; publication
#    freezes this snapshot beside the requirements. The Naive baseline is
#    per-environment because the observation (and so the policy) differs: Flappy Bird's reads a flat
#    array, Hearts' reads the legal-action mask. A seat with no explicit overlay path resolves to
#    /opt/agents/builtin/<the session's env_id> (see harness `build_players`). Keeping the versioned copy
#    here avoids composing from a later template whose requirements could upgrade the v1 set.
#
#    `chmod a+rX` normalizes the tree's permissions: a session container runs as root but with
#    CapDrop ALL, so it loses CAP_DAC_READ_SEARCH and is subject to the real mode bits. A build
#    context coming from a host that does not carry Unix execute bits (a Windows checkout) can leave
#    the copied directories without their search bit, which makes even root unable to stat the
#    manifest inside — a session-time PermissionError that a Linux-built image never shows. `a+rX`
#    adds read for all and execute only where it already applies (directories), so the agent loads
#    regardless of the build host without marking data files executable. Only the Flappy baseline
#    pulls an extra dependency (wcwidth); the Hearts baseline is standard-library only.
COPY backend/images/session-base/deps-v1/builtin /opt/agents/builtin
RUN chmod -R a+rX /opt/agents/builtin \
    && pip install --no-cache-dir -r /opt/agents/builtin/flappy_bird/requirements.txt

# Fail the build, not a session, if the packages or a built-in agent cannot load: import each
# environment and load every per-environment baseline through the manifest loader.
RUN python -c "import game_sandbox_harness, flappy_bird, hearts, spades" \
    && python -c "from game_sandbox_harness.manifest import load_agent; load_agent('/opt/agents/builtin/flappy_bird'); load_agent('/opt/agents/builtin/hearts'); load_agent('/opt/agents/builtin/spades')"

# The entrypoint is the live runner; the session config is appended as a single JSON argv element
# by the orchestrator. The recordings volume is mounted at /recordings and named in that config.
ENTRYPOINT ["python", "-m", "game_sandbox_harness.live"]
