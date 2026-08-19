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
# HOME is the tmpfs scratch, the only writable path besides the mounted /recordings, so a session
# runs as the non-root `sandbox` user with somewhere writable and never picks up a userspace pip.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp \
    PYTHONNOUSERSITE=1

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

# 3. The versioned v1 built-in scripted agents, one or more per environment under
#    /opt/agents/builtin/<env_id>/<name>, each loaded through the manifest loader a Stage 5 submission uses.
#    They may be regenerated with the matching template until template-v1 is published; publication
#    freezes this snapshot beside the requirements. The Naive baseline is
#    per-environment because the observation (and so the policy) differs: Flappy Bird's reads a flat
#    array, Hearts' reads the legal-action mask. A seat with no explicit overlay path resolves to
#    /opt/agents/builtin/<the session's env_id>/<builtin name> (see harness `build_players`). Keeping the versioned copy
#    here avoids composing from a later template whose requirements could upgrade the v1 set.
#
#    `chmod a+rX` normalizes the tree's permissions: a session container runs as the non-root
#    `sandbox` user (see below), so it has no CAP_DAC_READ_SEARCH or override and is subject to the
#    real mode bits. A build
#    context coming from a host that does not carry Unix execute bits (a Windows checkout) can leave
#    the copied directories without their search bit, which makes even root unable to stat the
#    manifest inside — a session-time PermissionError that a Linux-built image never shows. `a+rX`
#    adds read for all and execute only where it already applies (directories), so the agent loads
#    regardless of the build host without marking data files executable. Only the Flappy baseline
#    pulls an extra dependency (wcwidth); the Hearts baseline is standard-library only.
COPY backend/images/session-base/deps-v1/builtin /opt/agents/builtin
RUN chmod -R a+rX /opt/agents/builtin \
    && pip install --no-cache-dir -r /opt/agents/builtin/flappy_bird/naive/requirements.txt

# Fail the build, not a session, if the packages or a named built-in agent cannot load. Reading the
# installed environment metadata makes a missing directory fail whenever a declaration adds an agent.
RUN python -c "import game_sandbox_harness, flappy_bird, hearts, skirmish_crane, spades, three_branches" \
    && python -c "from game_sandbox_harness.environment import load_environment; from game_sandbox_harness.manifest import load_agent; [load_agent(f'/opt/agents/builtin/{env_id}/{builtin.name}') for env_id in ('flappy_bird', 'hearts', 'skirmish_crane', 'spades', 'three_branches') for builtin in load_environment(env_id).meta.builtin_agents]"

# Apply the `a+rX` normalization to the rest of the tree too (harness, environments, and agents get
# COPY'd from a build context that may lack execute bits), so the non-root `sandbox` user can read
# them. Then add the fixed non-root account as the session and load-check identity: an escape from
# untrusted student code lands as this unprivileged user, never as root.
RUN chmod -R a+rX /opt/src /opt/agents \
    && addgroup --gid 10001 sandbox \
    && useradd --no-create-home --uid 10001 --gid 10001 --home-dir /tmp sandbox

# The entrypoint is the live runner; the session config is appended as a single JSON argv element
# by the orchestrator. The recordings volume is mounted at /recordings and named in that config.
# Overlay images keep this user: they only COPY student code (world-readable, 0o644/0o755) on top.
USER sandbox
ENTRYPOINT ["python", "-m", "game_sandbox_harness.live"]
