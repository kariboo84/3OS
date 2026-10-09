# 3OS — un ordinateur ternaire équilibré

**TRI-27** est une machine virtuelle ternaire : trits −1/0/+1, trytes de 9 trits, mots de 27 trits.
**3OS** est son système d'exploitation : bureau inspiré de Mac System 7, fenêtres grises et accents couleur TRGB, ou trois niveaux de gris TRIT.

Bureau direct : **http://127.0.0.1:8124/web/index.html?boot=3os** (serveur démarré ci-dessous). Banc d'essai (VM, éditeur de programmes) : http://127.0.0.1:8124/web/.
Clic pour sélectionner, double-clic / Entrée pour ouvrir ; C pour couleur/gris, F2 pour l'éditeur. Menus, fenêtres déplaçables et redimensionnables, défilement et lecture du vrai disque 3FS.
L'éditeur enregistre avec F2 ; Échap enregistre puis revient au bureau. Le navigateur conserve les modifications du disque.

- **Processeur** (`tri27/`, Rust, natif + WebAssembly) : 27 registres, pièges, modes noyau/utilisateur,
  protection mémoire UBASE/ULIMIT, accès périphériques contrôlé (IOPERM), `WFI`, son TSG-3, disque à secteurs.
  Logique de Kleene native (`min`/`max`/`tmul`/`cons`) et **`TDOT`** : produit scalaire de 27 trits en une instruction.
- **3OS** (`os/`) : noyau en C, processus isolés, ordonnanceur préemptif, appels système, système de fichiers 3FS
  (lecture/écriture), bureau graphique, éditeur de texte, Tetris.
- **Compilateur C** (`cc/`) : chibicc porté sur TRI-27, avec promotion en registres et branchements directs (34 tests chibicc).
- **Réseau de neurones 100 % ternaire** (`ternet/`, `cc/examples/chiffres.c`) : poids, entrées et activations dans {−1,0,+1},
  entraîné sur les chiffres manuscrits UCI (`load_digits`), 93,7 % sur le test. L'inférence sur la VM est identique
  à la référence hôte (450/450) et fait 12,9 fois moins d'instructions que la version scalaire, grâce à `TDOT`.

## Essayer

```sh
(cd tri27 && cargo build --release)
bash os/build.sh                        # noyau + disque os/3os.t3d
./build_web.sh                          # web/tri27.wasm
python -m http.server 8124              # puis http://127.0.0.1:8124/web/ → « 3OS v0.4 » → Lancer
```

En ligne de commande : `tri27/target/release/tri27 run os/kernel3.tas --disk os/3os.t3d`.

Vérification complète : `./check.sh` (ou `./check.sh --web` avec Chrome).

La spécification de l'ISA, du MMIO, de 3FS et des appels système est dans [`SPEC.md`](SPEC.md).
Le dossier `legacy/` contient l'ancien prototype JS, conservé pour mémoire mais **pas** réutilisé.
