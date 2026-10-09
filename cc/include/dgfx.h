/* dgfx.h — framebuffer natif : une coordonnée = un pixel, sans zoom global.
 * La taille des caractères est indépendante de l'espace de travail.
 * Profondeurs 9/27 : rectangles GPU + atlas de glyphes COPY_KEY.
 * Profondeur 1 : remplissage CPU empaqueté continu, texte et pixels CPU.
 * dg_reserve : réserve RAM sous la pile (>= 17 620 800 trytes).
 * Atlas paresseux : glyphes calculés seulement pour les couples encre/fond utilisés.
 * Couleurs codées pour dg_depth ; palette de dix couleurs.
 */
#ifndef DGFX_H
#define DGFX_H
#include <tri27io.h>
extern int dg_w, dg_h, dg_scale, dg_depth;
extern int dg_fontw, dg_fonth;
void dg_reserve(char *top);
/* Dimensions invalides → 576×360 ; profondeur invalide → 27. */
void dg_config(int w, int h, int depth);
void dg_palette(const long *colors);
void dg_pixel(int x, int y, long color);
void dg_fill(int x, int y, int w, int h, long color);
void dg_frame(int x, int y, int w, int h, long color);
/* IBM Plex Sans/Mono, couvertures 27 niveaux ; taille HD 14 ou 16 px. */
void dg_font(int face, int size, int aa);
int dg_char_width(int c);
int dg_text_width(const char *s);
void dg_text(int x, int y, const char *s, int k);
/* Fond du curseur natif : 8×12 compact, 16×24 grand écran ; réserver 384 mots. */
void dg_cursor_save(int x, int y, long *bg);
void dg_cursor_restore(int x, int y, const long *bg);
#endif
