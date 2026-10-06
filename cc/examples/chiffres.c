/* chiffres.c — 3OS : reconnaissance de chiffres par un réseau de neurones ternaire.
 * Mode TRIT (VMODE 1) : chaque pixel de l'écran est un trit, comme chaque entrée,
 * chaque poids et chaque neurone du réseau.
 * Saisie fidèle au jeu UCI (load_digits) : dessin 32x32 noir et blanc, compté par
 * blocs 4x4 (0..16), puis ternarisé comme à l'entraînement (<=3 : -1, >=10 : +1).
 *   clic gauche : encre (pinceau 5 px)   clic droit : gomme
 *   N : image suivante du jeu de test  E : effacer  Q / Echap : quitter
 * Affiche en direct le chiffre reconnu, les 10 scores et les TN_H neurones cachés
 * (blanc = pour, gris = sans avis, noir = contre). */
#include <stdio.h>
#include <tri27.h>
#include <tri27io.h>
#include <tgfx.h>
#include "ternet_model.h"

static char fb[23040];
static int pix[64];                 /* -1 fond, 0 gris, +1 encre : ce que voit le réseau */
static char bm[32 * 32];            /* dessin 32x32 (0/1), comme les formulaires UCI */
static char bm_dirty[32 * 32];
static long hid[TN_HW];
static long score[10];
static int pred = -1, test_i = -1;

#define GX 24
#define GY 40
#define CELL 9                      /* pixel du dessin 32x32 */
#define PVX 490                     /* aperçu 8x8 */
#define PVY 44

static void bm_to_pix(void) {
  for (int i = 0; i < 64; i++) {
    int br = i / 8, bc = i % 8, n = 0;
    for (int r = 0; r < 4; r++) for (int c = 0; c < 4; c++) n += bm[(br * 4 + r) * 32 + bc * 4 + c];
    pix[i] = n <= 3 ? -1 : (n >= 10 ? 1 : 0);
  }
}
static void stamp(int x, int y, int v, int rad) {
  for (int r = y - rad; r <= y + rad; r++)
    for (int c = x - rad; c <= x + rad; c++)
      if (r >= 0 && r < 32 && c >= 0 && c < 32 && bm[r * 32 + c] != v) { bm[r * 32 + c] = v; bm_dirty[r * 32 + c] = 1; }
}
static void line(int x0, int y0, int x1, int y1, int v, int rad) {
  int dx = x1 > x0 ? x1 - x0 : x0 - x1, dy = y1 > y0 ? y1 - y0 : y0 - y1;
  int n = dx > dy ? dx : dy;
  if (n == 0) { stamp(x0, y0, v, rad); return; }
  for (int k = 0; k <= n; k++) stamp(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, v, rad);
}

/* ---------- réseau ---------- */
static int classify(void) {
  long x[3] = {0, 0, 0}, p = 1;
  for (int i = 0; i < 64; i++) {
    x[i / 27] += pix[i] * p;
    p *= 3;
    if (i % 27 == 26) p = 1;
  }
  for (int w = 0; w < TN_HW; w++) hid[w] = 0;
  p = 1;
  for (int j = 0; j < TN_H; j++) {
    const long *wj = TN_W1[j];
    long s = T_DOT(wj[0], x[0]) + T_DOT(wj[1], x[1]) + T_DOT(wj[2], x[2]);
    if (s > TN_TP[j]) hid[j / 27] += p;
    else if (s < TN_TN[j]) hid[j / 27] -= p;
    p *= 3;
    if (j % 27 == 26) p = 1;
  }
  int best = 0;
  for (int k = 0; k < 10; k++) {
    long s = 0;
    for (int w = 0; w < TN_HW; w++) s += T_DOT(TN_W2[k][w], hid[w]);
    score[k] = s * TN_S[k] + TN_C[k];
    if (score[k] > score[best]) best = k;
  }
  return best;
}
static int hidden(int j) {          /* trit j de la couche cachée */
  long v = hid[j / 27];
  for (int k = 0; k < j % 27; k++) { long r = v % 3; if (r > 1) r -= 3; if (r < -1) r += 3; v = (v - r) / 3; }
  long r = v % 3; if (r > 1) r -= 3; if (r < -1) r += 3;
  return r;
}

