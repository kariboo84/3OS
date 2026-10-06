#!/usr/bin/env bash
# Construit 3OS v0.3 : noyau (os/kernel3.tas) + disque (os/3os.t3d, copié dans web/).
set -euo pipefail
cd "$(dirname "$0")/.."
VM=tri27/target/release/tri27
(cd tri27 && cargo build --release -q)
B=cc/build/os; mkdir -p "$B"
cc() { python cc/tri27cc.py "$@"; }
cc os/kentry.tas os/kernel.c --kernel -o os/kernel3.tas
cc cc/examples/system3.c cc/lib/tgfx.c cc/lib/sys.tas -o "$B/system3.tas"
cc cc/examples/tetris.c -o "$B/tetris.tas"
cc cc/examples/hello.c -o "$B/hello.tas"
cc cc/examples/sieve.c -o "$B/sieve.tas"
cc cc/examples/crash.c -o "$B/crash.tas"
$VM mkdisk os/3os.t3d system3="$B/system3.tas" tetris="$B/tetris.tas" hello="$B/hello.tas" \
  sieve="$B/sieve.tas" crash="$B/crash.tas" lisez-moi=os/LISEZMOI.txt
cp os/3os.t3d web/3os.t3d
