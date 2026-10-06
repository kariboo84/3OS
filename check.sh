#!/usr/bin/env bash
# check.sh — vérification complète de 3OS / TRI-27. Usage : ./check.sh [--web]
set -euo pipefail
cd "$(dirname "$0")"
VM=tri27/target/release/tri27
echo "== VM";        (cd tri27 && cargo build --release -q)
echo "== C : tests chibicc"; (cd cc && python run_tests.py | tail -1)
echo "== C : banc d'instructions"; python cc/perf.py
echo "== OS : noyau + disque"; bash os/build.sh >/dev/null 2>&1
out=$(timeout 120 $VM run os/kernel3.tas --disk os/3os.t3d --max 400000000 --input '2  dd  q    3    4      5' 2>&1)
for want in "tetris: score" "Hello from TRI-27" "primes <= 100000: 9592" "crash tue : faute memoire"; do
  grep -q "$want" <<<"$out" && echo "  ok  $want" || { echo "  ÉCHEC $want"; exit 1; }
done
$VM run examples/sieve.tas | grep -q 9592 && echo "  ok  crible asm"
$VM run os/kernel.tas --input 'trits 42\nhalt\n' | grep -q "42 =" && echo "  ok  noyau v0.1"
if [[ "${1:-}" == "--web" ]]; then
  echo "== Web"; ./build_web.sh >/dev/null
  curl -sf -o /dev/null http://127.0.0.1:8124/web/ || { echo "  serveur :8124 absent (python -m http.server 8124 --directory .)"; exit 1; }
  CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
  prof=$(mktemp -d); "$CH" --headless=new --disable-gpu --no-first-run --remote-debugging-port=9231 --user-data-dir="$prof" about:blank >/dev/null 2>&1 &
  pid=$!; sleep 3
  res=$(timeout 120 node tests/web_smoke.cjs </dev/null || true); kill $pid 2>/dev/null || true
  echo "$res"
  grep -q "exceptions 0" <<<"$res" && grep -q "après clic tetris : écran 320x200" <<<"$res" && grep -q "crash tue" <<<"$res" && echo "  ok  web" || { echo "  ÉCHEC web"; exit 1; }
fi
echo "== tout est vert"