/* ---------- dessin ---------- */
static int shade(int t) { return t > 0 ? TG_BLACK : (t < 0 ? TG_WHITE : TG_GRAY); }  /* encre noire sur papier */

static void big_digit(int x, int y, int d, int sc) {
  const short *g = TG_FONT + ('0' + d - 32) * 5;
  for (int cx = 0; cx < 5; cx++)
    for (int b = g[cx], r = 0; b; b /= 2, r++)
      if (b % 2) tg_fillrect(x + cx * sc, y + r * sc, sc, sc, TG_BLACK);
}

static void draw_bm(int i) {
  int r = i / 32, c = i % 32;
  tg_fillrect(GX + c * CELL, GY + r * CELL, CELL, CELL, bm[i] ? TG_BLACK : TG_WHITE);
}
static void draw_preview(void) {
  tg_fillrect(PVX - 1, PVY - 1, 8 * 9 + 2, 8 * 9 + 2, TG_BLACK);
  for (int i = 0; i < 64; i++) tg_fillrect(PVX + i % 8 * 9, PVY + i / 8 * 9, 9, 9, shade(pix[i]));
}

static void draw_panel(void) {
  int px = 340;
  tg_fillrect(px, 40, 230, 315, TG_WHITE);
  tg_text(px + 4, 44, "Reconnu :", TG_BLACK);
  tg_fillrect(PVX - 2, PVY - 2, 80, 92, TG_WHITE);
  if (pred >= 0) big_digit(px + 70, 44, pred, 9);
  tg_text(PVX + 2, PVY + 80, "vu 8x8", TG_BLACK);
  draw_preview();
  /* scores : barres centrées sur le meilleur */
  long mx = score[0], mn = score[0];
  for (int k = 1; k < 10; k++) { if (score[k] > mx) mx = score[k]; if (score[k] < mn) mn = score[k]; }
  long span = mx - mn; if (span < 1) span = 1;
  for (int k = 0; k < 10; k++) {
    int y = 122 + k * 13;
    char lab[2] = {'0' + k, 0};
    tg_text(px + 4, y + 2, lab, TG_BLACK);
    int w = (int)((score[k] - mn) * 180 / span);
    tg_fillrect(px + 16, y + 1, 182, 10, TG_GRAY);
    if (w > 0) tg_fillrect(px + 17, y + 2, w, 8, k == pred ? TG_BLACK : TG_WHITE);
  }
  { char nb[40]; sprintf(nb, "%d neurones caches :", TN_H); tg_text(px + 4, 258, nb, TG_BLACK); }
  for (int j = 0; j < TN_H; j++) {
    int x = px + 4 + (j % 27) * 8, y = 270 + (j / 27) * 8;
    int h = hidden(j);
    tg_fillrect(x, y, 7, 7, h > 0 ? TG_WHITE : (h < 0 ? TG_BLACK : TG_GRAY));
    tg_rect(x, y, 7, 7, TG_BLACK);
  }
  tg_text(px + 4, 310, "blanc pour, gris sans avis,", TG_BLACK);
  tg_text(px + 4, 320, "noir contre", TG_BLACK);
  if (test_i >= 0) {
    char buf[40];
    sprintf(buf, "test %d : vrai %d", test_i, TN_Y[test_i]);
    tg_text(px + 4, 338, buf, TG_BLACK);
  }
}

static void draw_all(void) {
  tg_fillrect(0, 0, 576, 360, TG_GRAY);
  tg_fillrect(0, 0, 576, 18, TG_WHITE);
  tg_hline(0, 18, 576, TG_BLACK);
  tg_text(8, 6, "Chiffres - reseau de neurones 100% ternaire (TDOT)", TG_BLACK);
  tg_text(GX, GY + 32 * CELL + 6, "gauche: encre  droit: gomme", TG_BLACK);
  tg_text(GX, GY + 32 * CELL + 16, "N: image test  E: effacer  Q: quitter", TG_BLACK);
  tg_rect(GX - 1, GY - 1, 32 * CELL + 2, 32 * CELL + 2, TG_BLACK);
  for (int i = 0; i < 1024; i++) draw_bm(i);
  draw_panel();
}

