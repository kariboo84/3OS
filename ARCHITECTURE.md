# TRI-27 — Feuille de route d'architecture (au-delà de v0.4)

Statut : **feuille de route et état d'avancement**. `SPEC.md` reste la référence de ce qui existe.
Les sections techniques décrivent aussi des propositions : leur présence ici ne prouve pas une implémentation.

## État réel et prochaines étapes

Le code courant du bureau est dans le worktree `3OS-wt/desktop` (branche `feat/desktop-res`).
La branche principale contient la banque vectorielle, mais pas encore les évolutions du bureau de ce worktree.

| Domaine | État réel | Restant |
|---|---|---|
| VM Rust/WASM, compilateur C, noyau préemptif, isolation, disque 3FS | Livrés, suites maintenues ; filesize exact sans lecture de contenu | Auto-hébergement du compilateur ; fichiers créables/supprimables et lecture par plages |
| RAM | Allocation creuse dynamique, taille configurable | **Pas encore de mémoire virtuelle paginée ni de TLB** : les pages d'allocation hôte ne sont pas la pagination guest |
| Vecteurs v0.5 | Banque 27 × 27 trytes, VL, intrinsèques C, sauvegarde noyau et TerNet | Référence effective : SPEC, pas toutes les idées du §1 ; gain mesuré TerNet contre TDOT |
| Graphique | GPU 2D MMIO, framebuffer natif, 576×360 / 720p / 1080p, profondeurs 1/9/27 | Pas de pipeline 3D, shaders, textures filtrées ni accélérateur hôte 3D |
| Bureau | Platinum/System 7–8, polices AA guest, logo de chargement, Finder, réglages 3FS, fenêtres/raccourcis/plein écran ; parcours navigateur validés | Fusion du worktree ; enrichissements d'applications distincts de l'ISA |
| Images | Bibliothèque C timage : PNG via LodePNG, BMP et PPM ; fichiers binaires 3FS ; visualiseur 1:1 | JPEG/GIF/WebP non implémentés ; vrais malloc/free et fichiers par plages pour grandes images |
| Chromium / YouTube | Application 3OS avec composant Chromium hôte déclaré choisie, mais **non implémentée** | Intégration et parcours réel à construire ; pas un navigateur guest autonome |
| Réels tekum v0.6 | Conception (§2) | Codec logiciel de référence, tests d'arrondi/ulp puis décision ISA |
| Timing, SPM, DMA v0.7 | Conception (§3, §7) | Modèle de cycles, latences, transferts et preuve de double tampon |
| Pagination/étiquettes v0.8 | Conception (§4) | Tables de pages, TLB, fautes, étiquettes et prise en charge noyau |
| Compression mémoire | Bibliographie/propositions (§7 bis) | Mesures sur vrais instantanés ; aucun taux de compression promis |
| TNPU v0.9 | Conception (§8) | Noyaux GPU et modèle réel avec égalité CPU ; TerNet n'est pas un LLM |
| JIT / multicœur / ECC / FPGA | Non implémentés | Étapes indépendantes, avec budgets et preuves avant extension |

**Ordre conseillé pour la machine utilisable** : terminer/fusionner le bureau et les images,
puis renforcer 3FS + l'allocateur ; ensuite JIT mesuré pour accélérer le logiciel.
**Ordre architectural de recherche** : vecteurs livrés → tekum → timing/SPM/DMA → pagination → TNPU.
Le JIT reste une accélération hôte, pas une évolution du matériel ternaire ; le FPGA suit sa propre piste.
Sources et plan détaillé ci-dessous (§12).

---

## 0. Principes

1. **Visible vs invisible.**
   - *Visible* (ISA, carte mémoire, CSR) : change le code, se mesure tout de suite dans la VM.
   - *Invisible* (caches, prédicteur, pipeline, bus) : n'existe pas dans une VM (la mémoire est la RAM de l'hôte).
     Ne s'évalue que dans un **modèle de timing** (§7) ou un futur Verilog. Aucune taille de cache choisie sans mesure.
2. **La VM Rust est le modèle de référence.** JIT, Verilog, GPU : état identique trit pour trit sur `check.sh`.
3. **Le vrai argument du ternaire est la densité d'information par fil et par cellule, pas l'ALU.**
   Un additionneur ternaire coûte ~62 % de circuit en plus à information égale (Jones) ; en revanche 1 trit = 1,58 bit par
   symbole transmis ou stocké, ce qui compte face au *mur mémoire* (Hunhold). L'industrie va déjà dans ce sens côté
   transmission : GDDR7 et Ethernet automobile 100BASE-T1 utilisent la signalisation 3 niveaux PAM3.
   ⇒ L'architecture privilégie : bande passante mémoire, formats compacts, opérations natives ternaires (IA, logique 3 états).
4. **Ne pas réinventer ce qui existe** : formats réels ternaires publiés (§2), ISA ternaire publiée (REBEL-6),
   formats et noyaux BitNet existants (§8). On adopte, on adapte, on cite.
5. **Chaque étape a un critère d'arrêt** : pas de gain mesuré → on s'arrête et on le dit.

### Réservation historique v0.4 (pas la carte mémoire actuelle)

