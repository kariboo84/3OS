# TNA VM / 3OS – contrat d'exécution

## 1. Cible du projet
Le but n'est plus de bricoler un "jeu de démonstration", mais de disposer d'une chaîne complète :
- source C,
- compilation TNA,
- image binaire chargeable par 3OS,
- backend CPU interchangeable,
- exécution locale via interpréteur ou via backend GPU/FPGA.

Le backend JS sert de référence fonctionnelle. Le backend GPU/FPGA doit implémenter le même contrat d'exécution.

## 2. Contrat backend
Un backend TNA doit fournir :
- `reset(startPC)`
- `setPC(value)`
- `loadProgram(words, base)`
- `loadExecutable(executable)`
- `step()`
- `run(maxCycles)`
- `read(addr)` / `write(addr, value)`
- `snapshot()`
- `frameBuffer`

### États obligatoires
- `PC`, `SP`, `BP`
- flags `Z/N/G/L`
- RAM linéaire 32-bit signée
- framebuffer MMIO
- files audio / événements MMIO si supportés

## 3. ISA TNA v1
Chaque instruction occupe 3 mots 32-bit : `opcode, a, b`.

### Registres
- généraux : `R0..R11`
- pile : `SP`
- base frame : `BP`
- divers : `FLAGS`, `TMP`

### Mouvement / mémoire
- `MOV_REG`, `MOV_IMM`
- `LOAD`, `STORE`
- `LOADI`, `STOREI`
- `LEA`

### Arithmétique / logique
- `ADD`, `SUB`, `MUL`, `DIV`, `MOD`
- `ADDI`, `SUBI`, `MULI`, `DIVI`, `MODI`
- `AND`, `OR`, `XOR`, `NOT`
- `ANDI`, `ORI`, `XORI`
- `NEG`, `INC`, `DEC`
- `SHL`, `SHR`

### Contrôle
- `CMP`, `CMPI`, `TEST`, `TESTI`
- `JMP`, `JZ`, `JNZ`, `JG`, `JL`, `JGE`, `JLE`
- `PUSH`, `POP`, `CALL`, `RET`, `HALT`
- `SYSCALL`

## 4. ABI `tna-cdecl-v1`
- paramètres : passés sur pile, accessibles depuis `BP + 2 + n`
- retour : `R0`
- `BP` sauvegardé en entrée de fonction
- locaux : offsets négatifs depuis `BP`
- pile descendante
- globaux : segment `.data` à partir de `MMIO.DATA_BASE`

## 5. Memory map
- `0x0000` : input brut
- `0x0001..0x0002` : pointeurs input X/Y
- `0x0004` : boot flag
- `0x0008..0x0009` : ticks
- `0x000A..0x000E` : GPU command block
- `0x0010` : syscall mailbox
- `0x0100..0x0267` : table sinus
- `0x0268..0x03CF` : table cosinus
- `0x0800` : base programme / `.text`
- `0x2000` : base `.data`
- `0x4000` : heap
- `0xEFFF` : sommet pile initial
- `0xFE00` : clavier
- `0xFE10` : souris
- `0xFE20..0xFE22` : audio
- `0xFF00...` : framebuffer

## 6. Format binaire `TNA0`
Header little-endian :
- magic `TNA0`
- version `2`
- `entry`
- `textBase`
- `textWords`
- `dataBase`
- `dataWords`
- longueur chaîne ABI
- longueur méta JSON

Puis :
- chaîne ABI UTF-8
- JSON de métadonnées (link/imports éventuels)
- segment `.text` en `int32`
- segment `.data` en `int32`

Ce format est ce que 3OS charge désormais avec `boot <image.tna>`.

## 7. Backend GPU/FPGA
Le fichier `src/backends/gpu_fpga_backend.js` fixe le point d'intégration.
Le backend réel devra au minimum :
- prendre une image `TNA0`,
- l'écrire dans la mémoire visible du noyau GPU/FPGA,
- lancer le kernel CPU ternaire,
- rapatrier RAM partielle + registres + framebuffer,
- exposer le tout via `snapshot()`.

Autrement dit, 3OS et le compilateur n'ont plus besoin de connaître la manière dont le CPU est réellement exécuté.

## 8. État actuel
Livré maintenant :
- compilateur C→TNA du dépôt,
- format binaire stable,
- loader 3OS,
- backend d'interprétation,
- contrat backend GPU/FPGA,
- build + boot + run vérifiés sur `games/wolf3d.c`.

