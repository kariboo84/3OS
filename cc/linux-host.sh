#!/bin/sh
# Run in an isolated toolchain root, not in Docker Desktop's system root.
set -eu
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
R="$REPO/cc/.host-root"
mount --bind "$REPO" "$R/work"
exec /usr/sbin/chroot "$R" "$@"
