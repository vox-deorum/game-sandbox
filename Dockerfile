# This image runs the whole app (backend serving the built frontend) from source. Compose.yaml
# uses it for the containerized deployments described in docs/contributors/setup/docker.md.

FROM node:22-bookworm-slim
# git is required by simple-git for submission clones.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The backend ultimately runs as this non-root account, so a compromise of the web process cannot
# trivially control the whole host through the mounted Docker socket. The image bakes a fixed
# 1001:1001 account; the entrypoint remaps those ids to the host's APP_UID/APP_GID at every start,
# so a host whose DATA_DIR belongs to another owner needs no image rebuild. The container begins as
# root only long enough for the entrypoint to remap the account, join the host docker group, and
# take ownership of DATA_DIR; it then drops to the app account before the backend starts.
# The account name "appuser" is load-bearing: entrypoint.sh's group-remap logic (`groupmod -g ...
# appuser`) assumes a group of this exact name exists. Keep the two in sync if either changes.
RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid 1001 --home-dir /home/appuser --create-home --shell /usr/sbin/nologin appuser
WORKDIR /app
# The full source tree stays in the image: the backend runs from source via tsx, and it builds
# the session-base image from the repo root at runtime.
# Dependencies first: only the manifests and the lockfile are needed for `npm ci`, so the heavy
# install layer is cached across deploys and only the source copy after it is invalidated.
COPY package.json package-lock.json ./
COPY schema/ts/package.json schema/ts/package.json
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY . .
RUN npm run build --workspace @game-sandbox/frontend
# The official node image leaves HOME=/root, which appuser cannot write; point it at the app user's
# writable home so git (submission clones) can write its per-user configuration. The entrypoint
# keeps that home owned by whichever uid it drops to.
ENV HOME=/home/appuser
# The entrypoint resolves ids and permissions as root, then execs the command under the app account
# through setpriv, which keeps node as pid 1: signal delivery and the owner-pid container label stay
# stable, and the root phase never touches the web process.
COPY deploy/app/entrypoint.sh /usr/local/sbin/app-entrypoint.sh
RUN chmod +x /usr/local/sbin/app-entrypoint.sh
ENTRYPOINT ["/usr/local/sbin/app-entrypoint.sh"]
CMD ["node", "--import", "tsx", "backend/src/main.ts"]
