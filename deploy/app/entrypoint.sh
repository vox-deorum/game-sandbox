#!/bin/sh
# Start the non-root backend. The container begins as root so this script can, at every start:
#   1. join the app account to a group matching the mounted docker socket's gid, so the non-root
#      process can open it without pinning a host-specific gid in compose (DOCKER_GID overrides),
#   2. remap the app account to the uid/gid that must own the bind-mounted DATA_DIR (APP_UID,
#      APP_GID, defaulting to the image's baked-in 1001:1001) and take ownership of that mount,
#   3. exec the backend under that account as pid 1, so node stays pid 1 and the root phase never
#      outlives startup (signal delivery and the owner-pid reaping label both depend on that).
# Because the ids are resolved here, changing a host's ownership never requires an image rebuild.
set -eu

# Must match the account groupadd/useradd creates in Dockerfile; the group-remap logic below
# (groupmod -g ... "$app_user") depends on a group of this exact name existing.
app_user=appuser
app_home=/home/appuser

die() {
    echo "app startup failed: $*" >&2
    exit 1
}

require_numeric() {
    name=$1
    value=$2
    case "$value" in
        '' | *[!0-9]*)
            die "$name must be a numeric uid/gid, got '$value'."
            ;;
    esac
}

# The image bakes this account at 1001:1001; when the script runs on a host with no such account
# (the --validate contract test) the fallback keeps the documented default.
app_uid=$(id -u "$app_user" 2>/dev/null || printf '1001')
app_gid=$(id -g "$app_user" 2>/dev/null || printf '1001')
target_uid=${APP_UID:-$app_uid}
target_gid=${APP_GID:-$app_gid}
require_numeric APP_UID "$target_uid"
require_numeric APP_GID "$target_gid"

docker_gid=${DOCKER_GID:-}
if [ -z "$docker_gid" ] && [ -S /var/run/docker.sock ]; then
    if ! docker_gid=$(stat -c '%g' /var/run/docker.sock 2>&1); then
        echo "app startup: could not read /var/run/docker.sock's gid ($docker_gid);" \
            "skipping automatic docker group setup. Set DOCKER_GID to override." >&2
        docker_gid=
    fi
fi
if [ -n "$docker_gid" ]; then
    require_numeric DOCKER_GID "$docker_gid"
fi

if [ "${1-}" = '--validate' ]; then
    exit 0
fi

# Remap the app account's primary group before joining it to the docker group below: if the host's
# docker socket gid happens to equal the account's original (baked-in) gid, the docker-group step
# resolves to the account's own primary group. Doing the APP_GID remap first ensures that group has
# already moved to its final gid by the time the docker-group step looks the socket's gid up, so a
# later renumber never steals the gid out from under the docker-group membership it granted.
if [ "$target_gid" -ne "$app_gid" ]; then
    if getent group "$target_gid" >/dev/null 2>&1; then
        primary_group=$(getent group "$target_gid" | cut -d: -f1)
        usermod -g "$primary_group" "$app_user"
    else
        groupmod -g "$target_gid" "$app_user" \
            || die "could not change the app group to gid $target_gid; choose a free APP_GID."
    fi
fi

if [ -n "$docker_gid" ]; then
    if getent group "$docker_gid" >/dev/null 2>&1; then
        docker_group=$(getent group "$docker_gid" | cut -d: -f1)
    else
        docker_group=game-sandbox-docker
        groupadd --gid "$docker_gid" "$docker_group" \
            || die "could not create the docker group gid $docker_gid; choose a free DOCKER_GID."
    fi
    usermod -aG "$docker_group" "$app_user"
fi

if [ "$target_uid" -ne "$app_uid" ]; then
    usermod -u "$target_uid" "$app_user" \
        || die "could not change the app user to uid $target_uid; choose a free APP_UID."
fi
mkdir -p "$app_home"
chown -R "$target_uid:$target_gid" "$app_home"

data_dir=${DATA_DIR:-/srv/game-sandbox/data}
mkdir -p "$data_dir"
# Take ownership of the bind-mounted DATA_DIR, but only when the top level is not already ours.
# The recursive walk exists solely for an upgrade from a fully-root image, whose nested content
# (recordings, submissions, the sqlite db, llm-keys) is root-owned; once the top level is
# target-owned the nested content was already re-owned by the walk that fixed it, so the common
# restart path is O(1) instead of walking tens of thousands of files every time.
current_owner=$(stat -c '%u:%g' "$data_dir" 2>/dev/null || printf '')
if [ -z "$current_owner" ] || [ "$current_owner" != "$target_uid:$target_gid" ]; then
    chown -R "$target_uid:$target_gid" "$data_dir"
fi

exec setpriv --reuid "$target_uid" --regid "$target_gid" --init-groups -- "$@"
