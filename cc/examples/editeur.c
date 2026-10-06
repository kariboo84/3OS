/* editeur.c — 3OS : éditeur de texte plein écran (mode TRIT).
 * Édite le fichier de données « lisez-moi » ; F2 enregistre, Échap enregistre et
 * quitte. Flèches, Entrée, Retour arrière, Origine/Fin. Le bureau affiche ensuite
 * le texte modifié : c'est la preuve d'écriture sur le disque. */
#include <stdio.h>
#include <tri27io.h>
#include <tgfx.h>
#include <3os.h>

#define FILE "lisez-moi"
#define CAP 2187
#define COLS 94
#define ROWS 31
static char fb[23040];
static char text[CAP + 1];
static long len, cur;
static char status[96] = "F2 : enregistrer   Echap : enregistrer et quitter";

static void save(void) {
  long r = sys_writefile(FILE, text, len);
  if (r < 0) sprintf(status, "ECHEC d'enregistrement (capacite %d)", CAP);
  else sprintf(status, "enregistre : %ld trytes sur le disque", r);
}

/* position (ligne, colonne) du curseur */
static void where(long pos, int *row, int *col) {
  int r = 0, c = 0;
  for (long i = 0; i < pos; i++) {
    if (text[i] == 10 || c == COLS - 1) { r++; c = 0; } else c++;
  }
  *row = r; *col = c;
}

static void draw(void) {
  tg_fillrect(0, 0, 576, 360, TG_WHITE);
  tg_fillrect(0, 0, 576, 14, TG_BLACK);
  tg_text(6, 4, "Editeur - " FILE, TG_WHITE);
  int r = 0, c = 0, crow, ccol;
  where(cur, &crow, &ccol);
  int top = crow >= ROWS ? crow - ROWS + 1 : 0;
  char ch[2] = {0, 0};
  for (long i = 0; i < len; i++) {
    if (text[i] != 10 && r >= top && r < top + ROWS) {
      ch[0] = text[i];
      tg_text(6 + c * 6, 20 + (r - top) * 10, ch, TG_BLACK);
    }
    if (text[i] == 10 || c == COLS - 1) { r++; c = 0; } else c++;
  }
  tg_fillrect(6 + ccol * 6, 19 + (crow - top) * 10, 6, 9, TG_GRAY);   /* curseur */
  tg_fillrect(0, 346, 576, 14, TG_GRAY);
  char buf[128];
  sprintf(buf, "%s   [%ld/%d]", status, len, CAP);
  tg_text(6, 350, buf, TG_BLACK);
  tg_present();
}

static void insert(int c) {
  if (len >= CAP) return;
  for (long i = len; i > cur; i--) text[i] = text[i - 1];
  text[cur++] = c;
  len++;
}

int main(void) {
  tg_init(fb);
  len = sys_readfile(FILE, text, CAP);
  if (len < 0) len = 0;
  cur = len;
  TEXT_INPUT = 1;
  draw();
  for (;;) {
    int dirty = 0, k, c;
    while ((k = KEY_EVENT) != 0) {
      if (k == 27) { save(); TEXT_INPUT = 0; return 0; }
      if (k == 113) { save(); dirty = 1; }                              /* F2 */
      if (k == 37 && cur > 0) { cur--; dirty = 1; }                     /* gauche */
      if (k == 39 && cur < len) { cur++; dirty = 1; }                   /* droite */
      if (k == 36) { while (cur > 0 && text[cur - 1] != 10) cur--; dirty = 1; }      /* Origine */
      if (k == 35) { while (cur < len && text[cur] != 10) cur++; dirty = 1; }        /* Fin */
      if (k == 38 || k == 40) {                                         /* haut / bas */
        int r, col, r2, c2;
        where(cur, &r, &col);
        long best = cur;
        for (long i = 0; i <= len; i++) {
          where(i, &r2, &c2);
          if (r2 == r + (k == 40 ? 1 : -1) && c2 <= col) best = i;
        }
        cur = best; dirty = 1;
      }
    }
    while ((c = CONSOLE_IN) >= 0) {
      if (c == 8) { if (cur > 0) { for (long i = cur - 1; i < len - 1; i++) text[i] = text[i + 1]; len--; cur--; } }
      else if (c == 10 || (c >= 32 && c < 127)) insert(c);
      else if (c == 27) { save(); TEXT_INPUT = 0; return 0; }
      dirty = 1;
    }
    if (dirty) draw(); else wfi();
  }
}
