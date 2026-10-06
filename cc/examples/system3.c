/* system3.c — bureau « Système 3 » façon Mac System 7, en 3 niveaux (mode trit) :
 * barre de menus, 2 fenêtres (titre rayé, case de fermeture, texte), icônes
 * (disque 3OS, corbeille), curseur flèche qui suit la souris, fenêtre active
 * déplaçable en tirant sa barre de titre, touche C : bascule couleur/TRIT.
 * Entrées : souris MMIO (-10/-11/-12), KEY (-7), CONSOLE_IN (-2).
 */
#include <tri27io.h>
#include <tgfx.h>

static char fb[23040];          /* mode 1 */
static char fbc[207360];        /* mode 2 */
static char cursor_bg[8 * 64];  /* fond sous le curseur (8 lignes, en trytes) */
static int cur_x = 300, cur_y = 200;

typedef struct { int x, y, w, h, open; char *title; } Win;
static Win wa = { 60, 50, 300, 160, 1, "Lisez-moi" };
static Win wb = { 380, 220, 170, 110, 1, "Corbeille" };

static int px(int x, int y) { return x + y * TRIT_W; }

/* --- dessin (mode courant) --- */
static int g_mode; /* 1 ou 2 */
#define C_TITLE_T  TRGB(0, 0, 6)      /* bleu profond façon Système 7 couleur */
#define C_TITLE    TRGB(0, 2, 8)
#define C_DESKTOP  TRGB(0, 3, 8)
#define C_WIN      TRGB(13, 13, 13)
#define C_DISK     TRGB(1, 7, 1)
#define C_TRASH    TRGB(6, 6, 6)
#define C_ICONSEL  TRGB(4, 2, 9)

static void putpixel(int x, int y, int c) {
  if (x < 0 || x >= TRIT_W || y < 0 || y >= TRIT_H) return;
  if (g_mode == 1) tg_pixel(x, y, c); else fbc[px(x, y)] = c;
}
static void fill(int x, int y, int w, int h, int c) {
  if (g_mode == 1) { tg_fillrect(x, y, w, h, c); return; }
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > TRIT_W) w = TRIT_W - x;
  if (y + h > TRIT_H) h = TRIT_H - y;
  for (int r = y; r < y + h; r++)
    for (int q = x; q < x + w; q++) fbc[px(q, r)] = c;
}
static void box(int x, int y, int w, int h, int c) {
  if (g_mode == 1) { tg_rect(x, y, w, h, c); return; }
  fill(x, y, w, 1, c); fill(x, y + h - 1, w, 1, c);
  fill(x, y + 1, 1, h - 2, c); fill(x + w - 1, y + 1, 1, h - 2, c);
}
static void dither(int x, int y, int w, int h, int a, int b) {
  if (g_mode == 1) { tg_fillrect(x, y, w, h, TG_DITHER(a, b)); return; }
  for (int r = y; r < y + h; r++)
    for (int q = x; q < x + w; q++) fbc[px(q, r)] = ((q + r) % 2 == 0) ? a : b;
}
static void text(int x, int y, const char *s, int c) {
  if (g_mode == 1) { tg_text(x, y, s, c); return; }
  for (int i = 0; s[i]; i++) {
    const short *glyph = TG_FONT + (s[i] - 32) * 5;
    for (int col = 0; col < 5; col++) {
      int b = glyph[col];
      for (int r = 0; b; r++, b /= 2)
        if (b % 2) putpixel(x + col, y + r, c);
    }
    x += 6;
  }
}

/* --- curseur flèche 8x12 (1 = noir), point chaude en (0,0) --- */
static const char CUR[12] = {
  0x10, 0x18, 0x14, 0x12, 0x11, 0x19, 0x15, 0x0B, 0x04, 0x04, 0x02, 0x00
};
static void save_cursor(void) {
  if (g_mode == 2) return; /* en couleur, on redessine tout (petit écran) */
  tg_save(cur_x / 9, cur_y, 8, 12, cursor_bg);
}
static void draw_cursor(void) {
  for (int r = 0; r < 12; r++) {
    int bits = CUR[r];
    for (int q = 0; q < 8; q++)
      if (bits & (1 << (7 - q))) putpixel(cur_x + q, cur_y + r, TG_BLACK);
  }
}
static void restore_cursor(void) {
  if (g_mode == 2) return;
  tg_restore(cur_x / 9, cur_y, 8, 12, cursor_bg);
}

