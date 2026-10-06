// tetris.c — Tetris pour la machine ternaire TRI-27 (compilé par le chibicc ternaire).
// Framebuffer 320x200 TRGB (canaux -13..13), clavier KEY_EVENT + CONSOLE_IN,
// musique Korobeiniki (air populaire russe, domaine public) et bruitages sur le TSG-3.
//
// Contrôles  clavier : flèches gauche/droite, haut = rotation, Z = rotation inverse,
//            bas = descente douce, espace = chute directe, P = pause, Échap = quitter,
//            Entrée/espace = rejouer après game over.
//            console : a/d gauche/droite, w rotation, z rotation inverse, s descente,
//            espace chute, p pause, r rejouer, q quitter (utilisable avec tri27 run --input).
//
// Coût : on ne redessine que les cellules qui changent (tableau shown[]) ; le fond n'est
// peint qu'une fois. Pas de & | ^ << >> (émulés en logiciel), % seulement hors boucle chaude.
#include <stdio.h>
#include <tri27io.h>

#define BW 10
#define BH 20
#define CS 9
#define BX 115
#define BY 10

static char fb[64000];

static int board[200], want[200], shown[200];
static int cbase[24], clight[24], cdark[24];

/* ---------------- tétriminos : I O T S Z J L ---------------- */
static int pn[7] = {4, 2, 3, 3, 3, 3, 3};
static int p0x[28] = {0,1,2,3,  0,1,0,1,  1,0,1,2,  1,2,0,1,  0,1,1,2,  0,0,1,2,  2,0,1,2};
static int p0y[28] = {1,1,1,1,  0,0,1,1,  0,1,1,1,  0,0,1,1,  0,0,1,1,  0,1,1,1,  0,1,1,1};
static int px[112], py[112]; /* [piece*16 + rot*4 + k] */
static char pname[] = "IOTSZJL";

