# This image runs the whole app (backend serving the built frontend) from source. Compose.yaml
# uses it for the containerized deployments described in docs/contributors/setup/docker.md.

FROM node:22-bookworm-slim
# git is required by simple-git for submission clones.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The full source tree stays in the image: the backend runs from source via tsx, and it builds
# the session-base image from the repo root at runtime.
COPY . .
RUN npm ci && npm run build --workspace @game-sandbox/frontend
# Exec form keeps node as pid 1, so signal delivery and the owner-pid container label stay stable.
ENTRYPOINT ["node", "--import", "tsx", "backend/src/main.ts"]
