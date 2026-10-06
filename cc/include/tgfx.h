/* tgfx.h — mini bibliothèque graphique pour le mode vidéo TRIT (576x360, 1 trit/pixel), cf. SPEC.md §6.
 * Compilation : python tri27cc.py prog.c lib/tgfx.c -o prog.tas
 * Trits : -1 noir, 0 gris, +1 blanc. Un « motif » (pat) est soit un trit (-1/0/+1 : plein),
 * soit TG_DITHER(a,b) : trame 50 % alternant a et b (damier au pixel). */
#ifndef TGFX_H
#define TGFX_H
#include <tri27io.h>

#define TG_BLACK (-1)
#define TG_GRAY  0
#define TG_WHITE 1
#define TG_DITHER(a, b) (2 + ((a) + 1) * 3 + ((b) + 1))

void tg_init(char *buf);            /* buf : 23040 trytes ; VMODE=1, FB_ADDR=buf, efface (gris) */
void tg_present(void);              /* FB_PRESENT */
void tg_clip(int x, int y, int w, int h);  /* rectangle de clip (intersecté avec l'écran) */
void tg_noclip(void);
void tg_pixel(int x, int y, int t);
int  tg_get(int x, int y);
void tg_hline(int x, int y, int w, int pat);
void tg_vline(int x, int y, int h, int pat);
void tg_rect(int x, int y, int w, int h, int pat);      /* contour 1 px */
void tg_fillrect(int x, int y, int w, int h, int pat);  /* tryte entier quand 9 pixels alignés */
void tg_text(int x, int y, const char *s, int t);       /* police 5x7, pas de 6 px, glyphes 8 lignes ; pixels « allumés » seulement */
int  tg_textw(const char *s);
void tg_save(int tx, int y, int n, int h, char *dst);   /* copie n trytes × h lignes (tx = colonne tryte) */
void tg_restore(int tx, int y, int n, int h, const char *src);
#endif
