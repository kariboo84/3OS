#!/usr/bin/env bash
# Construit 3OS : noyau (os/kernel3.tas) + disque (os/3os.t3d, seule image servie au web et au CLI).
set -euo pipefail
cd "$(dirname "$0")/.."
VM=tri27/target/release/tri27
(cd tri27 && cargo build --release -q)
B=cc/build/os; mkdir -p "$B"
# Fixtures du visualiseur, générées une fois ; PNG/BMP/PPM sont les vrais fichiers.
[[ -f os/assets/demo.png && -f os/assets/demo.bmp && -f os/assets/demo.ppm ]] || python3 tests/timage.py --assets-only
cc() { python cc/tri27cc.py "$@"; }
cc os/kentry.tas os/kernel.c --kernel -o os/kernel3.tas
cc cc/examples/system3.c cc/lib/dgfx.c cc/lib/tgfx.c cc/lib/sys.tas -o "$B/system3.tas"
cc cc/examples/tetris.c -o "$B/tetris.tas"
cc cc/examples/hello.c -o "$B/hello.tas"
cc cc/examples/sieve.c -o "$B/sieve.tas"
cc cc/examples/crash.c -o "$B/crash.tas"
cc cc/examples/chiffres.c cc/lib/tgfx.c -Icc/examples -o "$B/chiffres.tas"
cc cc/examples/editeur.c cc/lib/tgfx.c cc/lib/sys.tas -o "$B/editeur.tas"
cc cc/examples/ternet.c -Icc/examples -o "$B/ternet.tas"
cc cc/examples/kleene.c -o "$B/kleene.tas"
cc cc/examples/images.c cc/lib/timage.c cc/lib/timage_png.c cc/lib/timage_io.c cc/lib/dgfx.c cc/lib/tgfx.c cc/lib/sys.tas -o "$B/images.tas"
cc cc/examples/hd.c -o "$B/hd.tas" && cp "$B/hd.tas" examples/hd.tas
cc cc/examples/gpu.c -o "$B/gpu.tas" && cp "$B/gpu.tas" examples/gpu.tas
$VM mkdisk os/3os.t3d system3="$B/system3.tas" chiffres="$B/chiffres.tas" editeur="$B/editeur.tas" \
  tetris="$B/tetris.tas" ternet="$B/ternet.tas" kleene="$B/kleene.tas" hello="$B/hello.tas" \
  sieve="$B/sieve.tas" crash="$B/crash.tas" lisez-moi=os/LISEZMOI.txt:2187 hd="$B/hd.tas" gpu="$B/gpu.tas" \
  config=os/config.txt:729 prefs=os/prefs.txt:729 images="$B/images.tas" \
  demo.png=bytes:os/assets/demo.png demo.bmp=bytes:os/assets/demo.bmp demo.ppm=bytes:os/assets/demo.ppm \
  image-cible=os/image-cible.txt:729
