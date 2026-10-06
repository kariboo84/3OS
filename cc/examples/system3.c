/* system3.c — bureau « Système 3 » façon Mac System 7, en 3 niveaux (VMODE 1)
 * ou en couleur TRGB (VMODE 2, touche C).
 * Souris : déplacer, tirer une barre de titre, case de fermeture, clic sur le disque
 * = rouvrir les fenêtres. Q / Échap : quitter.
 *
 * Curseur : le framebuffer contient TOUJOURS le curseur. Avant tout dessin on le
 * retire (cur_hide = restaure le fond sauvegardé), après on le remet (cur_show =
 * sauvegarde le fond à la position courante puis dessine), puis on présente.
 * Pas de & | << >> (émulés, lents) : bitmaps en chaînes, bouton gauche = btn % 3.
 */
#include <tri27io.h>
#include <tgfx.h>
#include <3os.h>

static char fb[23040];          /* mode 1 : 64 trytes x 360 lignes */
static char fbc[207360];        /* mode 2 : 576 x 360 trytes */
static int mode = 1;

/* ---------- couleurs logiques ---------- */
#define K_BLACK 0
#define K_GRAY  1
#define K_WHITE 2
#define K_TITLE 3
#define K_DESK  4
#define K_ACCENT 5
static int col(int k) {
  if (mode == 1) {
    if (k == K_BLACK) return TG_BLACK;
    if (k == K_WHITE) return TG_WHITE;
    return TG_GRAY;
  }
  if (k == K_BLACK) return TRGB(-13, -13, -13);
  if (k == K_GRAY) return TRGB(2, 2, 2);
  if (k == K_WHITE) return TRGB(13, 13, 13);
  if (k == K_TITLE) return TRGB(-9, -6, 6);
  if (k == K_DESK) return TRGB(-4, 0, 5);
  return TRGB(8, 2, -8);
}

/* ---------- primitives selon le mode ---------- */
static void pset(int x, int y, int k) {
  if (x < 0 || x >= 576 || y < 0 || y >= 360) return;
  if (mode == 1) tg_pixel(x, y, col(k)); else fbc[y * 576 + x] = col(k);
}
static void fill(int x, int y, int w, int h, int k) {
  if (mode == 1) { tg_fillrect(x, y, w, h, col(k)); return; }
  int x1 = x + w, y1 = y + h;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x1 > 576) x1 = 576;
  if (y1 > 360) y1 = 360;
  if (x >= x1) return;
  int c = col(k);
  for (int r = y; r < y1; r++) {
    char *p = fbc + r * 576 + x, *e = fbc + r * 576 + x1;
    while (p < e) *p++ = c;
  }
}
static void frame(int x, int y, int w, int h, int k) {
  fill(x, y, w, 1, k); fill(x, y + h - 1, w, 1, k);
  fill(x, y, 1, h, k); fill(x + w - 1, y, 1, h, k);
}
/* rayures verticales 1 px (barres de titre System 7) */
static void stripes(int x, int y, int w, int h, int ka, int kb) {
  if (mode == 1) { tg_fillrect(x, y, w, h, TG_DITHER(col(ka), col(kb))); return; }
  for (int q = x; q < x + w; q++) fill(q, y, 1, h, (q % 2 == 0) ? ka : kb);
}
static void text(int x, int y, const char *s, int k) {
  if (mode == 1) { tg_text(x, y, s, col(k)); return; }
  for (; *s; s++, x += 6) {
    int c = *s;
    if (c < 32 || c > 126) continue;
    const short *g = TG_FONT + (c - 32) * 5;
    for (int cx = 0; cx < 5; cx++)
      for (int b = g[cx], r = 0; b; b /= 2, r++)
        if (b % 2) pset(x + cx, y + r, k);
  }
}
static void present(void) { FB_PRESENT = 0; }

/* ---------- curseur flèche 8x12 ---------- */
static const char *ARROW[12] = {
  "X.......", "XX......", "XoX.....", "XooX....", "XoooX...", "XooooX..",
  "XoooooX.", "XooooXXX", "XoXooX..", "XX.XooX.", "X..XooX.", "....XX..",
};
static int cx = 288, cy = 180, shown = 0, sx, sy;
static char bg_t[12 * 2];       /* mode 1 : 2 trytes x 12 lignes */
static char bg_c[12 * 8];       /* mode 2 : 8 x 12 pixels */

