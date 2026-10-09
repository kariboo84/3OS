# timage — lecture d’images dans TRI-27 / 3OS

## Ce qui est réel

`cc/include/timage.h` expose une bibliothèque C compilée par le chibicc TRI-27.
Le PNG est décodé dans le guest par **LodePNG 20261006** (licence zlib, source et
licence dans `cc/third_party/lodepng/`). BMP et PPM utilisent les petits décodeurs
`cc/lib/timage.c`. Aucun `Image`, `createImageBitmap` ni décodage Canvas hôte.

Formats :
- PNG : RGB/RGBA, gris/alpha, palettes et tRNS, profondeurs PNG 1/2/4/8/16 selon
  le type, filtres 0–4, entrelacement Adam7 ; sortie normalisée en RGBA8.
- BMP : BI_RGB non compressé, 24 ou 32 bits, ordre bottom-up ou top-down et
  padding des lignes. L’octet alpha BI_RGB est ignoré (alpha opaque).
- PPM : P3 texte et P6 binaire, commentaires et maxval 1–255. Pas de P6 16 bits.
- **Pas de JPEG, GIF ou WebP. Pas d’encodeur.**

## Frontière binaire / ternaire

Un octet de fichier est représenté par **un tryte de valeur 0…255**. Ce n’est pas
une prétendue représentation ternaire du standard PNG : PNG et DEFLATE restent
binaires, décodés par le CPU ternaire. Un composant RGBA occupe aussi un tryte.

`mkdisk` accepte un préfixe explicite, sans toucher au traitement des textes :

```sh
tri27/target/release/tri27 mkdisk images.t3d demo.png=bytes:os/assets/demo.png
```

Le stockage conserve NUL, octets hauts et UTF-8 invalide. Les adaptations
LodePNG sont marquées : prédicteurs modulo 256 explicites et masque d’effacement
sur 8 bits. La largeur du `char` C TRI-27 n’est **pas** de 8 bits. Ne pas remplacer
ces adaptations par des casts `unsigned char` à la façon d’un CPU binaire.

## API

```c
#include <timage.h>
TImage image = {0};
/* Depuis un tampon : timage_decode(&image, bytes, length).
   Ici, exemple indépendant depuis 3FS : */
int error = timage_load(&image, "demo.png");
if (!error) {
    /* image.rgba[4 * (y * image.width + x) + channel] */
    long pixel = timage_color(image.rgba, 27, 0xC0C0C0);
    /* pixel est la couleur native du framebuffer, alpha mélangé au fond RGB8. */
}
timage_free(&image);
```

Lier `cc/lib/timage.c cc/lib/timage_png.c`. Pour `timage_load`, ajouter
`cc/lib/timage_io.c cc/lib/sys.tas`. Les erreurs rendent une sortie vide ;
`timage_error(code)` fournit le texte. Libérer une image existante avant de
réutiliser sa structure. `timage_color` prend une profondeur 1, 9 ou 27 et
un fond RGB8 empaqueté `R*65536+G*256+B`.

## Limites assumées

- Dimensions au plus 1920×1080, **400 000 pixels au total**, source ≤ 1 900 000
  octets. Le brut PNG décompressé est également borné avant le décodage.
- La libc actuelle borne l’arène totale à 2 Mtrytes, `free()` n’en récupère pas
  l’espace. Les plafonds de l’API sont donc des bornes de sécurité, **pas une
  garantie que toute image située en dessous sera décodable**. Un manque de
  mémoire renvoie une erreur, il ne doit pas être contourné silencieusement.
- Le visualiseur charge **une image par processus**, dont l’espace est réinitialisé
  au lancement suivant. Pas de galerie qui ferait des décodages successifs dans
  la même arène. `sys_filesize` (appel 16) permet une allocation exacte suivie
  d'une seule lecture ; pas de buffers de croissance abandonnés.
  La lecture avec offset et l'allocateur récupérant réellement restent à faire.
- PNG CRC/Adler restent vérifiés. Ce code n’est pas une certification de sûreté
  pour toutes les entrées possibles : le noyau conserve l’isolation du processus.

## Visualiseur livré

`cc/examples/images.c` est une vraie application 3OS. Dans le Finder, sélectionner
`demo.png`, `demo.bmp` ou `demo.ppm`, puis Entrée/double-clic. Le Finder transmet
le nom via le fichier 3FS préalloué `image-cible`, puis appelle `sys_exec("images")`.
Échap revient au bureau. Le mode d’affichage est repris du fichier `config`.

L’image est centrée en pixels 1:1 ; si elle dépasse la zone, une partie est
recadrée et ce fait est indiqué. Aucun zoom global. L’alpha PNG est mélangé sur
un damier. Les fichiers de démonstration sont de vrais PNG/BMP/PPM dans `os/assets/`.

## Vérification reproductible

```sh
python3 tests/timage.py
bash os/build.sh
python3 tests/timage_io.py
TRI27_HTTP=8124 TRI27_CDP=9232 node tests/desktop_images.cjs
TRI27_HTTP=8124 TRI27_CDP=9247 ./check.sh --web
```

Le premier test exécute le codec dans la VM : 36 vérifications (types/filtres,
Adam7, palettes, 16 bits, BMP, PPM, erreurs, surdimensionnement, dépassement du
flux, CRC, trytes non octets, alpha et trois profondeurs). Il vérifie aussi les
768 octets exacts de l’aller-retour `mkdisk` et utilise Pillow uniquement comme
oracle des fixtures sur l’hôte.

Le test Chrome lance les trois images depuis le Finder, relit `image-cible`,
contrôle des pixels réels et l’alpha puis revient au bureau. Il interdit les
constructeurs de décodage d’images hôte pendant ce parcours. Captures et rapport
JSON : `cc/build/shots/images-native-*`.

`tests/timage_io.py` exerce cinq contrats sous le vrai noyau : taille exacte
(donnée, programme, fichier vide), fichier/pointeur invalide, décodage d'un PPM
valide de 700 016 octets avec un seul tampon, limite source vérifiée avant
allocation, sorties vides pour fichier vide/absent. La grande source contient un
commentaire légal et un pixel, pour isoler la stratégie de lecture du coût d'une
image géante. Les trois tests sont inclus dans `check.sh`.

## Suite utile

1. Vrai allocateur avec récupération + lecture par plages 3FS (filesize livré).
2. Relever les plafonds après mesure et tests, pas seulement les constantes.
3. Ajouter JPEG via une bibliothèque publiée, avec les mêmes vérifications sur
   la frontière octet/tryte ; ne pas importer stb_image sans vérifier ses
   hypothèses 8/32 bits.
4. Rendu accéléré des images et éventuelle galerie ; séparé du décodage.