Ces plages étaient celles de la proposition initiale. Vecteurs, MMIO vidéo et GPU 2D
en occupent désormais une partie : consulter **SPEC.md** et `tri27/src/isa.rs` avant
d’ajouter un opcode ou un périphérique ; ne pas réutiliser les plages « libres » ci-dessous.

| Ressource | Occupé (v0.4) | Libre |
|---|---|---|
| Opcodes (5 trits, −121…+121) | 1–41, 45, 50–52 | 42–44, 46–49, 53–121, **tous les négatifs** |
| CSR | 0–12 | ≥ 13 |
| MMIO | −1…−13, −20…−24, TSG −100…−180 | −14…−19, −25…−99, ≤ −181 |

**Les extensions vivent dans les opcodes négatifs** ; la base v0.4 reste positive (lisible d'un coup d'œil dans un dump).

| Opcodes | Extension |
|---|---|
| −1 … −40 | Vecteurs (§1) |
| −41 … −70 | Réels tekum (§2) |
| −71 … −80 | Atomiques / barrières (§9) |
| −81 … −90 | Étiquettes mémoire, préchargement, gestion de cache (§4, §7) |
| −91 … −121 | Réserve |

### Unités de taille (un seul jeu de nombres partout)

| Unité | Taille | Équivalent binaire | Rôle |
|---|---|---|---|
| tryte | 9 trits | ≈ 14,3 bits | `char`, pixel, réel court tekum8 + 1 trit (§2) |
| mot | 27 trits | ≈ 42,8 bits | `int`, pointeur, réel tekum26 + 1 trit (§2) |
| **bloc** | 27 trytes = 243 trits | ≈ 385 bits ≈ 48 octets (ligne de cache x86 : 64 o) | registre vectoriel, ligne de cache, grain DMA |
| **page** | 729 trytes = 27 blocs | ≈ 1,3 Ko (x86 : 4 Ko) | page virtuelle = secteur disque = table de pages = sauvegarde des 27 registres vectoriels |

---

## 1. Vecteurs ternaires — v0.5

**Pourquoi** : logique trit à trit et produits ternaires sur 243 trits par instruction ; base du chemin IA côté CPU.

- **27 registres vectoriels** `v−13 … v+13` : même champ de 3 trits que les registres entiers, format R inchangé.
  27 × 27 trytes = **729 trytes = exactement une page** (changement de contexte = 1 copie de page).
- `v0` = registre de **masque ternaire** par défaut (convention RISC-V V).
- Trois vues : 243 trits / 27 trytes / 9 mots.
- **Longueur active** `VSETVL rd, rs1` (CSR `VL`) : traite les fins de boucle sans code de reste (modèle RISC-V V).
  Longueur maximale fixe (1 bloc) en v0.5 ; le CSR permet d'élargir plus tard sans changer les binaires.

| Instruction | Effet |
|---|---|
| `VSETVL` | fixe la longueur active |
| `VLD` / `VST` (+ variantes à pas `VLDS`/`VSTS`) | bloc ↔ mémoire |
| `VADD/VSUB/VMUL .T/.W` | 27 voies tryte / 9 voies mot (débordement : modulo ou saturé, à trancher) |
| `VMIN VMAX VTMUL VCONS VANY VNEG` | logique ternaire sur 243 trits |
| `VSEL vd, vm, va, vb` | **sélection à 3 voies par trit de masque** : −1 → a, 0 → garde vd, +1 → b |
| `VCMP.T/.W` | comparaisons à 3 issues → masque ternaire |
| `VMATCH rd, va, vpat` | **recherche avec joker** : trit 0 du motif = « peu importe » (principe des mémoires TCAM des routeurs, natif ici) |
| `VTDOT rd, va, vb` | Σ aᵢ·bᵢ sur 243 trits → scalaire |
| `VTMAC.T rd, va, vb` | Σ tryteᵢ × tritᵢ : activations × poids ternaires (noyau BitNet) |
| `VLUT vd, vtable, vidx` | **table de correspondance par voie** (≈ `pshufb` x86 / `tbl` ARM) : base des noyaux IA par tables (bitnet.cpp TL1/TL2) |
| `VSUM.T/.W` `VSPLAT.T/.W` | réduction, diffusion |
| `VFADD/VFMUL/VFMA .8/.26` | réels tekum par voie (après §2) |

**Saut des zéros** : le coût de `VTDOT`/`VTMAC` dans le modèle de timing dépend du nombre de trits non nuls.

**Preuve** : `ternet` et le blit de Tetris réécrits avec intrinsèques C ; `check.sh` vert ; `ternet` identique au trit près ;
instructions exécutées avant/après. Arrêt si gain faible sur `ternet`.

---

## 2. Nombres réels ternaires — v0.6

**Ne pas inventer de format** : deux propositions publiées existent.

