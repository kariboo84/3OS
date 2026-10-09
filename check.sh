#!/usr/bin/env bash
# check.sh — vérification complète de 3OS / TRI-27. Usage : ./check.sh [--web]
set -euo pipefail
cd "$(dirname "$0")"
VM=tri27/target/release/tri27
echo "== VM";        (cd tri27 && cargo build --release -q)
echo "== C : tests chibicc"; (cd cc && python run_tests.py | tail -1)
echo "== C : banc d'instructions"; python cc/perf.py
echo "== OS : noyau + disque"; bash os/build.sh >/dev/null 2>&1
out=$(timeout 120 $VM run os/kernel3.tas --disk os/3os.t3d --max 400000000 --input '4  dd  q    7    8      9' 2>&1)
for want in "tetris: score" "Hello from TRI-27" "primes <= 100000: 9592" "crash tue : faute memoire"; do
  grep -q "$want" <<<"$out" && echo "  ok  $want" || { echo "  ÉCHEC $want"; exit 1; }
done
$VM run examples/sieve.tas | grep -q 9592 && echo "  ok  crible asm"
$VM run os/kernel.tas --input 'trits 42\nhalt\n' | grep -q "42 =" && echo "  ok  noyau v0.1"
# Journal d'exécution : une ligne par instruction, dernière ligne = arrêt propre.
mkdir -p cc/build
hn=$($VM run examples/hello.tas --stats --trace cc/build/hello.trace 2>&1 | sed -n 's/.*\] \([0-9]*\) instr.*/\1/p')
[[ -n "$hn" && $(wc -l < cc/build/hello.trace) -eq $hn ]] && tail -1 cc/build/hello.trace | grep -q "HALT exit=0" && echo "  ok  journal --trace ($hn lignes)" || { echo "  ECHEC journal --trace"; exit 1; }
echo "== Video HD (mode 3, 1 mot/pixel)"
python cc/tri27cc.py cc/examples/hd.c -o cc/build/hd.tas
rm -rf cc/build/hd_ppm
hdo=$($VM run cc/build/hd.tas --ppm cc/build/hd_ppm 2>&1)
grep -q "hd : 1920x1080" <<<"$hdo" && [[ $(ls cc/build/hd_ppm | wc -l) -eq 8 ]] && python - <<'PY' && echo "  ok  hd 1920x1080, 8 images, couleur profonde" || { echo "  ECHEC hd"; exit 1; }
import array
d = open("cc/build/hd_ppm/frame_00008.ppm", "rb").read()
p = d.split(b"\n", 3); w, h = map(int, p[1].split()); assert (w, h) == (1920, 1080) and p[2] == b"65535"
a = array.array("H"); a.frombytes(p[3]); a.byteswap()
row = a[(h - 10) * w * 3:(h - 9) * w * 3]
n = len(set(row[0::3])); print("  rampe grise :", n, "niveaux distincts sur une ligne (8 bits : 256 max)"); assert n > 256
PY
echo "== Reseau ternaire + Kleene"
(cd cc && python tri27cc.py examples/ternet.c -o build/ternet.tas && python tri27cc.py examples/kleene.c -o build/kleene.tas)
tn=$($VM run cc/build/ternet.tas 2>&1); grep -q "identique a la reference hote : 450/450" <<<"$tn" && echo "  ok  ternet 450/450" || { echo "  ECHEC ternet"; exit 1; }
kl=$($VM run cc/build/kleene.tas 2>&1); grep -q "0 erreur(s)" <<<"$kl" && echo "  ok  kleene 0 erreur" || { echo "  ECHEC kleene"; exit 1; }
echo "== Présentation PRESENT (wasm, node seul)"
pl="${TMPDIR:-/tmp}/present.$$"
node tests/present_snapshot.cjs >"$pl" 2>&1 && echo "  ok  present_snapshot ($(grep -c '^PASS' "$pl") vérifications)" || { cat "$pl"; echo "  ECHEC present_snapshot"; exit 1; }
if [[ "${1:-}" == "--web" ]]; then
  echo "== Web (Chrome headless + serveur :8124)"; ./build_web.sh >/dev/null
  curl -sf http://127.0.0.1:8124/web/ >/dev/null || { echo "  serveur :8124 absent (python -m http.server 8124 --directory .)"; exit 1; }
  CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
  prof=$(mktemp -d); "$CH" --headless=new --disable-gpu --no-first-run --remote-debugging-port=9231 --user-data-dir="$prof" about:blank >/dev/null 2>&1 &
  pid=$!; sleep 3
  fails=0
  for t in web_smoke desktop_smoke mouse_refresh hd_web; do
    if timeout 300 node tests/$t.cjs </dev/null; then echo "  ok  $t"; else echo "  ÉCHEC $t"; fails=1; break; fi
  done
  kill $pid 2>/dev/null || true
  [[ $fails -eq 0 ]] || exit 1
fi
echo "== tout est vert"