Pas livré :
- backend GPU/FPGA effectif,
- compatibilité binaire x86,
- port direct du source historique id Software complet.



## 8bis. Front-end C actuellement pris en charge
Le compilateur sait maintenant traiter, dans une seule unité de traduction :
- `#include` locaux, `#define`, `#undef`, `#if/#ifdef/#ifndef/#elif/#else/#endif`
- macros fonctionnelles simples `NAME(a, b)`
- prototypes de fonctions
- `typedef`, `enum`, `struct`, `union` nommés ou anonymes
- préprocesseur étendu: `#include`, `#define`, `#undef`, `#if/#ifdef/#ifndef/#elif/#else/#endif`, macros fonctionnelles, `#`, `##`, macros variadiques simples, ligne-continue `\`
- déclarateurs pointeurs, tableaux globaux/locaux, chaînes constantes
- qualificateurs Borland/DOS tolérés comme no-op : `near`, `far`, `huge`, `pascal`, `interrupt`
- casts C `(type)expr` et `(type *)expr`
- accès champs `.` et `->`
- `if/else`, `while`, `do/while`, `for`, `switch/case/default`, `goto`
- opérateurs `+= -= *= /= %= &= |= ^= <<= >>=`
- opérateur conditionnel `?:`, opérateur virgule, `sizeof(...)`
- pointeurs de fonctions, adresses de fonctions et appels indirects

Reste hors périmètre à ce stade :
- macros fonctionnelles avancées (`#`, `##`, variadiques)
- inline asm / `asm` Borland accepté comme no-op contrôlé côté front-end (non exécuté)
- layout mémoire DOS/Borland 16-bit réel du source historique Wolf3D

## GPU/FPGA bridge

The `gpu-fpga-emulator` backend now speaks a file-based bridge contract named `tna-gpu-fpga-bridge-v1`.

- input: JSON payload containing registers, MMIO, executable path, output path
- output: JSON payload containing registers, halted flag, RAM image, framebuffer, audio events
- default reference bridge: `tools/tna_gpu_bridge_ref.js`
- override command: env `TNA_GPU_BRIDGE` or `node src/main.js --backend gpu-fpga-emulator --bridge "<cmd>"`


## Step 4 additions
- ISA: `JMPR`, `CALLR` pour le contrôle de flux indirect.
- C subset: `goto`, labels, typedef de pointeurs de fonctions, appels indirects `fp(...)`, adresses de fonctions `&fn` / `fn`.
- Validation supplémentaire sur formes Wolf3D historiques: `void (*think)(),(*action)();`, `extern fixed far sintable[], far *costable;`, pointeurs de fonctions en champ de struct.

## Historical Wolf3D compilation

The compiler now supports a distinct **translation-unit codegen** mode for the original Wolf3D sources. In this mode, unresolved extern globals/functions are kept as typed imports so individual historical `.C` files can be lowered to TNA code before the final whole-program linker exists.

Key enablers added in this stage:
- typed extern globals preserved from headers
- imported function stubs emitted for undefined prototypes
- aggregate/string/pointer global initializers flattened later instead of too early
- pointer-to-struct dereference metadata preserved through casts/declarators
- pointer arithmetic scaled by pointee size
- local anonymous `enum { ... };` declarations accepted inside blocks

This is enough to code-generate multiple real Wolf3D translation units directly from the original tree.



## 6bis. Host imports runtime
Les unités historiques liées peuvent conserver des imports de fonctions hôte.
Le linker les remplace maintenant par des trampolines `.text` qui chargent un identifiant d'import puis déclenchent `SYSCALL HOST_IMPORT`.

Contrat d'exécution côté backend/interpréteur :
- l'image liée expose `meta.link.unresolvedFunctionImports`
- le runtime enregistre ces noms dans le même ordre
- `TMP` transporte l'identifiant d'import courant
- `R0` reçoit la valeur de retour
- les arguments restent sur pile selon `tna-cdecl-v1`

Le runtime de référence `src/runtime/host_runtime.js` couvre maintenant :
- mémoire/chaînes (`memcpy`, `memset`, `strcmp`, `strlen`, etc.)
- utilitaires libc (`abs`, `atoi`, `atol`, `isalpha`, `isdigit`, `isspace`, etc.)
- quelques hooks DOS/fichiers (`open`, `read`, `write`, `lseek`, `filelength`, etc.)
- nombreux hooks UI/audio/vidéo encore provisoires en **no-op contrôlé** pour laisser avancer l'image historique.