static void cur_hide(void) {
  if (!shown) return;
  if (mode == 1) tg_restore(sx / 9, sy, 2, 12, bg_t);
  else
    for (int r = 0; r < 12; r++)
      for (int q = 0; q < 8; q++)
        if (sy + r < 360 && sx + q < 576) fbc[(sy + r) * 576 + sx + q] = bg_c[r * 8 + q];
  shown = 0;
}
static void cur_show(void) {
  sx = cx; sy = cy;
  if (mode == 1) tg_save(sx / 9, sy, 2, 12, bg_t);
  else
    for (int r = 0; r < 12; r++)
      for (int q = 0; q < 8; q++)
        if (sy + r < 360 && sx + q < 576) bg_c[r * 8 + q] = fbc[(sy + r) * 576 + sx + q];
  for (int r = 0; r < 12; r++)
    for (int q = 0; q < 8; q++) {
      char c = ARROW[r][q];
      if (c == 'X') pset(cx + q, cy + r, K_BLACK);
      else if (c == 'o') pset(cx + q, cy + r, K_WHITE);
    }
  shown = 1;
}

/* ---------- bureau ---------- */
typedef struct { int x, y, w, h, open; const char *title; } Win;
static Win win[2] = {
  { 30, 34, 230, 200, 1, "3OS" },
  { 280, 120, 270, 175, 1, "Lisez-moi" },
};
/* contenu du disque (sys_readdir) et du fichier lisez-moi (sys_readfile) */
static char names[24][16];
static long kinds[24], nfiles;
static char readme[1200];
static char status[64] = "Cliquez un programme pour le lancer.";
static void load_disk(void) {
  nfiles = 0;
  for (long i = 0; i < 24; i++) {
    long k = sys_readdir(i, names[nfiles]);
    if (k == 0) break;
    kinds[nfiles++] = k;
  }
  long n = sys_readfile("lisez-moi", readme, 1199);
  readme[n > 0 ? n : 0] = 0;
}
/* ligne du programme i dans la fenêtre 3OS */
static int row_y(int i) { return win[0].y + 22 + i * 14; }
static int top = 0;   /* fenêtre au premier plan */

static void draw_window(int j, int active) {
  Win *w = &win[j];
  if (!w->open) return;
  frame(w->x, w->y, w->w, w->h, K_BLACK);
  fill(w->x + 1, w->y + 1, w->w - 2, 12, K_WHITE);
  if (active) {
    if (mode == 1) stripes(w->x + 2, w->y + 3, w->w - 4, 8, K_BLACK, K_WHITE);
    else fill(w->x + 1, w->y + 1, w->w - 2, 12, K_TITLE);
    fill(w->x + 6, w->y + 2, 11, 10, mode == 1 ? K_WHITE : K_TITLE);
    frame(w->x + 7, w->y + 3, 9, 8, mode == 1 ? K_BLACK : K_WHITE);
  }
  int tw = tg_textw(w->title) + 8, tx = w->x + (w->w - tw) / 2;
  fill(tx, w->y + 2, tw, 10, (mode == 2 && active) ? K_TITLE : K_WHITE);
  text(tx + 4, w->y + 3, w->title, (mode == 2 && active) ? K_WHITE : K_BLACK);
  fill(w->x, w->y + 13, w->w, 1, K_BLACK);
  fill(w->x + 1, w->y + 14, w->w - 2, w->h - 15, K_WHITE);
  fill(w->x + 2, w->y + w->h, w->w, 1, K_BLACK);         /* ombre portée */
  fill(w->x + w->w, w->y + 2, 1, w->h - 1, K_BLACK);
  int x = w->x + 10, y = w->y + 22;
  if (j == 0) {
    for (int i = 0; i < nfiles && row_y(i) + 10 < w->y + w->h; i++) {
      /* petite icône : programme = carré plein, donnée = page */
      if (kinds[i] == 1) fill(x, row_y(i), 9, 9, mode == 1 ? K_BLACK : K_ACCENT);
      else frame(x, row_y(i), 8, 10, K_BLACK);
      char lab[24];
      int k = 0;
      lab[k++] = i < 9 ? '1' + i : ' '; lab[k++] = ' ';
      for (int c = 0; names[i][c] && k < 22; c++) lab[k++] = names[i][c];
      lab[k] = 0;
      text(x + 14, row_y(i) + 1, lab, kinds[i] == 1 ? K_BLACK : K_GRAY);
    }
    text(x, w->y + w->h - 12, status, K_GRAY);
  } else {
    /* texte du fichier lisez-moi, coupé aux retours à la ligne */
    char line[64];
    int k = 0, ly = y;
    for (char *c = readme; ; c++) {
      if (*c == 10 || *c == 0 || k == 40) {
        line[k] = 0;
        if (ly + 8 < w->y + w->h) text(x, ly, line, K_BLACK);
        ly += 12; k = 0;
        if (*c == 0) break;
        if (*c != 10) line[k++] = *c;
      } else line[k++] = *c;
    }
  }
}

