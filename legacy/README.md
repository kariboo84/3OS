# TNA-VM — Wolfenstein 3D sur architecture ternaire

VM ternaire 32-bit avec compilateur C→TNA, format binaire TNA0, et backend GPU/FPGA.
Objectif : faire tourner le **vrai source Wolfenstein 3D** (id Software) sur CPU ternaire via émulation GPU.

## Lancer

```bash
node src/main.js                           # interpréteur, cible auto
node src/main.js --boot official           # source WL6 officiel compilé
node src/main.js --boot bridge             # cible la plus interactive
node src/main.js --backend gpu-fpga-emulator --boot official
npm run web-ui                             # interface web canvas
```

## Structure

```
src/
  config.js              ISA, ABI, MMIO, couleurs
  core/cpu.js            CPU ternaire
  compiler/
    assembler.js         Assembleur TNA
    c_transpiler.js      Compilateur C→TNA
    linker.js            Linker multi-unités
  runtime/
    ternary_vm.js        Runtime VM + loader TNA0
    executable.js        Format binaire TNA0
    host_runtime.js      Bridge hôte (libc, DOS stubs)
    wolf_asset_import.js Import assets WL6
  backends/
    interpreter_backend.js   Backend JS de référence
    gpu_fpga_backend.js      Contrat backend GPU/FPGA
  web/
    vm_http_server.js    Serveur HTTP
    vm_controller.js     Contrôleur canvas/clavier
  devices/gpu.js         Périphérique GPU MMIO
  main.js                Point d'entrée

3OS.js                   Shell ternaire unifié
serve_vm.js              Serveur web UI
web/index.html           Canvas + boutons
web/app.js               Frontend JS

build/
  wolf3d_historical_official.tna   Wolf3D officiel compilé TNA
  wolf3d_historical_bridge.tna     Bridge interactif (le plus visuel)

assets/wolf3d/raw/       Données WL6 officielles (VSWAP, GAMEMAPS, etc.)
historical_wolf3d_official/WOLFSRC/  Source C original id Software

tools/tna_gpu_bridge_ref.js  Bridge GPU de référence (JSON I/O)
```

## Backends

- `interpreter` (défaut) — exécution JS locale, rapide à valider
- `gpu-fpga-emulator` — délègue via bridge JSON vers `tools/tna_gpu_bridge_ref.js`
  - remplacer par un vrai kernel GPU/FPGA : `TNA_GPU_BRIDGE="mon-kernel"` ou `--bridge "cmd"`

## Contrat backend GPU/FPGA

Un backend doit implémenter : `reset`, `loadExecutable`, `run(maxCycles)`, `step`, `read/write`, `snapshot`.
Le bridge reçoit un JSON `tna-gpu-fpga-bridge-v1` avec l'exécutable `.tna`, les registres et MMIO.
Il retourne registres, RAM partielle, framebuffer et événements audio.

## Mémoire

| Adresse     | Usage              |
|-------------|---------------------|
| 0x0100      | Table sinus         |
| 0x0268      | Table cosinus       |
| 0x0800      | .text (programme)   |
| 0x2000      | .data (globaux)     |
| 0x4000      | Heap                |
| 0xEFFF      | Sommet pile         |
| 0xFE00      | Clavier MMIO        |
| 0xFE10      | Souris MMIO         |
| 0xFE20-22   | Audio MMIO          |
| 0xFF00…     | Framebuffer (160×120)|
