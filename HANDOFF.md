# Reprise 3OS — état au 2026-10-06 (fin de quota Claude)

Charger d'abord le skill `tri27-3os`.

## Fait (commité)
- TRI-27 : SPEC, VM Rust (~300 M instr/s), assembleur, WASM + page web, son TSG-3, 3OS v0.1 (asm), chibicc porté (34/41 PASS), backend optimisé (b1698e8), Tetris en C.
- e52b96b (Sonnet) : VMODE=1 trit 576x360, souris MMIO (-10 X, -11 Y, -12 BTN), canvas adaptatif, fix doublon clavier.

## En cours, commité en WIP (NON vérifié) — retour arrière : `git reset --hard stable-avant-relais`
- SPEC.md, cc/include/tri27io.h, tri27/src/vm.rs, web/tri27.wasm : ajout VMODE=2 (TRGB 576x360) probablement partiel.
- cc/include/tgfx.h, cc/lib/tgfx.c : bibliothèque graphique C (mode trit/couleur), inachevée.
→ Relire `git diff`, terminer, vérifier, commiter.

## Reste de l'étape 2
1. Finir VMODE=2 (vm.rs render, main.rs --ppm, wasm, web canvas x2, SPEC §6, tri27io.h).
2. tgfx : tg_init(buf, mode), pixel/hline/vline/rect/fillrect (trame), tg_text police 5x7, tg_present ; pas de & | >> (émulés, lents) → tables de puissances de 3 ; trytes entiers quand 9 pixels alignés.
3. Démo cc/examples/system3.c : bureau façon System 7 en 3 niveaux (menus, fenêtres déplaçables, icônes, curseur), touche C → mode couleur. Compiler en examples/system3.tas, ajouter en tête de examples/index.json.
4. Vérifier : natif --ppm (+ --mouse si ajouté), Chrome headless CDP (souris, Tetris), `tri27 run examples/sieve.tas` = 9592, `cd cc && bash run_tests.sh` = 34 PASS.

## Ensuite
3OS v0.3 en C (système de fichiers, chargeur de programmes, processus) → bureau Système 3 + Finder → auto-hébergement de chibicc.