/* ---------- curseur (fond sauvegardé, comme Système 3) ---------- */
static const char *ARROW[12] = {
  "X.......", "XX......", "XoX.....", "XooX....", "XoooX...", "XooooX..",
  "XoooooX.", "XooooXXX", "XoXooX..", "XX.XooX.", "X..XooX.", "....XX..",
};
static int cx = 288, cy = 180, shown = 0, sx, sy;
static char bg[12 * 2];
static void cur_hide(void) { if (shown) tg_restore(sx / 9, sy, 2, 12, bg); shown = 0; }
static void cur_show(void) {
  sx = cx; sy = cy;
  tg_save(sx / 9, sy, 2, 12, bg);
  for (int r = 0; r < 12; r++)
    for (int q = 0; q < 8; q++) {
      char c = ARROW[r][q];
      if (c == 'X') tg_pixel(cx + q, cy + r, TG_BLACK);
      else if (c == 'o') tg_pixel(cx + q, cy + r, TG_WHITE);
    }
  shown = 1;
}

static void clear(void) {
  for (int i = 0; i < 1024; i++) { bm[i] = 0; bm_dirty[i] = 1; }
  bm_to_pix(); test_i = -1;
}
static void load_test(int i) {
  long v;
  for (int w = 0; w < 3; w++) {
    v = TN_X[i][w];
    for (int k = 0; k < 27 && w * 27 + k < 64; k++) {
      long r = v % 3; if (r > 1) r -= 3; if (r < -1) r += 3;
      pix[w * 27 + k] = r; v = (v - r) / 3;
    }
  }
  /* reconstruit un dessin 32x32 qui redonne exactement ces trits : +1 bloc plein (16),
   * 0 six pixels (4..9), -1 vide */
  for (int b = 0; b < 64; b++)
    for (int q = 0; q < 16; q++) {
      int at = (b / 8 * 4 + q / 4) * 32 + b % 8 * 4 + q % 4;
      bm[at] = pix[b] > 0 || (pix[b] == 0 && q < 6);
      bm_dirty[at] = 1;
    }
  test_i = i;
}

int main(void) {
  tg_init(fb);
  clear();
  for (int i = 0; i < 1024; i++) bm_dirty[i] = 0;
  pred = classify();
  draw_all(); cur_show(); tg_present();
  int next_test = 0, armed = 0, lx = -1, ly = -1;
  for (;;) {
    int dirty = 0, k;
    while ((k = KEY_EVENT) != 0) {
      if (k == 81 || k == 27) return 0;
      if (k == 69) { clear(); dirty = 1; }
      if (k == 78) { load_test(next_test); next_test = (next_test + 1) % TN_NTEST; dirty = 1; }
    }
    int ch;
    while ((ch = CONSOLE_IN) >= 0) {          /* même commandes au clavier console (tests CLI) */
      if (ch == 'q' || ch == 27) return 0;
      if (ch == 'e') { clear(); dirty = 1; }
      if (ch == 'n') { load_test(next_test); next_test = (next_test + 1) % TN_NTEST; dirty = 1; }
    }
    int mx = MOUSE_X, my = MOUSE_Y, b = MOUSE_BTN;
    int left = b % 3, right = b / 3 % 3;
    if (!left && !right) armed = 1;               /* le clic qui a lancé l'appli ne dessine pas */
    int inside = mx >= GX && my >= GY && mx < GX + 32 * CELL && my < GY + 32 * CELL;
    if (armed && (left || right) && inside) {
      int x = (mx - GX) / CELL, y = (my - GY) / CELL;
      if (lx < 0) { lx = x; ly = y; }
      line(lx, ly, x, y, left ? 1 : 0, 2);         /* pinceau 5 px : traits saturant un bloc 4x4 comme dans UCI */
      lx = x; ly = y;
      bm_to_pix(); dirty = 1; test_i = -1;
    } else { lx = -1; ly = -1; }
    if (dirty) {
      cur_hide();
      pred = classify();
      for (int i = 0; i < 1024; i++) if (bm_dirty[i]) { draw_bm(i); bm_dirty[i] = 0; }
      draw_panel();
      cx = mx; cy = my; cur_show(); tg_present();
    } else if (mx != cx || my != cy) {
      cur_hide(); cx = mx; cy = my; cur_show(); tg_present();
    } else wfi();
  }
}
