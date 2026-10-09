# Bureau multi-résolution et panneau Affichage

## Fonctionnement

- `Preferences > Affichage...` : trois résolutions et trois profondeurs, application immédiate.
- Framebuffer natif 1:1 dans les trois résolutions : 576×360, 1280×720, 1920×1080.
  Aucun agrandissement des pixels. IBM Plex Sans proportionnelle (Mono alternative),
  rasterisée à 9 px en compact, 14 ou 16 px en HD, avec couverture AA à 27 niveaux
  calculée dans le guest. Les métriques UI restent fixes entre 720p et 1080p :
  la surface utilisable augmente réellement, sans dupliquer les pixels des glyphes.
- Toutes les primitives de rectangle/barre et de texte passent par le GPU 2D en 9/27 trits.
  Le texte utilise un atlas de glyphes transparent COPY_KEY, reconstruit seulement si
  la profondeur, la famille, la taille, le lissage ou la palette changent.
  Le cache est paresseux par couple fond/encre ; le mélange utilise le vrai fond. Profondeur 1 : CPU, trits empaquetés
  continûment, y compris en 1280 (largeur non divisible par neuf).
- Les buffers sont réservés sous la pile ; aucun framebuffer statique dans l'image disque.
- `config` contient `largeur hauteur profondeur\n`, lu par `sys_readfile` au démarrage
  et au retour d'une application. Absence/erreur/paire ou profondeur invalide : 576 360 27.
  Les choix passent par `sys_writefile` et la sauvegarde du disque existante du navigateur.
- Les raccourcis C, les menus Bureau, Tetris, l'éditeur et les fenêtres sont conservés.
- Chrome de fenêtres sobre, barre des fenêtres ouvertes, réduction/restauration,
  maximisation par bouton, double-clic du titre ou F10. F4 ouvre Affichage, F5 actualise,
  Home/End et PageUp/PageDown naviguent dans la liste ; Tab change de fenêtre.
- Le bouton Plein écran utilise la vraie API Fullscreen, pas un zoom du framebuffer.
  C mémorise également sa profondeur dans config et revient à la dernière profondeur couleur.
- Un échec de sauvegarde est affiché dans le panneau et la barre d'état. Le fichier `config`
  est réservé par `os/build.sh` ; `sys_writefile` ne crée pas de fichier absent.

## Vérification réelle

Commande exécutée sur `feat/desktop-res` :

    TRI27_HTTP=8125 TRI27_CDP=9246 ./check.sh --web

Résultat : code de sortie 0, dernière ligne `== tout est vert`.

- VM/vecteurs, 34 PASS chibicc, banc d'instructions, scripts OS, profondeur CLI, HD,
  GPU 2D, TerNet/Kleene et snapshot PRESENT passent.
- `tests/dgfx.c` : neuf formats, clipping, palette/atlas, restauration du curseur,
  configuration invalide ; zéro commande GPU en profondeur 1.
- `tests/desktop_display.cjs`, branché dans check.sh : vrais clics CDP, neuf couples,
  dimensions du canvas, palette et sélections, contenu 3FS relu exactement après chaque choix.
  Test du config absent et de quatre configurations invalides.
- Retour de Tetris : 1920×1080@27 conservé.
- `Page.reload` : nouveau contexte JS confirmé, boot automatique depuis le disque persisté,
  fichier config relu, profondeur 27 et dimensions vérifiées. Aucune réinjection du disque
  ni appel à assembleAndRun dans cette vérification de rechargement.
- Tests web_smoke/desktop_smoke/mouse_refresh/hd_web conservés.
- desktop_classic : logo pendant le vrai chargement, signal desktop-ready, panneaux
  Fond/Son/Polices, réglages lus sur 3FS, audio numérique nul/non nul, redémarrage.
- desktop_images : Finder → PNG/BMP/PPM → pixels natifs, alpha, retour Échap ;
  décodeurs d'images hôte interdits pendant le test. Codec C : 36 vérifications.
- Une écriture config n'est pas un PRESENT : pour passer au mode trois gris,
  le test attend la vraie image suivante, puis exige toujours exactement trois couleurs.
- desktop_qol : vrais événements CDP, F4, F10, double-clic titre, réduire/barre/restaurer,
  déplacement au-delà de l'ancien espace limité, Home/End, Tab et Fullscreen.
- dgfx.c vérifie un pixel 1:1 et un glyphe qui n'est pas une duplication 2×2.
  Les tests doivent passer avec zéro exception JS.
- Captures natives du canvas, dimensions PNG égales à celles du framebuffer ; panneau
  couleur 1080p et repli trit 720p regardés, ainsi que la fenêtre déplacée en 1080p.

## Instructions en 1920×1080@27

Compteur W.cycles, donc instructions de la VM **noyau compris**, pas coût hôte du GPU.
Atlas déjà initialisé. L'exécution normale est mise en pause pendant la mesure ;
les événements viennent toujours de CDP. Exécution manuelle par tranches de 1000
jusqu'au PRESENT suivant, puis retour au WFI avant l'échantillon suivant.
L'arrondi de la borne PRESENT est inférieur à 1000 instructions par échantillon.

- Repos : 22174 instructions pour 32 réveils,
  **0 nouvelle image**. Le coût de rendu au repos est nul ;
  « instructions/image » n'a pas de quotient quand aucune image n'est rendue.
- Passe Platinum/native AA : déplacement de la fenêtre Finder, 20 images,
  7938065 instructions au total, moyenne **396903 instructions/image**.
  Minimum 396785, maximum 397000. Le seuil du test est inférieur à 500000/image.
  Ces mesures incluent le noyau, les nouvelles fontes et 19 fichiers ; ne pas les
  attribuer à l'ancienne interface ni en déduire une cadence hôte.
- Pas d'estimation de cadence réelle à partir de TIME_MS (horloge VM du navigateur).

## Artefacts et reproduction

Dans `cc/build/shots/` (non suivis par Git, régénérés par le test) :

- `desktop-display-576x360-9.png`
- `desktop-display-1280x720-27.png`
- `desktop-display-1920x1080-27.png`
- Les six autres couples, nommés de la même façon.
- `desktop-display-reload-1080.png`, `desktop-display-drag-1080.png`.
- `desktop-display-perf.json` : compteurs bruts et vingt échantillons de déplacement.
- `desktop-display-modes.json` : dimensions, profondeur, échelle et chemins des captures.

Journal complet : `cc/build/desktop-check-web.log`.
Avec serveur et Chrome CDP déjà disponibles, le test seul se relance par :

    TRI27_HTTP=8125 TRI27_CDP=9232 node tests/desktop_display.cjs

Les fixtures et les écritures du test modifient seulement le disque du navigateur,
jamais le fichier hôte `os/3os.t3d`. Le test nettoie sa copie persistée à la fin.
