#!/bin/sh

set -eu

cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
    if command -v curl >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | sh
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- https://astral.sh/uv/install.sh | sh
    else
        echo "uv is not installed, and neither curl nor wget is available to install it." >&2
        exit 1
    fi
    export PATH="$HOME/.local/bin:$PATH"
fi

exec uv run --no-project python scripts/setup.py "$@"
