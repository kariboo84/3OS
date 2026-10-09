/* dgfx.h — dessin du bureau en coordonnées logiques, interface ×1/×2/×3.
 * Couleur : rectangles GPU et atlas de glyphes COPY_KEY ; trits : remplissage CPU empaqueté. */
#ifndef DGFX_H
#define DGFX_H
extern int dg_w, dg_h, dg_scale, dg_depth;
void dg_reserve(char *top);
void dg_config(int w, int h, int depth);
void dg_palette(const long *colors);
void dg_pixel(int x, int y, long color);
void dg_fill(int x, int y, int w, int h, long color);
void dg_text(int x, int y, const char *s, int k);
void dg_cursor_save(int x, int y, long *bg);
void dg_cursor_restore(int x, int y, const long *bg);
#endif