static void icon_disk(int x, int y) {
  frame(x, y, 34, 30, K_BLACK);
  fill(x + 1, y + 1, 32, 28, mode == 1 ? K_WHITE : K_ACCENT);
  fill(x + 6, y + 4, 22, 8, K_WHITE);
  frame(x + 6, y + 4, 22, 8, K_BLACK);
  fill(x + 8, y + 20, 18, 4, K_BLACK);
  text(x + 8, y + 34, "3OS", K_BLACK);
}
static void icon_trash(int x, int y) {
  fill(x + 2, y, 26, 4, K_BLACK);
  frame(x + 4, y + 4, 22, 28, K_BLACK);
  fill(x + 5, y + 5, 20, 26, mode == 1 ? K_WHITE : K_GRAY);
  for (int q = x + 9; q < x + 24; q += 5) fill(q, y + 8, 1, 20, K_BLACK);
  text(x - 12, y + 36, "Corbeille", K_BLACK);
}

static void menubar(void) {
  fill(0, 0, 576, 18, K_WHITE);
  fill(0, 18, 576, 1, K_BLACK);
  fill(13, 4, 3, 3, K_BLACK);        /* logo ∴ */
  fill(9, 11, 3, 3, K_BLACK);
  fill(17, 11, 3, 3, K_BLACK);
  text(32, 6, "Fichier   Edition   Presentation   Special", K_BLACK);
  text(530, 6, mode == 1 ? "TRIT" : "TRGB", K_GRAY);
}

static void draw_all(void) {
  fill(0, 19, 576, 341, mode == 1 ? K_GRAY : K_DESK);
  menubar();
  icon_disk(510, 40);
  icon_trash(520, 295);
  draw_window(1 - top, 0);
  draw_window(top, 1);
}

static void set_mode(int m) {
  mode = m;
  shown = 0;
  if (mode == 1) tg_init(fb);
  else { VMODE = 2; FB_ADDR = (long)fbc; }
  draw_all();
  cur_show();
  present();
}

static void launch(int i) {
  if (i < 0 || i >= nfiles || kinds[i] != 1) return;
  cur_hide();
  long code = sys_exec(names[i]);
  load_disk();                      /* un programme a pu écrire sur le disque */
  /* retour au bureau : le noyau a rétabli notre écran ; on redessine par sécurité */
  char *m = status;
  const char *a = "Fin de ";
  while (*a) *m++ = *a++;
  for (int c = 0; names[i][c] && m < status + 40; c++) *m++ = names[i][c];
  *m++ = ' '; *m++ = '(';
  if (code < 0) { *m++ = '-'; code = -code; }
  if (code >= 10) *m++ = '0' + code / 10 % 10;
  *m++ = '0' + code % 10; *m++ = ')'; *m = 0;
  set_mode(mode);
}

static int in(int x, int y, int rx, int ry, int rw, int rh) {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
}

int main(void) {
  load_disk();
  set_mode(1);
  int drag = -1, dx = 0, dy = 0, prev_left = 0;
  for (;;) {
    int k;
    while ((k = KEY_EVENT) != 0) {
      if (k == 67) { cur_hide(); set_mode(mode == 1 ? 2 : 1); }     /* C */
      if (k == 81 || k == 27) return 0;                            /* Q, Échap */
    }
    int ch = CONSOLE_IN;                    /* touches 1..9 : lancer le n-ième fichier */
    if (ch >= '1' && ch <= '9') launch(ch - '1');
    int mx = MOUSE_X, my = MOUSE_Y, left = MOUSE_BTN % 3;
    int dirty = 0;

    if (left && !prev_left) {                                      /* appui */
      for (int i = 0; i < 2; i++) {
        int j = (i == 0) ? top : 1 - top;
        Win *w = &win[j];
        if (!w->open || !in(mx, my, w->x, w->y, w->w, w->h)) continue;
        if (j == top && in(mx, my, w->x + 6, w->y + 2, 11, 10)) { w->open = 0; dirty = 1; }
        else if (j == 0 && my >= row_y(0) && my < row_y(nfiles)) { launch((my - row_y(0)) / 14); prev_left = 1; }
        else {
          if (j != top) { top = j; dirty = 1; }
          if (my < w->y + 13) { drag = j; dx = mx - w->x; dy = my - w->y; }
        }
        break;
      }
      if (in(mx, my, 510, 40, 34, 44)) { win[0].open = 1; win[1].open = 1; dirty = 1; }
    }
    if (!left) drag = -1;
    if (drag >= 0) {
      Win *w = &win[drag];
      int nx = mx - dx, ny = my - dy;
      if (ny < 20) ny = 20;
      if (ny > 345) ny = 345;
      if (nx < 20 - w->w) nx = 20 - w->w;
      if (nx > 556) nx = 556;
      if (nx != w->x || ny != w->y) { w->x = nx; w->y = ny; dirty = 1; }
    }
    prev_left = left;

    if (dirty) { cur_hide(); cx = mx; cy = my; draw_all(); cur_show(); present(); }
    else if (mx != cx || my != cy) { cur_hide(); cx = mx; cy = my; cur_show(); present(); }
    else wfi();                                  /* rien à faire : dormir jusqu'au prochain événement */
  }
}