/* --- icônes --- */
static void icon_disk(int x, int y, int sel) {
  box(x, y, 40, 34, TG_BLACK);
  fill(x + 1, y + 1, 38, 32, TG_WHITE);
  fill(x + 1, y + 1, 38, 10, TG_DITHER(TG_BLACK, TG_WHITE));
  fill(x + 6, y + 22, 28, 4, TG_BLACK);
  if (g_mode == 2) {
    box(x, y, 40, 34, C_ICONSEL);
    fill(x + 1, y + 1, 38, 10, C_TITLE);
    fill(x + 6, y + 22, 28, 4, C_DISK);
  }
  text(x + 2, y + 40, sel ? "3OS" : "3OS", TG_BLACK);
}
static void icon_trash(int x, int y) {
  box(x, y, 34, 40, TG_BLACK);
  fill(x + 1, y + 1, 32, 4, TG_GRAY);
  for (int r = 6; r < 39; r += 3) fill(x + 4, y + r, 26, 1, TG_BLACK);
  fill(x + 1, y + 1, 32, 3, TG_WHITE);
  text(x + 1, y + 44, "Corbeille", TG_BLACK);
}

/* --- fenêtres --- */
static void draw_win(Win *wn, int active) {
  if (!wn->open) return;
  int t = active ? TG_BLACK : TG_GRAY;
  box(wn->x, wn->y, wn->w, wn->h, TG_BLACK);
  fill(wn->x + 1, wn->y + 1, wn->w - 2, 12, TG_WHITE);
  dither(wn->x + 1, wn->y + 1, wn->w - 2, 12, TG_BLACK, TG_WHITE);
  /* case de fermeture à gauche */
  fill(wn->x + 3, wn->y + 3, 10, 8, TG_WHITE);
  box(wn->x + 3, wn->y + 3, 10, 8, TG_BLACK);
  fill(wn->x + 5, wn->y + 7, 6, 1, TG_BLACK);
  text(wn->x + 18, wn->y + 3, wn->title, TG_BLACK);
  fill(wn->x + 1, wn->y + 14, wn->w - 2, wn->h - 15, TG_WHITE);
  if (g_mode == 2) {
    fill(wn->x + 1, wn->y + 1, wn->w - 2, 12, active ? C_TITLE_T : C_TITLE);
    fill(wn->x + 1, wn->y + 14, wn->w - 2, wn->h - 15, C_WIN);
    text(wn->x + 18, wn->y + 3, wn->title, C_WIN);
  }
}

static void draw_all(int active_a) {
  if (g_mode == 1) { tg_noclip(); fill(0, 0, TRIT_W, TRIT_H, TG_GRAY); }
  else fill(0, 0, TRIT_W, TRIT_H, C_DESKTOP);
  /* barre de menus */
  fill(0, 0, TRIT_W, 18, TG_WHITE);
  if (g_mode == 2) fill(0, 0, TRIT_W, 18, C_TITLE_T);
  /* logo : petit triangle ternaire ∴ (3 points) */
  for (int q = 0; q < 3; q++) { putpixel(8 + q, 5, TG_BLACK); putpixel(8 + q, 12, TG_BLACK); }
  putpixel(9, 8, TG_BLACK); putpixel(9, 11, TG_BLACK); putpixel(10, 11, TG_BLACK);
  text(20, 4, "Fichier  Edition  Presentation  Special", TG_BLACK);
  if (g_mode == 2) text(20, 4, "Fichier  Edition  Presentation  Special", C_WIN);
  /* icônes */
  icon_disk(500, 40, 0);
  icon_trash(505, 290);
  /* fenêtres puis contenus */
  draw_win(&wa, active_a);
  draw_win(&wb, !active_a);
  text(wa.x + 10, wa.y + 24, "3OS v0.3 — bureau System 3", TG_BLACK);
  text(wa.x + 10, wa.y + 40, "Machine ternaire equilibree TRI-27.", TG_BLACK);
  text(wa.x + 10, wa.y + 52, "Tirez la barre de titre avec la souris.", TG_BLACK);
  text(wa.x + 10, wa.y + 64, "Touche C : couleur / trit. Q : quitter.", TG_BLACK);
  text(wa.x + 10, wa.y + 80, "Ternaire : -1, 0, +1. 27 trits par mot.", TG_BLACK);
  text(wa.x + 10, wa.y + 96, "Trit par pixel : le Mac 1-bit, mais 3.", TG_BLACK);
  text(wa.x + 10, wa.y + 120, "     ...      ..       ..", TG_BLACK);
  text(wb.x + 10, wb.y + 24, "(vide)", TG_BLACK);
}

