/* dgfx.h — bureau en coordonnées logiques, interface ×1/×2/×3.
 * 576×360 → 576×360 logique ; 1280×720 et 1920×1080 → 640×360 logique.
 * Profondeurs 9/27 : rectangles GPU + atlas de glyphes COPY_KEY.
 * Profondeur 1 : remplissage CPU empaqueté continu, texte et pixels CPU.
 * dg_reserve : haut d'une réserve RAM sous la pile (>= 7 452 000 trytes).
 * Pas de tableau statique géant, qui gonflerait l'image 3FS.
 * Couleurs codées pour dg_depth ; palette de dix couleurs.
 */
#ifndef DGFX_H
#define DGFX_H
#include <tri27io.h>
extern int dg_w, dg_h, dg_scale, dg_depth;
void dg_reserve(char *top);
/* Dimensions invalides → 576×360 ; profondeur invalide → 27. */
void dg_config(int w, int h, int depth);
void dg_palette(const long *colors);
void dg_pixel(int x, int y, long color);
void dg_fill(int x, int y, int w, int h, long color);
void dg_frame(int x, int y, int w, int h, long color);
/* Police 5×7 + avance 6×8, ASCII, indice de palette 0..9. */
void dg_text(int x, int y, const char *s, int k);
/* Fond 8×12 logique : réserver 8*12*3*3 mots. */
void dg_cursor_save(int x, int y, long *bg);
void dg_cursor_restore(int x, int y, const long *bg);
#endif
