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
#define COLS 90
#define ROWS 27
#define DOC_X 18
#define DOC_Y 38
#define LINE_H 10
static char fb[23040];
static char text[CAP + 1];
static long len, cur;
static char status[96] = "Document charge depuis le disque";

static int save(void) {
  long r = sys_writefile(FILE, text, len);
  if (r != len) {
    sprintf(status, "ECHEC d'enregistrement - document conserve");
    return 0;
  }
  sprintf(status, "Enregistre : %ld trytes sur le disque", r);
  return 1;
}

/* Consommer chaque caractere avant de passer a la ligne : aucun saut au pli. */
static void advance(int ch, int *row, int *col) {
  if (ch == 10) { (*row)++; *col = 0; }
  else {
    (*col)++;
    if (*col == COLS) { (*row)++; *col = 0; }
  }
}

/* position (ligne, colonne) du curseur */
static void where(long pos, int *row, int *col) {
  int r = 0, c = 0;
  for (long i = 0; i < pos; i++) {
    advance(text[i], &r, &c);
  }
  *row = r; *col = c;
}

static void draw(void) {
  tg_fillrect(0, 0, 576, 360, TG_GRAY);
  tg_rect(4, 4, 568, 352, TG_BLACK);
  tg_hline(5, 5, 566, TG_WHITE);
  tg_vline(5, 5, 350, TG_WHITE);
  /* Titre classique raye ; pas de bouton de fermeture sans gestion souris. */
  tg_fillrect(6, 6, 564, 20, TG_WHITE);
  for (int y = 9; y <= 21; y += 3) tg_hline(12, y, 552, TG_BLACK);
  const char *title = "Editeur - " FILE;
  int tw = tg_textw(title);
  int tx = (576 - tw) / 2;
  tg_fillrect(tx - 9, 7, tw + 18, 17, TG_WHITE);
  tg_text(tx, 12, title, TG_BLACK);
  tg_hline(5, 26, 566, TG_BLACK);
  /* Feuille blanche en retrait, ombre interieure et marges de lecture. */
  tg_rect(10, 31, 556, 283, TG_WHITE);
  tg_hline(10, 31, 556, TG_BLACK);
  tg_vline(10, 31, 283, TG_BLACK);
  tg_fillrect(11, 32, 554, 281, TG_WHITE);
  tg_hline(11, 32, 554, TG_GRAY);
  tg_vline(11, 32, 281, TG_GRAY);
  int r = 0, c = 0, crow, ccol;
  where(cur, &crow, &ccol);
  int top = crow >= ROWS ? crow - ROWS + 1 : 0;
  char ch[2] = {0, 0};
  for (long i = 0; i < len; i++) {
    if (text[i] != 10 && r >= top && r < top + ROWS) {
      ch[0] = text[i];
      tg_text(DOC_X + c * 6, DOC_Y + (r - top) * LINE_H, ch, TG_BLACK);
    }
    advance(text[i], &r, &c);
  }
  /* Le pixel precedant le glyphe appartient a l'espace inter-caracteres. */
  tg_vline(DOC_X - 1 + ccol * 6, DOC_Y - 1 + (crow - top) * LINE_H, 9, TG_BLACK);
  tg_hline(10, 319, 556, TG_BLACK);
  tg_hline(10, 320, 556, TG_WHITE);
  char buf[64];
  /* Champs distincts : les messages ne repoussent jamais le compteur. */
  tg_text(18, 325, status, TG_BLACK);
  sprintf(buf, "%ld / %d trytes", len, CAP);
  tg_text(558 - tg_textw(buf), 325, buf, TG_BLACK);
  tg_text(18, 342, "F2 : enregistrer   Echap : enregistrer et quitter", TG_BLACK);
  sprintf(buf, "L%ld C%ld", (long)crow + 1, (long)ccol + 1);
  tg_text(558 - tg_textw(buf), 342, buf, TG_BLACK);
  tg_present();
}

static void insert(int c) {
  if (len >= CAP) { sprintf(status, "Document plein - capacite atteinte"); return; }
  for (long i = len; i > cur; i--) text[i] = text[i - 1];
  text[cur++] = c;
  len++;
  sprintf(status, "Modifications non enregistrees");
}

int main(void) {
  tg_init(fb);
  len = sys_readfile(FILE, text, CAP);
  if (len < 0) { len = 0; sprintf(status, "Lecture impossible - document vide"); }
  cur = len;
  TEXT_INPUT = 1;
  draw();
  for (;;) {
    int dirty = 0, k, c;
    while ((k = KEY_EVENT) != 0) {
      if (k == 27) { if (save()) { TEXT_INPUT = 0; return 0; } dirty = 1; }
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
      if (c == 8) { if (cur > 0) { for (long i = cur - 1; i < len - 1; i++) text[i] = text[i + 1]; len--; cur--; sprintf(status, "Modifications non enregistrees"); } }
      else if (c == 10 || (c >= 32 && c < 127)) insert(c);
      else if (c == 27) { if (save()) { TEXT_INPUT = 0; return 0; } }
      dirty = 1;
    }
    if (dirty) draw(); else wfi();
  }
}