static void present(void) {
  if (g_mode == 1) { tg_clip(0, 18, TRIT_W, TRIT_H - 18); save_cursor(); draw_cursor(); tg_noclip(); tg_present(); restore_cursor(); }
  else { draw_cursor(); FB_PRESENT = 0; }
}

static int hit(Win *wn, int mx, int my) {
  return wn->open && mx >= wn->x && mx < wn->x + wn->w && my >= wn->y && my < wn->y + 13;
}
static int in_close(Win *wn, int mx, int my) {
  return wn->open && mx >= wn->x + 3 && mx < wn->x + 13 && my >= wn->y + 3 && my < wn->y + 11;
}

int main(void) {
  g_mode = 1;
  tg_init(fb);
  draw_all(1);
  present();

  int dragging = 0, dx = 0, dy = 0, mx = 0, my = 0, btn = 0, frames = 0;
  long t0 = TIME_MS, tlast = t0;
  long last_repaint = 0;
  for (;;) {
    /* événements */
    mx = MOUSE_X; my = MOUSE_Y; btn = MOUSE_BTN;
    int k = KEY_EVENT;
    while (k) {
      int code = k > 0 ? k : -k;
      if (k > 0 && (code == 67 || code == 99)) { /* C : bascule couleur */
        restore_cursor();
        g_mode = (g_mode == 1) ? 2 : 1;
        if (g_mode == 1) tg_init(fb); else { VMODE = 2; FB_ADDR = (long)fbc; }
        draw_all(1);
        present();
      }
      if (k > 0 && (code == 81 || code == 27)) { /* Q / Échap */
        return 0;
      }
      k = KEY_EVENT;
    }
    if (mx != cur_x || my != cur_y) {
      restore_cursor();
      cur_x = mx; cur_y = my;
      draw_cursor();
      if (g_mode == 1) tg_present();
      else FB_PRESENT = 0;
      frames++;
    }
    if (btn & 1 && !dragging) {
      if (hit(&wa, mx, my)) { dragging = 1; dx = mx - wa.x; dy = my - wa.y; }
      else if (in_close(&wb, mx, my)) { wb.open = 0; draw_all(1); present(); }
      else if (in_close(&wa, mx, my)) { wa.open = 0; draw_all(0); present(); }
    }
    if ((btn & 1) && dragging) {
      int nx = mx - dx, ny = my - dy;
      if (nx < 0) nx = 0; if (ny < 18) ny = 18;
      if (nx > TRIT_W - wa.w) nx = TRIT_W - wa.w;
      if (ny > TRIT_H - 20) ny = TRIT_H - 20;
      if (nx != wa.x || ny != wa.y) {
        restore_cursor();
        wa.x = nx; wa.y = ny;
        draw_all(1);
        present();
      }
    }
    if (!(btn & 1)) dragging = 0;

    long t = TIME_MS;
    tlast = t;
    (void)last_repaint; (void)frames;
    if (t - t0 > 4000) break; /* démo : 4 s puis fin */
  }
  return frames;
}
