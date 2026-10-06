#!/usr/bin/env bash
# Compile la VM TRI-27 en WebAssembly et la copie dans web/tri27.wasm.
# Usage : ./build_web.sh    puis : python -m http.server 8123  → http://localhost:8123/web/
set -euo pipefail
cd "$(dirname "$0")"
(cd tri27 && cargo build --release --target wasm32-unknown-unknown --lib)
cp tri27/target/wasm32-unknown-unknown/release/tri27.wasm web/tri27.wasm
# Liste optionnelle des exemples pour le sélecteur de la page web.
if ls examples/*.tas >/dev/null 2>&1; then
  python - examples <<'EOF' || true
import json, os, sys
d = sys.argv[1]
files = sorted(f for f in os.listdir(d) if f.endswith('.tas'))
json.dump(files, open(os.path.join(d, 'index.json'), 'w'), indent=1)
print('examples/index.json :', len(files), 'fichiers')
EOF
fi
ls -l web/tri27.wasm