| Format | Principe | Points forts | Limite |
|---|---|---|---|
| **ternary27** (O'Hare, v3.1) | 27 trits : type 2 + signe 1 + exposant 5 + significande 19 ; ±6,6e−70 … ±8,1e57 | type = exact / arrondi vers le haut / vers le bas (encadrement gratuit de la vraie valeur) ; sous-normaux étendus : la différence de deux normaux distincts ne vaut jamais 0 | format classique à la IEEE, nombreux cas spéciaux |
| **tekum** (Hunhold, 2025) | précision effilée façon posit/takum, en ternaire équilibré | ∞ **et** NaR ; **négation = inversion des trits** ; **troncature = arrondi au plus proche** (pas de double arrondi, pas de retenue d'arrondi) ; **ordre identique aux entiers** : `CMP`/`BR3` comparent des réels sans matériel dédié ; à information égale, zone de précision ≥ float32/bfloat16 plus large ; dynamique ≈ 10^±87 | **défini seulement pour un nombre pair de trits** |

**Proposition : tekum + 1 trit d'exactitude** (combinaison maison, à valider) :
- **mot = tekum26 + 1 trit** ; **tryte = tekum8 + 1 trit**.
- Le trit libre reprend l'idée de ternary27 : +1 arrondi vers le haut, 0 exact, −1 arrondi vers le bas.
- tekum8 (≈ 12,7 bits) = format court pour l'IA et les vecteurs (27 voies par bloc) ;
  **réduire la précision = tronquer** (propriété de tekum) → conversions 26 → 8 quasi gratuites.
- `FCMP` inutile : la comparaison entière fonctionne (monotonie de tekum) ; seule la place de NaR demande une convention.

**Ordre** : (1) bibliothèque logicielle dans `cc` + tests contre une implémentation de référence sur l'hôte ;
(2) instructions `FADD FSUB FMUL FDIV FSQRT FMA FCVT` ; (3) versions vectorielles.

**Preuve** : erreur mesurée (ulp) sur une batterie de cas, ternary27 vs tekum sur le même banc ;
un programme réel (démo 3D ou physique). Arrêt : si tekum ne bat pas ternary27 sur notre banc, on prend ternary27.

---

## 3. Mémoire embarquée (scratchpad) + DMA — v0.7

**Pourquoi** : mémoire rapide **gérée par le programme** (local store du Cell, TCM des DSP) : déterministe, sans
problème de cohérence en multicœur, **partagée avec l'accélérateur IA** (§8).

- Fenêtre SPM à adresse fixe, taille dans un CSR (taille décidée par §7).
- **Moteur DMA** (MMIO −25…−99) : source, destination, nombre de blocs, pas, commande, statut, interruption de fin ;
  tourne en parallèle du CPU dans le modèle de timing.
- Le noyau attribue la SPM au processus de premier plan (comme `IOPERM`) et la sauvegarde au changement de contexte.

**Preuve** : `ternet` en double tampon (DMA charge le bloc suivant pendant le calcul) ; cycles virtuels avant/après (§7).

---

## 4. Pagination + étiquettes mémoire — v0.8

### Pagination
- **Page = 729 trytes = 1 secteur disque** → swap et chargement de programmes triviaux.
- **Table = 243 entrées d'1 mot = 729 trytes = exactement 1 page** (comme x86-64 : 512 × 8 o = 4 Ko).
- **Adresse virtuelle 21 trits** = 6 (décalage) + 3 niveaux × 5 trits → 3²¹ ≈ 1,05 × 10¹⁰ trytes (≈ 18 Go équivalent).
  Les 6 trits hauts du pointeur restent libres (couleur des étiquettes, ci-dessous).
- **Grandes pages** : 3¹¹ trytes (niveau 2) et 3¹⁶ trytes (niveau 3) — compensent la petite taille de page pour le TLB.
- Entrée de table : numéro de page physique + présence + R/W/X + accédé/modifié + global.
- CSR `PTBR` (racine), `PGON` ; UBASE/ULIMIT conservés quand la pagination est coupée (compatibilité v0.4).
- TLB = microarchitecture (§7).

### Étiquettes mémoire (sécurité mémoire matérielle)
Modèle « serrure et clé » d'ARM MTE (4 bits pour 16 octets), adapté au ternaire :

- **Grain = 9 trytes** (3 mots). Par grain : **1 trit d'état + 3 trits de couleur** = 4 trits pour 81 → **surcoût ≈ 4,9 %**
  (MTE : ≈ 3,1 %).
- **État** : +1 vivant / 0 jamais écrit / −1 libéré. Lecture d'un grain à 0 → piège optionnel (non initialisé) ;
  accès à −1 → piège (use-after-free).
- **Couleur** : 27 valeurs (MTE : 16), aussi portée par les trits hauts du pointeur ; accès autorisé si les couleurs
  concordent. Corrige la faiblesse de l'état seul : après réallocation, l'ancien pointeur a une autre couleur → piégé.
- `TAGSET` / `TAGGET` (opcodes −81…) pour `malloc`/`free` ; `STW`/`STT` posent l'état +1.
- **Piège propre au ternaire équilibré** : le signe d'un nombre = son trit non nul le plus fort, donc des trits de couleur
  rendraient un pointeur **négatif** (= zone MMIO en v0.4). Règle : le matériel retire la couleur **avant** tout décodage
  d'adresse ; MMIO = couleur 0 ; comparer avec `<` deux pointeurs de couleurs différentes est indéfini (comme MTE).

**Preuve** : programmes de test (use-after-free, débordement, lecture non initialisée) détectés ; 3OS complet tourne
pagination + étiquettes actives ; surcoût mesuré (§7).

---

## 5. Correction d'erreurs (ECC)

Matériel futur ; dans la VM : démonstration par injection d'erreurs uniquement.
(La GDDR7 intègre déjà une ECC sur la puce : c'est devenu standard.)

| Code | Paramètres | Corrige | Surcoût | Usage |
|---|---|---|---|---|
| **Hamming ternaire raccourci** | [31, 27, 3] : 27 trits + 4 de contrôle | 1 trit faux par mot | 15 % | mémoire principale (≈ SECDED binaire 72/64, 12,5 %) |
| **Golay ternaire** | [11, 6, 5], code parfait | 2 trits faux par bloc de 6 | 83 % | données critiques seulement (trop cher en général) |

**Preuve (VM)** : `--inject-faults` : erreurs aléatoires sur les trits stockés, compteurs corrigées / non corrigées.

---

## 6. Bus et technologie ternaires

- **Bus** : 1 trit par symbole PAM3 (signalisation déjà industrielle : GDDR7, 100BASE-T1).
- **Mémoire ternaire** : cellules SRAM ternaires étudiées en recherche (transistors à nanotubes de carbone, CNTFET).
- **Logique** : CMOS ternaire fabriqué sur plaquette démontré (UNIST, *Nature Electronics* 2019) ;
  brevet Huawei de porte logique ternaire (CN119652311A).
- **Pour nous** : VM → sans objet ; FPGA → broches binaires, 1 trit = 2 bits en interne ; PAM3 réel = interface analogique,
  hors périmètre. Section conservée comme justification, pas comme chantier.

---

## 7. Modèle de timing (microarchitecture) — avec v0.7

**Pourquoi** : choisir caches, prédicteur, SPM, TLB sur mesures (méthode des simulateurs gem5 / ChampSim).

- Option de la VM (`--features timing`), désactivée par défaut, sans effet sur l'exécution fonctionnelle.
- **Cycles virtuels** + rapport : défauts par niveau, mauvaises prédictions, attentes mémoire, défauts TLB.
- Charges : démarrage de 3OS, Tetris (N images), `ternet`, compilation d'un programme.

| Élément | Paramètres (configurables, valeurs à calibrer) |
|---|---|
| Tampon de boucle (L0) | nombre d'instructions |
| L1 I / L1 D séparés | taille, associativité, latence |
| L2 unifié | taille, associativité, latence, inclusif ou non |
| Ligne | 1 bloc (27 trytes) |
| **Lignes nulles** | une ligne entièrement à 0 stockée comme 1 indicateur (le 0 est fréquent en ternaire équilibré : mémoire vierge, poids creux) — gain de débit à mesurer |
| Préchargeur | séquentiel / à pas |
| RAM | latence, débit |
| SPM | latence fixe |
| TLB | entrées, grandes pages, coût du parcours de table |
| **Prédicteur de branchement** | type TAGE pour les branchements à 2 issues ; **prédicteur à 3 issues pour `BR3`** (négatif / nul / positif). REBEL-6 a aussi un branchement à 3 voies ; pas trouvé d'étude publiée d'un prédicteur à 3 issues — à vérifier |
| Pipeline | profondeur → pénalité de mauvaise prédiction |

**Preuve** : rapports reproductibles ; au moins une décision prise sur mesure (taille L1, SPM vs cache seul,
prédicteur 3 voies vs 2, lignes nulles oui/non).

---

## 7 bis. Mémoire compressée multi-échelle (« Tetris de la mémoire ») — piste de recherche

**Idée** : organiser la mémoire pour qu'elle se compresse d'elle-même, avec la même règle à chaque échelle
(tryte → bloc → page), à la manière d'une fractale.

**Limite dure** : aucune disposition ne compresse des données quelconques (principe des tiroirs). La disposition ne fait que
**rendre visible** la redondance déjà présente (zéros, répétitions, valeurs proches) — abondante dans la mémoire réelle
d'un programme.

### État de l'art (vérifié)

| Technique | Principe | Résultat publié | Ce qu'on en retient |
|---|---|---|---|
| Courbes remplissantes (Z/Morton, Hilbert) | rangement qui garde la proximité 2D/3D à toutes les échelles ; utilisé pour les textures GPU | localité de cache, pas de compression | à garder pour framebuffer et matrices |
| **Courbe de Peano** | même principe, **découpage 3 × 3, nativement ternaire** | idem | bloc de 27 trytes = cube 3×3×3 ; récursif |
| Base-Delta-Immediate (2012) | ligne = base + petits écarts | référence de la compression de cache | étage simple, faible latence |
| **Bit-Plane Compression** (ISCA 2016) | écarts entre mots voisins, puis transposition en **plans de bits** : les plans hauts deviennent nuls | **4,1:1** entiers, **1,9:1** flottants | **meilleur que base + écarts** → version ternaire : **plans de trits** |
| **Thesaurus** (ASPLOS 2020) | regroupe les lignes **presque** identiques (base commune + différence), pas seulement identiques | **2,25×** (moyenne géométrique) | **meilleur que la déduplication exacte** |
| HICAMP (ASPLOS 2012) | mémoire = arbre de lignes uniques (contenu adressé), ligne nulle gratuite | fonctionnel ; jamais commercialisé (indirection à chaque accès, copie à chaque écriture) | modèle hiérarchique de référence, trop coûteux tel quel |
| Linearly Compressed Pages (MICRO 2013) | toutes les lignes d'une page compressées à la **même taille** → adresse calculée sans table | +62 % capacité, −24 % bande passante, +13,9 % perf. | **résout le vrai « Tetris »** : retrouver un bloc compressé sans indirection |
| Compresso (MICRO 2018), CRAM (2018) | compression de la mémoire principale réaliste (métadonnées, débordements) | — | coût des métadonnées = le vrai problème |
| Compression par objets (Zippads, ASPLOS 2019) | compresse des objets entiers plutôt que des lignes | — | piste si 3OS expose ses objets (allocateur) |
| GPU : Delta Color Compression, HTILE (AMD) | compression hiérarchique par tuiles du framebuffer et du Z | **commercial** | preuve industrielle que le multi-échelle marche sur l'image |
| TRACE (2025) | compression + précision réduite sur mémoire CXL pour les LLM | — | à relire pour le TNPU (§8) |

**Conclusion** : le schéma « zéros + doublons exacts + base/écarts » proposé au départ est **dépassé**. Le meilleur
assemblage connu : **plans de bits (BPC) + regroupement de lignes presque identiques (Thesaurus) + taille fixe par page (LCP)**.
Le vrai « Tetris » n'est pas de compresser mais de **ranger des blocs de tailles variables en les retrouvant sans
indirection** : c'est ce que LCP résout.

### Avantage ternaire (à mesurer)
- En ternaire équilibré, une **petite valeur, positive ou négative, a ses trits hauts à 0**. En binaire (complément à deux),
  un petit négatif commence par des 1 et casse la compression des zéros ; BPC doit ajouter des transformations pour
  le compenser. Chez nous, les écarts sont symétriques par nature → **plans de trits hauts nuls** plus souvent.
- Le trit nul sert de « vide » naturel (mémoire vierge, poids creux BitNet).

### Schéma TRI-27 proposé (même règle à chaque échelle)
1. **Bloc nul** → indicateur seul.
2. **Bloc** → écarts entre mots voisins + transposition en **plans de trits** (BPC ternaire) ; plans nuls supprimés.
3. **Bloc presque identique à un autre** → référence + différence (Thesaurus).
4. **Page** : blocs compressés à taille fixe (LCP) ; page entièrement compressible → compressée à son tour.
5. **Images et matrices** rangées en ordre de Peano (3 × 3 × 3).

### Preuve, avant toute modification de la VM
Script hors VM sur des **images mémoire réelles** (démarrage 3OS, Tetris en cours, `ternet`) : taux de compression par
étage (zéros, base/écarts, BPC ternaire, Thesaurus, LCP, arbre complet), **comparé au même contenu encodé en binaire**.
**Arrêt** : si le gain ternaire vs binaire est négligeable, la piste reste un document.
Si c'est concluant : implémentation dans le modèle de timing (§7) pour mesurer le débit mémoire gagné.

---

## 8. Accélérateur IA ternaire sur GPU (TNPU) — v0.9

Le CPU TRI-27 reste sur le CPU hôte (un flux séquentiel plein de branchements est un mauvais cas pour un GPU).
Le GPU sert de **coprocesseur**, comme une carte d'extension.

- Périphérique MMIO (≤ −181) : file de commandes en RAM ou SPM, sonnette, interruption de fin.
- Commandes à gros grain : produit matrice-vecteur poids ternaires × activations (trytes ou tekum8), convolutions,
  éventuellement blit graphique.
- **Formats de poids existants à réutiliser côté hôte** : llama.cpp `TQ1_0` (5 trits par octet, 3⁵ = 243 ≤ 256,
  1,69 bit/poids) et `TQ2_0` (≈ 2,06 bits/poids) ; noyaux bitnet.cpp (I2_S, TL1, TL2 par tables).
  Côté TRI-27 : poids rangés en blocs de 243 trits, sans aucune perte (le trit est natif).
- Backends : CUDA (via le gpu_broker Hermes) et WebGPU (navigateur).
- Objectif : un petit modèle **BitNet b1.58** (poids ∈ {−1, 0, +1}) qui génère du texte dans 3OS.
- **Alternative CPU** (sans GPU) : instructions de tuiles matricielles façon Intel AMX / ARM SME (`TMMA` sur tuiles de
  9 × 9 mots). À évaluer contre §1 (`VTMAC`/`VLUT`) avec le modèle de timing.

**Preuve** : sortie identique au chemin CPU (`VTMAC`) au trit près ; débit mesuré ; génération de texte dans 3OS.

---

## 9. Plus tard (selon budget)

### JIT dans la VM (vitesse brute)
- Traduit les blocs TRI-27 en code natif hôte ; ISA inchangée.
- Compatible étiquettes (§4) et timing (§7) : vérifications émises ou JIT coupé.
- **Preuve** : instructions/s avant/après ; `check.sh` identique.

### Multicœur
- Atomiques (`LR/SC` + opérations atomiques façon RISC-V « A », opcodes −71…), barrières, **modèle mémoire écrit**,
  cohérence MESI dans le modèle de timing, noyau SMP (verrous, ordonnanceur par cœur). La SPM (§3) évite la cohérence
  pour les données privées.
- **Preuve** : 2 processus 3OS sur 2 cœurs, accélération mesurée, pas de corruption sous charge.

### Calcul réversible
- Intérêt réel = énergie (limite de Landauer) → **nul dans une VM**. Seul usage concret : débogueur à exécution inverse.
  Non prioritaire.

### Verilog / FPGA
- Voir §9 bis.

---

## 9 bis. Cible FPGA (horizon) — passe technologique

### Rôle du FPGA (sans illusion)
- **Ce qu'il prouve** : l'ISA est implémentable en matériel, 3OS démarre sur une vraie puce, coût en ressources mesuré.
- **Ce qu'il ne prouve pas** : la supériorité du ternaire. Un FPGA est un tissu **binaire** (LUT, chaînes de retenue rapides,
  multiplieurs binaires) : un chemin de données ternaire y sera plus gros et plus lent que son équivalent binaire.
- **Exception notable** : l'IA à poids ternaires, où le FPGA est réellement compétitif (multiplications supprimées, cf. TeLLMe).

### Cartes cibles (chaîne libre Yosys + nextpnr)

| Carte | Puce | Logique | Mémoire interne | Mémoire externe | Verdict |
|---|---|---|---|---|---|
| Tang Nano 9K | Gowin GW1NR-9 | 8 640 LUT4, 20 mult. 18×18 | 468 Kbit BSRAM (26 blocs) | 64 Mbit PSRAM | probablement trop juste au-delà du cœur scalaire |
| **Tang Nano 20K** (~25 $) | Gowin GW2AR-18 | 20 736 LUT4, 15 552 FF | 828 Kbit BSRAM | 64 Mbit SDRAM, sortie HDMI | **cible principale proposée** |
| ULX3S | Lattice ECP5-85F | ~85 K LUT | — | SDRAM | si la 20K ne suffit pas ; **chaîne libre la plus mûre** (Trellis) |

Support Gowin dans la chaîne libre (Apicula) : bon mais encore en maturation ; ECP5 : excellent.
Tailles finales = mesure par synthèse Yosys, **avant** tout achat.

### Décision n°1 — codage des trits dans le tissu (à trancher par synthèse, sans carte)

| Codage | Avantages | Inconvénients |
|---|---|---|
| **Double rail** (2 bits : +1 = 10, −1 = 01, 0 = 00) | `NEG` = croisement de fils (gratuit) ; `MIN/MAX/CONS/TMUL`, plans de trits, étiquettes, troncature tekum : logique locale bon marché ; code 11 interdit → **détection d'erreur gratuite** | addition ternaire sans chaîne de retenue native → plus lente/grosse |
| Binaire interne (complément à deux 43 bits, comme la VM en i64) | addition/multiplication sur chaînes de retenue et multiplieurs câblés | opérations trit à trit, `SHT`, `TSUM`, vecteurs : conversion en base 3 coûteuse |
| Hybride | double rail partout, conversion vers binaire seulement pour `MUL/DIV` (multiplieurs câblés) | deux convertisseurs à payer |

Propriété utile : en ternaire équilibré, les **produits partiels d'une multiplication sont gratuits** (trit × mot = +mot, 0
ou −mot) → multiplication = arbre d'additions, sans multiplieur câblé. À comparer à la voie « conversion + multiplieur ».
**Recommandation de départ** : double rail (l'ISA est centrée trit : vecteurs, étiquettes, compression, tekum), puis
mesure des 3 variantes d'ALU (LUT, fréquence) par Yosys. Référence : Parhami, codages binaires du ternaire équilibré.

### Décision n°2 — adresses ternaires, mémoires binaires
Les BSRAM et la SDRAM sont indexées en binaire : convertir une adresse de 27 trits à chaque accès coûte une chaîne d'additions.
- Option A : convertisseur pipeliné (simple, ajoute de la latence).
- Option B : **conversion faite une fois par la traduction d'adresse** : le TLB stocke le numéro de cadre physique déjà en
  binaire ; le décalage de 6 trits (729 valeurs) se convertit par une petite table. ⇒ la pagination (v0.8) simplifie le FPGA.
- Cadres de 729 trytes : placement dense (cadre × 729 = quelques additions constantes) ou cadres de 1 024 entrées
  (direct, mais 29 % perdus). À trancher par mesure.

### Décision n°3 — stockage
- **BSRAM Gowin (18 Kbit, largeurs 9/18/36 bits)** : en double rail, **1 tryte = 18 bits = 1 entrée** et 1 mot = 54 bits
  = 3 entrées → **aucun bit perdu** en mémoire interne.
- **Mémoire externe** : 2 bits/trit gaspille ~26 % par rapport à l'optimum (1,58 bit). Le contrôleur mémoire peut
  **compacter 5 trits par octet** (comme `TQ1_0`) avec deux petites tables (243 et 256 entrées) → −20 % de bits transférés.
  La bande passante externe étant le goulot de ces cartes, c'est le meilleur levier de performance, et il rejoint §7 bis
  (la transposition en plans de trits est du **pur câblage** en matériel).

### Revue des fonctions de ce document

| Fonction | FPGA | Commentaire |
|---|---|---|
| ISA de base v0.4 | ✅ | cœur scalaire multicycle d'abord, pipeline ensuite |
| `MUL` / `DIV` | ✅ | multicycle ; `MUL` par arbre d'additions ou multiplieurs câblés (mesure) |
| Vecteurs (§1) | ⚠️ | ISA inchangée, **micro-architecture étroite** (ex. 1 mot/cycle, 9 cycles/instruction) grâce à `VSETVL` ; logique trit à trit bon marché ; `VTDOT/VTMAC` = arbres d'additions sans multiplieur ; `VLUT` = mémoire LUT, **natif FPGA** |
| Réels tekum (§2) | ⚠️ tardif | un codec takum en VHDL existe (Hunhold) → base de travail ; troncature = arrondi économise la logique d'arrondi |
| SPM + DMA (§3) | ✅✅ | une BSRAM **est** une SPM ; plus simple et plus prévisible qu'un cache |
| Caches (§7) | ⚠️ | L1 en BSRAM indispensable (mémoire externe lente) ; L2 improbable sur la 20K |
| Prédicteur 3 issues | ✅ | petites tables |
| Pagination + TLB (§4) | ✅ | coût moyen, simplifie la conversion d'adresse |
| Étiquettes mémoire (§4) | ✅ | mémoire fantôme en BSRAM/SDRAM |
| ECC ternaire (§5) | ❌ | mémoire du FPGA binaire → ECC binaire classique ; le code 11 interdit du double rail donne une détection partielle gratuite |
| Compression (§7 bis) | ✅ | plans de trits = câblage ; vise le goulot réel (mémoire externe) |
| Bus PAM3 (§6) | ❌ | analogique, hors périmètre |
| TNPU (§8) | ✅✅ | sur FPGA, l'accélérateur devient une **unité du tissu** : produit matrice-vecteur ternaire **sans multiplieur**, par tables (TeLLMe v2) |
| Multicœur (§9) | ⚠️ | 2 cœurs envisageables sur ECP5-85F, peu probable sur la 20K |
| JIT, calcul réversible | — | sans objet |
| Affichage 3OS | ✅ | HDMI de la Tang Nano 20K pour le framebuffer |

### Conséquences sur le reste du document
- `VSETVL` **obligatoire** dès v0.5 : la largeur matérielle des vecteurs doit pouvoir être plus petite que l'ISA.
- Modèle de timing (§7) : paramètres par défaut = **latences de la carte cible** (BSRAM 1 cycle, SDRAM), puis
  recalage sur les cycles mesurés en simulation Verilator.
- Format d'image mémoire commun VM ↔ FPGA (double rail ou 5 trits/octet) pour partager les jeux de test.
- La SPM (§3) passe avant les caches dans l'ordre de priorité FPGA.

### Méthode
- **Langage matériel** : Amaranth (Python, intégré à Yosys, types paramétrables comme « Trit ») ou SystemVerilog + Verilator.
- **Vérification en lockstep** : la VM Rust et le RTL exécutent le même programme ; on compare chaque instruction retirée
  (pc, registre écrit, accès mémoire). Méthode standard RISC-V (Spike ↔ Ibex). Prérequis : un **journal d'exécution**
  (`--commit-log`) dans la VM, utile dès maintenant pour le débogage.
- **Ressources mesurées par synthèse** module par module avant toute carte.

### Parcours FPGA (piste parallèle)

| Étape | Contenu | Preuve | Carte ? |
|---|---|---|---|
| F0 | journal d'exécution dans la VM ; choix du langage matériel | journal sur `check.sh` | non |
| F1 | 3 variantes d'ALU synthétisées | table LUT / fréquence → décision de codage | non |
| F2 | cœur scalaire v0.4 en simulation | lockstep avec la VM sur `check.sh` | non |
| F3 | synthèse complète (cœur + BSRAM + contrôleur SDRAM) | tient sur la 20K ? sinon ECP5 | non |
| F4 | carte : console série, HDMI, SDRAM | **3OS démarre sur la puce**, Tetris jouable | oui |
| F5 | unités v0.5+ (vecteurs étroits, TNPU dans le tissu) | `ternet` / BitNet identiques à la VM | oui |

Travaux comparables (projets personnels, à regarder avec prudence) : VTX1 (SoC ternaire équilibré visant FPGA),
ternarycore / ternfpga (accélérateurs BitNet sur FPGA).

---

## 10. Ordre proposé

| Version | Contenu | Preuve principale |
|---|---|---|
| v0.5 — livré | Vecteurs effectifs documentés dans SPEC (+ CSR/MMIO) | `ternet` / Tetris : instructions avant/après |
| v0.6 | Réels tekum (logiciel → matériel) | erreur en ulp vs ternary27, programme réel |
| (indépendant) | Mesure de compressibilité sur images mémoire (§7 bis) | taux ternaire vs binaire, script hors VM |
| v0.7 | Modèle de timing + SPM + DMA | rapports de cycles, double tampon `ternet` |
| v0.8 | Pagination + étiquettes mémoire | 3OS paginé, bugs mémoire détectés |
| v0.9 | TNPU GPU (CUDA + WebGPU), BitNet | sortie identique au CPU, texte généré |
| ensuite | JIT, multicœur, ECC (Verilog), FPGA simulé | §5, §9 |
| piste parallèle | FPGA F0 → F5 | §9 bis |

## 11. Questions ouvertes
- Vecteurs : les opérations effectives et leurs variantes modulo/saturées sont définies dans SPEC ; toute extension doit préserver les tests existants.
- Réels : tekum + trit d'exactitude tient-il ses promesses face à ternary27 ? Place de NaR dans `CMP`.
- Étiquettes : 3 trits de couleur (27 couleurs) suffisent-ils ?
- Tailles SPM / L1 / L2 : décidées par §7.
- Prédicteur à 3 issues : littérature à vérifier.
- Compression : le gain ternaire vs binaire (petits négatifs) est-il réel sur nos données ? Granularité Thesaurus (bloc ou mot) ?
- FPGA : codage des trits (double rail / binaire / hybride) ; conversion d'adresse (A ou B) ; Amaranth ou SystemVerilog ;
  la Tang Nano 20K suffit-elle ?

## 12. Sources

- GDDR7 / PAM3 / ECC sur puce — JEDEC : https://www.jedec.org/news/pressreleases/jedec-publishes-gddr7-graphics-memory-standard
- 100BASE-T1 / PAM3 — Tektronix : https://www.tek.com/en/datasheet/tekexpress-automotive-ethernet-signal-separation-and-pam3-analysis
- L. Hunhold, *Tekum: Balanced Ternary Tapered Precision Real Arithmetic*, arXiv:2512.10964 — https://arxiv.org/abs/2512.10964
- R. O'Hare, *Ternary27: A Balanced Ternary Floating Point Format* v3.1 — https://cdn.hackaday.io/files/1649077055381088/Ternary27%20Standard.pdf
- D. W. Jones, *The Ternary Manifesto* (coût d'un additionneur ternaire) — https://homepage.cs.uiowa.edu/~dwjones/ternary/
- REBEL-6, ISA ternaire équilibrée 32 trits (ISMVL 2025) — https://www.computer.org/csdl/proceedings-article/ismvl/2025/074400a098/27EbFC1uLcY
- B. Parhami, *Arithmetic with Binary-Encoded Balanced Ternary Numbers* — https://web.ece.ucsb.edu/~parhami/pubs_folder/parh13-asilo-bin-encoded-symm-ternary.pdf
- llama.cpp PR #8151, formats TQ1_0 / TQ2_0 — https://github.com/ggml-org/llama.cpp/pull/8151
- *Bitnet.cpp: Efficient Edge Inference for Ternary LLMs*, arXiv:2502.11880 — https://arxiv.org/abs/2502.11880
- ARM MTE (4 bits / 16 octets) — https://www.linaro.org/blog/type-tracking-using-arm-memory-tagging/
- TCAM (« peu importe » comme 3ᵉ état) — https://community.cisco.com/t5/networking-knowledge-base/cam-content-addressable-memory-vs-tcam-ternary-content/ta-p/3107938
- CMOS ternaire, UNIST, *Nature Electronics* 2019 — https://www.nature.com/articles/s41928-019-0281-7
- Brevet Huawei CN119652311A — https://patents.google.com/patent/CN119652311A/en
- SRAM ternaire CNTFET — https://www.nature.com/articles/s41598-026-56270-6
- Setun / Setun 70 (Brusentsov) — https://dl.ifip.org/db/conf/ifip9/sorucom2006/BrusentsovA06.pdf
- Courbes remplissantes (Peano base 3, Morton, Hilbert) — https://emergentmind.com/topics/space-filling-curve-layouts
- Bit-Plane Compression (ISCA 2016) — https://doi.org/10.1109/isca.2016.37
- Thesaurus (ASPLOS 2020) — https://mieszko.ece.ubc.ca/thesaurus-asplos2020.pdf
- HICAMP (ASPLOS 2012) — https://dl.acm.org/doi/10.1145/2189750.2151007
- Linearly Compressed Pages (MICRO 2013) — https://people.inf.ethz.ch/omutlu/pub/linearly-compressed-pages_pekhimenko_micro13-poster.pdf
- Compresso (MICRO 2018) — https://cris.technion.ac.il/en/publications/compresso-pragmatic-main-memory-compression
- CRAM — https://arxiv.org/abs/1807.07685
- Compression par objets / Zippads (ASPLOS 2019) — https://people.csail.mit.edu/sanchez/papers/2019.zippads.asplos.slides.pdf
- AMD Delta Color Compression — https://gpuopen.com/learn/dcc-overview
- TRACE, compression CXL pour LLM (2025) — https://arxiv.org/abs/2509.03377
- Tang Nano 9K (Sipeed) — https://wiki.sipeed.com/hardware/en/tang/Tang-Nano-9K/Nano-9K
- Tang Nano 20K (Sipeed) — https://wiki.sipeed.com/hardware/en/tang/tang-nano-20k/nano-20k.html
- Gowin BSRAM (UG285) — https://cdn.gowinsemi.com.cn/UG285E.pdf
- Chaîne libre (Yosys, nextpnr, Trellis, Apicula) — https://libfpga.com/ref/open-source-flow
- Amaranth HDL — https://pypi.org/project/amaranth
- Co-simulation lockstep (Ibex ↔ Spike) — https://eda.amiq.com/specador/ibex/html/doc/03_reference/cosim.html
- L. Hunhold, codec matériel takum en VHDL, arXiv:2408.10594 — https://arxiv.org/abs/2408.10594
- TeLLMe, accélérateur LLM ternaire sur FPGA — https://arxiv.org/abs/2504.16266 ; TeLLMe v2 (matmul par tables) — https://arxiv.org/abs/2510.15926
- VTX1 (projet perso) — https://github.com/itworks99/vtx1 ; ternarycore — https://github.com/shepherdscientific/ternarycore ; ternfpga — https://github.com/Neumann-Labs/ternfpga