/* ---------------- police 3x5 ---------------- */
static char gch[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-:<>/!.";
static char *gdat[] = {
  "####.##.##.####", ".#.##..#..#.###", "###..#####..###", "###..#.##..####", "#.##.####..#..#",
  "####..###..####", "####..####.####", "###..#..#.#..#.", "####.#####.####", "####.####..####",
  ".#.#.#####.##.#", "##.#.###.#.###.", ".###..#..#...##", "##.#.##.##.###.", "####..##.#..###",
  "####..##.#..#..", ".###..#.##.#.##", "#.##.#####.##.#", "###.#..#..#.###", "..#..#..##.#.#.",
  "#.##.###.#.##.#", "#..#..#..#..###", "#.########.##.#", "##.#.##.##.##.#", ".#.#.##.##.#.#.",
  "##.#.###.#..#..", ".#.#.##.###..##", "##.#.###.#.##.#", ".###...#...###.", "###.#..#..#..#.",
  "#.##.##.##.####", "#.##.##.##.#.#.", "#.##.########.#", "#.##.#.#.#.##.#", "#.##.#.#..#..#.",
  "###..#.#.#..###", "......###......", "....#.....#....", "..#.#.#...#...#", "#...#...#.#.#..",
  "..#..#.#.#..#..", ".#..#..#.....#.", ".............#."
};

/* ---------------- état ---------------- */
static long now, seed = 2187;
static int bag[7], bagi = 7;
static int cur, rot, cx, cy, nxt;
static int score, level, lines, best;
static int state;          /* 0 jeu, 1 lignes qui s'effacent, 2 animation game over, 3 game over */
static int paused, quit;
static long lastFall, stateEnd;
static int full[20], goRow;
static int keymode;        /* 1 dès qu'un KEY_EVENT arrive : on ignore alors CONSOLE_IN (doublons web) */
static int held[3];        /* gauche, droite, bas : auto-répétition */
static long rep[3];

static int shScore = -1, shLevel = -1, shLines = -1, shNext = -1, shBest = -1, ovDrawn = 0;

static int gravity[20] = {800,717,633,550,467,383,300,217,150,117,100,83,83,67,67,67,50,50,50,33};

/* ---------------- son (TSG-3) ---------------- */
static int ftab[57] = {41203,43654,46249,48999,51913,55000,58270,61735,65406,69296,73416,77782,
  82407,87307,92499,97999,103826,110000,116541,123471,130813,138591,146832,155563,164814,174614,
  184997,195998,207652,220000,233082,246942,261626,277183,293665,311127,329628,349228,369994,
  391995,415305,440000,466164,493883,523251,554365,587330,622254,659255,698456,739989,783991,
  830609,880000,932328,987767,1046502}; /* MIDI 28..84 en millihertz */

/* Korobeiniki : paires (note MIDI, durée en croches), 24 mesures de 8 croches. */
static int mel[] = {
  76,2, 71,1, 72,1, 74,2, 72,1, 71,1,   69,2, 69,1, 72,1, 76,2, 74,1, 72,1,
  71,3, 72,1, 74,2, 76,2,               72,2, 69,2, 69,2, 0,2,
  74,3, 77,1, 81,2, 79,1, 77,1,         76,3, 72,1, 76,2, 74,1, 72,1,
  71,2, 71,1, 72,1, 74,2, 76,2,         72,2, 69,2, 69,2, 0,2,
  76,2, 71,1, 72,1, 74,2, 72,1, 71,1,   69,2, 69,1, 72,1, 76,2, 74,1, 72,1,
  71,3, 72,1, 74,2, 76,2,               72,2, 69,2, 69,2, 0,2,
  74,3, 77,1, 81,2, 79,1, 77,1,         76,3, 72,1, 76,2, 74,1, 72,1,
  71,2, 71,1, 72,1, 74,2, 76,2,         72,2, 69,2, 69,2, 0,2,
  76,4, 72,4,  74,4, 71,4,  72,4, 69,4,  68,4, 71,4,
  76,4, 72,4,  74,4, 71,4,  72,2, 76,2, 81,4,  80,8
};
static int bassRoot[24] = {40,45,40,45, 38,36,40,45, 40,45,40,45, 38,36,40,45,
                           45,40,45,40, 45,40,45,40};
static int musicOn, mTick, melIdx, melLeft;
static long mNext, melOff, bassOff, sfxOff[9];

static void note_on(int v, int midi) {
  SND_GATE(v) = 0;
  SND_FREQ(v) = ftab[midi - 28];
  SND_GATE(v) = 1;
}

static void sfx(int v, int wave, long freq, int vol, int dur) {
  SND_GATE(v) = 0;
  SND_WAVE(v) = wave;
  SND_FREQ(v) = freq;
  SND_VOL(v) = vol;
  SND_ATTACK(v) = 1;
  SND_RELEASE(v) = 40;
  SND_GATE(v) = 1;
  sfxOff[v] = now + dur;
}

static void sound_init(void) {
  SND_WAVE(0) = WAVE_TRI3; SND_VOL(0) = 3000; SND_ATTACK(0) = 4; SND_RELEASE(0) = 70;
  SND_WAVE(1) = WAVE_TRI3; SND_VOL(1) = 2600; SND_ATTACK(1) = 3; SND_RELEASE(1) = 40;
}

static void music_start(void) {
  musicOn = 1; mTick = 0; melIdx = 0; melLeft = 0; mNext = now; melOff = 0; bassOff = 0;
}

static void music_stop(void) {
  musicOn = 0;
  SND_GATE(0) = 0; SND_GATE(1) = 0;
}

static void sound_update(void) {
  for (int v = 6; v < 9; v++)
    if (sfxOff[v] && now >= sfxOff[v]) { SND_GATE(v) = 0; sfxOff[v] = 0; }
  if (!musicOn) return;
  if (melOff && now >= melOff) { SND_GATE(0) = 0; melOff = 0; }
  if (bassOff && now >= bassOff) { SND_GATE(1) = 0; bassOff = 0; }
  if (now < mNext) return;
  int e = 200 - (level - 1) * 8;          /* la musique accélère avec le niveau */
  if (e < 120) e = 120;
  if (mTick == 0) { melIdx = 0; melLeft = 0; }
  if (melLeft == 0) {
    int n = mel[melIdx * 2], d = mel[melIdx * 2 + 1];
    melIdx++;
    melLeft = d;
    if (n) { note_on(0, n); melOff = now + d * e - 35; }
  }
  melLeft--;
  int b = bassRoot[mTick / 8];
  if (mTick - (mTick / 2) * 2) b += 12;
  note_on(1, b);
  bassOff = now + e * 55 / 100;
  mTick++;
  if (mTick >= 192) mTick = 0;
  mNext += e;
  if (mNext < now) mNext = now + e;
}

/* ---------------- dessin ---------------- */
static void fill(int x, int y, int w, int h, int c) {
  char *row = fb + y * 320 + x;
  for (int j = 0; j < h; j++) {
    char *p = row, *e = row + w;
    while (p < e) *p++ = c;
    row += 320;
  }
}

static void draw_char(int x, int y, int ch, int s, int col) {
  int g = -1;
  for (int i = 0; gch[i]; i++) if (gch[i] == ch) { g = i; break; }
  if (g < 0) return;
  char *d = gdat[g];
  for (int j = 0; j < 5; j++)
    for (int i = 0; i < 3; i++)
      if (d[j * 3 + i] == '#') fill(x + i * s, y + j * s, s, s, col);
}

static void draw_text(int x, int y, char *s, int sc, int col) {
  while (*s) { draw_char(x, y, *s, sc, col); x += 4 * sc; s++; }
}

static void draw_num(int x, int y, long n, int digits, int sc, int col, int bg) {
  char buf[12];
  fill(x, y, digits * 4 * sc, 5 * sc, bg);
  int i = digits;
  buf[i] = 0;
  do { long q = n / 10; buf[--i] = '0' + (n - q * 10); n = q; } while (n > 0 && i > 0);
  draw_text(x + i * 4 * sc, y, buf + i, sc, col);
}

#define C_EMPTY TRGB(-12, -12, -9)
#define C_GRID  TRGB(-10, -10, -6)
#define C_PANEL TRGB(-11, -11, -7)
#define C_EDGE  TRGB(-2, 1, 8)
#define C_LABEL TRGB(1, 9, 13)
#define C_VALUE TRGB(13, 13, 7)
#define C_WHITE TRGB(13, 13, 13)
#define C_DIM   TRGB(-3, -3, 2)

static void set_col(int v, int r, int g, int b) {
  cbase[v] = TRGB(r, g, b);
  clight[v] = TRGB(r + (13 - r) / 2, g + (13 - g) / 2, b + (13 - b) / 2);
  cdark[v] = TRGB(r - (r + 13) / 2, g - (g + 13) / 2, b - (b + 13) / 2);
}

/* une ligne de cellule : p[0]=a, p[1..7]=b, p[8]=c — déroulée, ~4x moins d'instructions qu'une boucle */
static void row9(char *p, int a, int b, int c) {
  p[0] = a; p[1] = b; p[2] = b; p[3] = b; p[4] = b; p[5] = b; p[6] = b; p[7] = b; p[8] = c;
}

static void draw_block(int x, int y, int v) {
  char *p = fb + y * 320 + x;
  if (v == 0) {
    row9(p, C_GRID, C_GRID, C_GRID);
    for (int j = 1; j < CS; j++) row9(p + j * 320, C_GRID, C_EMPTY, C_EMPTY);
  } else if (v >= 10) {               /* fantôme : contour de la couleur de la pièce */
    int c = cdark[v - 10];
    row9(p, C_EMPTY, C_EMPTY, C_EMPTY);
    row9(p + 320, C_EMPTY, c, C_EMPTY);
    for (int j = 2; j < 7; j++) { char *q = p + j * 320; row9(q, C_EMPTY, C_EMPTY, C_EMPTY); q[1] = c; q[7] = c; }
    row9(p + 7 * 320, C_EMPTY, c, C_EMPTY);
    row9(p + 8 * 320, C_EMPTY, C_EMPTY, C_EMPTY);
  } else {
    int l = clight[v], m = cbase[v], d = cdark[v];
    row9(p, l, l, l);
    for (int j = 1; j < 8; j++) row9(p + j * 320, l, m, d);
    row9(p + 8 * 320, l, d, d);
    p[642] = l; p[643] = l;
  }
}

static void panel(int x, int y, int w, int h) {
  fill(x - 2, y - 2, w + 4, h + 4, C_EDGE);
  fill(x - 1, y - 1, w + 2, h + 2, TRGB(-8, -6, 0));
  fill(x, y, w, h, C_PANEL);
}

static void draw_background(void) {
  for (int y = 0; y < 200; y++) {
    int b = -10 + y * 5 / 199, g = -13 + y * 3 / 199;
    char *p = fb + y * 320;
    int c = TRGB(-13, g, b), c2 = TRGB(-12, g + 1, b + 1);
    for (int x = 0; x < 320; x++) p[x] = ((x + y) / 3 - (x + y) / 9 * 3) ? c : c2; /* trame ternaire */
  }
  panel(8, 8, 96, 184);
  panel(216, 8, 96, 184);
  fill(BX - 4, BY - 4, BW * CS + 8, BH * CS + 8, C_EDGE);
  fill(BX - 2, BY - 2, BW * CS + 4, BH * CS + 4, TRGB(-6, -4, 3));
  fill(BX - 1, BY - 1, BW * CS + 2, BH * CS + 2, TRGB(-13, -13, -11));
  draw_text(16, 16, "SCORE", 2, C_LABEL);
  draw_text(16, 54, "LEVEL", 2, C_LABEL);
  draw_text(16, 92, "LINES", 2, C_LABEL);
  draw_text(224, 16, "NEXT", 2, C_LABEL);
  draw_text(224, 130, "BEST", 2, C_LABEL);
  draw_text(16, 136, "<> MOVE", 1, C_DIM);
  draw_text(16, 144, "UP/Z ROTATE", 1, C_DIM);
  draw_text(16, 152, "DOWN SOFT DROP", 1, C_DIM);
  draw_text(16, 160, "SPACE HARD DROP", 1, C_DIM);
  draw_text(16, 168, "P PAUSE ESC QUIT", 1, C_DIM);
  char *t = "TETRIS";
  for (int i = 0; i < 6; i++) draw_char(225 + i * 13, 86, t[i], 3, cbase[1 + (i * 3 + 2) - (i * 3 + 2) / 7 * 7]);
  draw_text(232, 108, "TRI-27", 2, C_DIM);
  draw_text(224, 176, "TERNARY C", 1, C_DIM);
}

/* ---------------- logique ---------------- */
static int rnd(int n) {
  seed = (seed * 421 + 1663) % 7875;
  return seed * n / 7875;
}

static int bag_next(void) {
  if (bagi >= 7) {
    for (int i = 0; i < 7; i++) bag[i] = i;
    for (int i = 6; i > 0; i--) { int j = rnd(i + 1), t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
    bagi = 0;
  }
  return bag[bagi++];
}

static int fits(int p, int r, int x, int y) {
  int *qx = px + p * 16 + r * 4, *qy = py + p * 16 + r * 4;
  for (int k = 0; k < 4; k++) {
    int a = x + qx[k], b = y + qy[k];
    if (a < 0 || a >= BW || b >= BH) return 0;
    if (b >= 0 && board[b * BW + a]) return 0;
  }
  return 1;
}

static void spawn(void) {
  cur = nxt;
  nxt = bag_next();
  rot = 0;
  cx = cur == 1 ? 4 : 3;
  cy = 0;
  lastFall = now;
#ifdef TRACE
  CONSOLE_OUT = pname[cur];
#endif
  if (!fits(cur, rot, cx, cy)) {
    state = 2; goRow = BH - 1; stateEnd = now;
    music_stop();
    sfx(8, WAVE_NOISE3, 300000, 4000, 900);
    if (score > best) best = score;
  }
}

static void new_game(void) {
  for (int i = 0; i < 200; i++) board[i] = 0;
  score = 0; level = 1; lines = 0; state = 0; paused = 0;
  nxt = bag_next();
  spawn();
  music_start();
}

static void lock_piece(void) {
  int *qx = px + cur * 16 + rot * 4, *qy = py + cur * 16 + rot * 4;
  int over = 0;
  for (int k = 0; k < 4; k++) {
    int b = cy + qy[k];
    if (b < 0) over = 1; else board[b * BW + cx + qx[k]] = cur + 1;
  }
  int n = 0;
  for (int y = 0; y < BH; y++) {
    int c = 0;
    for (int x = 0; x < BW; x++) if (board[y * BW + x]) c++;
    full[y] = c == BW;
    if (full[y]) { n++; for (int x = 0; x < BW; x++) board[y * BW + x] = 9; }
  }
  if (n) {
    static int pts[5] = {0, 40, 100, 300, 1200};
    score += pts[n] * level;
    lines += n;
    int nl = lines / 10 + 1;
    if (nl > level) { level = nl; sfx(6, WAVE_TRI3, 1318510, 2500, 350); }
    else sfx(6, WAVE_TRI3, n == 4 ? 1760000 : 1046502, 2500, n == 4 ? 450 : 200);
    sfx(8, WAVE_NOISE3, 6000000, 3500, n == 4 ? 450 : 250);
    state = 1; stateEnd = now + 280;
  } else {
    sfx(7, WAVE_NOISE3, 1500000, 3000, 60);
    if (over) { state = 2; goRow = BH - 1; stateEnd = now; music_stop(); if (score > best) best = score; }
    else spawn();
  }
}

static void collapse(void) {
  int d = BH - 1;
  for (int s = BH - 1; s >= 0; s--) {
    if (full[s]) continue;
    if (d != s) for (int x = 0; x < BW; x++) board[d * BW + x] = board[s * BW + x];
    d--;
  }
  for (; d >= 0; d--) for (int x = 0; x < BW; x++) board[d * BW + x] = 0;
  state = 0;
  spawn();
}

static void try_rotate(int dir) {
  if (cur == 1) return;
  int r = rot + dir;
  if (r > 3) r = 0;
  if (r < 0) r = 3;
  static int kx[6] = {0, -1, 1, -2, 2, 0};
  static int ky[6] = {0, 0, 0, 0, 0, -1};
  for (int i = 0; i < 6; i++) {
    if ((kx[i] == 2 || kx[i] == -2) && cur != 0) continue;
    if (fits(cur, r, cx + kx[i], cy + ky[i])) {
      rot = r; cx += kx[i]; cy += ky[i];
      sfx(6, WAVE_TRI3, 880000, 1800, 35);
      return;
    }
  }
}

enum { A_NONE, A_LEFT, A_RIGHT, A_SOFT, A_ROT, A_ROTCCW, A_HARD, A_PAUSE, A_QUIT, A_START };

static void act(int a) {
  if (a == A_QUIT) { quit = 1; return; }
  if (state >= 2) {
    if (state == 3 && (a == A_START || a == A_HARD || a == A_ROT)) new_game();
    return;
  }
  if (a == A_PAUSE) {
    paused = !paused;
    if (paused) { SND_GATE(0) = 0; SND_GATE(1) = 0; }
    else { lastFall = now; mNext = now; if (state == 1) stateEnd = now + 280; }
    return;
  }
  if (paused || state != 0) return;
  if (a == A_LEFT) { if (fits(cur, rot, cx - 1, cy)) cx--; }
  else if (a == A_RIGHT) { if (fits(cur, rot, cx + 1, cy)) cx++; }
  else if (a == A_ROT) try_rotate(1);
  else if (a == A_ROTCCW) try_rotate(-1);
  else if (a == A_SOFT) {
    if (fits(cur, rot, cx, cy + 1)) { cy++; score++; lastFall = now; }
    else lock_piece();
  } else if (a == A_HARD) {
    int d = 0;
    while (fits(cur, rot, cx, cy + 1)) { cy++; d++; }
    score += 2 * d;
    sfx(7, WAVE_NOISE3, 500000, 4000, 90);
    lock_piece();
  }
}

static int key_action(int k) {
  if (k == KEY_LEFT || k == 65) return A_LEFT;
  if (k == KEY_RIGHT || k == 68) return A_RIGHT;
  if (k == KEY_DOWN || k == 83) return A_SOFT;
  if (k == KEY_UP || k == 87 || k == 88) return A_ROT;
  if (k == 90) return A_ROTCCW;
  if (k == KEY_SPACE) return A_HARD;
  if (k == 80) return A_PAUSE;
  if (k == KEY_ESC || k == 81) return A_QUIT;
  if (k == KEY_ENTER || k == 82) return A_START;
  return A_NONE;
}

static int char_action(int c) {
  if (c == 'a') return A_LEFT;
  if (c == 'd') return A_RIGHT;
  if (c == 's') return A_SOFT;
  if (c == 'w' || c == 'x') return A_ROT;
  if (c == 'z') return A_ROTCCW;
  if (c == ' ') return A_HARD;
  if (c == 'p') return A_PAUSE;
  if (c == 'q' || c == 27) return A_QUIT;
  if (c == 'r' || c == '\n') return A_START;
  return A_NONE;
}

static void input(void) {
  long k;
  while ((k = KEY_EVENT) != 0) {
    keymode = 1;
    seed = (seed + now) % 7875;               /* l'humain apporte l'entropie */
    if (seed < 0) seed += 7875;
    int code = k > 0 ? k : -k, a = key_action(code), h = -1;
    if (a == A_LEFT) h = 0; else if (a == A_RIGHT) h = 1; else if (a == A_SOFT) h = 2;
    if (k > 0) {
      act(a);
      if (h >= 0) { held[h] = 1; rep[h] = now + (h == 2 ? 60 : 170); }
    } else if (h >= 0) held[h] = 0;
  }
  if (keymode) {
    while (CONSOLE_IN != -1) {}               /* le web double chaque touche en caractère */
    for (int h = 0; h < 3; h++)
      if (held[h] && now >= rep[h]) {
        act(h == 0 ? A_LEFT : h == 1 ? A_RIGHT : A_SOFT);
        rep[h] = now + (h == 2 ? 40 : 55);
      }
  } else {
    long c = CONSOLE_IN;                       /* un caractère par image : partie scriptée lisible */
    if (c != -1) act(char_action(c));
  }
}

static void update(void) {
  if (paused) return;
  if (state == 0) {
    int g = gravity[level > 20 ? 19 : level - 1];
    if (now - lastFall >= g) {
      lastFall = now;
      if (fits(cur, rot, cx, cy + 1)) cy++;
      else lock_piece();
    }
  } else if (state == 1) {
    if (now >= stateEnd) collapse();
  } else if (state == 2) {
    while (now >= stateEnd && goRow >= 0) {
      for (int x = 0; x < BW; x++) if (board[goRow * BW + x]) board[goRow * BW + x] = 8;
      goRow--;
      stateEnd += 30;
    }
    if (goRow < 0) state = 3;
  }
}

static void draw_overlay(int ov) {
  int x = BX + 5, y = BY + 66, w = BW * CS - 10;
  fill(x - 2, y - 2, w + 4, 52, C_EDGE);
  fill(x, y, w, 48, TRGB(-13, -12, -8));
  if (ov == 1) {
    draw_text(BX + 25, y + 12, "PAUSE", 2, C_VALUE);
    draw_text(BX + 31, y + 32, "P: GO", 1, C_DIM);
  } else {
    draw_text(BX + 29, y + 4, "GAME", 2, TRGB(13, -4, -6));
    draw_text(BX + 29, y + 18, "OVER", 2, TRGB(13, -4, -6));
    draw_text(BX + 17, y + 36, "SPACE: AGAIN", 1, C_DIM);
  }
}

static void render(void) {
  int ov = paused ? 1 : state == 3 ? 2 : 0;
  if (ov != ovDrawn && ov == 0) for (int i = 0; i < 200; i++) shown[i] = -1;
  if (ov == 0 || ov != ovDrawn) {
    for (int i = 0; i < 200; i++) want[i] = board[i];
    if (state == 0) {
      int *qx = px + cur * 16 + rot * 4, *qy = py + cur * 16 + rot * 4;
      int gy = cy;
      while (fits(cur, rot, cx, gy + 1)) gy++;
      for (int k = 0; k < 4; k++) {
        int b = gy + qy[k];
        if (b >= 0) want[b * BW + cx + qx[k]] = 10 + cur + 1;
      }
      for (int k = 0; k < 4; k++) {
        int b = cy + qy[k];
        if (b >= 0) want[b * BW + cx + qx[k]] = cur + 1;
      }
    }
    int i = 0;
    for (int r = 0; r < BH; r++)
      for (int c = 0; c < BW; c++, i++)
        if (want[i] != shown[i]) { draw_block(BX + c * CS, BY + r * CS, want[i]); shown[i] = want[i]; }
  }
  if (ov != ovDrawn) { if (ov) draw_overlay(ov); ovDrawn = ov; }
  if (score != shScore) { draw_num(16, 30, score, 10, 2, C_VALUE, C_PANEL); shScore = score; }
  if (level != shLevel) { draw_num(16, 68, level, 3, 2, C_VALUE, C_PANEL); shLevel = level; }
  if (lines != shLines) { draw_num(16, 106, lines, 5, 2, C_VALUE, C_PANEL); shLines = lines; }
  if (best != shBest) { draw_num(224, 144, best, 10, 2, C_VALUE, C_PANEL); shBest = best; }
  if (nxt != shNext) {
    fill(224, 32, 80, 40, C_PANEL);
    int *qx = px + nxt * 16, *qy = py + nxt * 16;
    int mnx = 9, mxx = -9, mny = 9, mxy = -9;
    for (int k = 0; k < 4; k++) {
      if (qx[k] < mnx) mnx = qx[k];
      if (qx[k] > mxx) mxx = qx[k];
      if (qy[k] < mny) mny = qy[k];
      if (qy[k] > mxy) mxy = qy[k];
    }
    int ox = 224 + (80 - (mxx - mnx + 1) * CS) / 2 - mnx * CS;
    int oy = 32 + (40 - (mxy - mny + 1) * CS) / 2 - mny * CS;
    for (int k = 0; k < 4; k++) draw_block(ox + qx[k] * CS, oy + qy[k] * CS, nxt + 1);
    shNext = nxt;
  }
}

int main(void) {
  set_col(1, -13, 10, 12);   /* I cyan */
  set_col(2, 12, 11, -13);   /* O jaune */
  set_col(3, 6, -13, 11);    /* T violet */
  set_col(4, -10, 12, -11);  /* S vert */
  set_col(5, 12, -11, -11);  /* Z rouge */
  set_col(6, -11, -6, 13);   /* J bleu */
  set_col(7, 13, 2, -13);    /* L orange */
  set_col(8, -5, -5, -3);    /* gris (game over) */
  set_col(9, 13, 13, 13);    /* blanc (lignes effacées) */
  for (int p = 0; p < 7; p++)
    for (int k = 0; k < 4; k++) {
      int x = p0x[p * 4 + k], y = p0y[p * 4 + k], n = pn[p];
      for (int r = 0; r < 4; r++) {
        px[p * 16 + r * 4 + k] = x;
        py[p * 16 + r * 4 + k] = y;
        int t = n - 1 - y; y = x; x = t;     /* rotation horaire dans la boîte n x n */
      }
    }
  for (int i = 0; i < 200; i++) shown[i] = -1;

  FB_ADDR = (long)fb;
  draw_background();
  sound_init();
  now = TIME_MS;
  new_game();

  long last = -1, sum = 0, mx = 0, frames = 0;
  while (!quit) {
    long t;
    while ((t = TIME_MS) == last) wfi();
    last = t; now = t;
    long c0 = CYCLES;
    input();
    update();
    sound_update();
    render();
    FB_PRESENT = 0;
    long d = CYCLES - c0;
    sum += d; frames++;
    if (d > mx) mx = d;
  }
  for (int v = 0; v < 9; v++) SND_GATE(v) = 0;
  printf("\ntetris: score %d, lignes %d, niveau %d | %d images, %d instr/image en moyenne, max %d\n",
         score, lines, level, frames, sum / frames, mx);
  return 0;
}
