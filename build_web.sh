#!/usr/bin/env bash
# Compile la VM TRI-27 en WebAssembly et la copie dans web/tri27.wasm.
# Usage : ./build_web.sh    puis : python -m http.server 8123  → http://localhost:8123/web/
set -euo pipefail
cd "$(dirname "$0")"
(cd tri27 && cargo build --release --target wasm32-unknown-unknown --lib)
cp tri27/target/wasm32-unknown-unknown/release/tri27.wasm web/tri27.wasm
# examples/index.json est maintenu à la main (format [{file,title}]).
ls -l web/tri27.wasm
