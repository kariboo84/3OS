/* gpu.c — démo de la carte graphique 2D en 1920x1080 (mode 3, couleur profonde).
 * Le CPU dessine une seule fois un fond et un sprite ; ensuite chaque image n'est que des commandes :
 * 1 copie plein écran, 40 rectangles semi-transparents, 60 sprites à couleur transparente, 1 mélange. */
#include <stdio.h>
#include <gpu2d.h>

#define W 1920
#define H 1080
#define S 64            /* côté du sprite */
#define MAXC 9841L
#define NR 40
#define NS 60
#define FRAMES 120

static long rx[NR], ry[NR], rdx[NR], rdy[NR];
static long px[NS], py[NS], pdx[NS], pdy[NS];

int main(void) {
  long here;
  long top = (((long)&here - 100000L) / 3) * 3;
  long *screen = (long *)(top - (long)W * H * 3);
  long *bg = (long *)((long)screen - (long)W * H * 3);
  long *spr = (long *)((long)bg - (long)S * S * 3);
  long key = HD_RGB(MAXC, -MAXC, MAXC);           /* magenta = transparent */

  FB_WIDTH = W; FB_HEIGHT = H; VMODE = 3; FB_ADDR = (long)screen;

  /* fond : dégradé bleu nuit -> violet, dessiné une fois par le CPU */
  for (long y = 0; y < H; y++) {
    long t = -MAXC + y * (2 * MAXC) / (H - 1);
    long rowv = HD_RGB(t / 2 - MAXC / 2, -MAXC + (y % 64 == 0 ? 3000 : 0), t / 3 + MAXC / 3);
    long *row = bg + y * W;
    for (long x = 0; x < W; x++) row[x] = rowv + (x % 64 == 0 ? HD_RGB(0, 3000, 0) : 0);
  }
  /* sprite : disque ternaire (3 anneaux) sur fond transparent */
  for (long y = 0; y < S; y++)
    for (long x = 0; x < S; x++) {
      long dx = x - S / 2, dy = y - S / 2, d = dx * dx + dy * dy;
      long c = key;
      if (d < 30 * 30) c = HD_RGB(MAXC, MAXC / 2, -MAXC);
      if (d < 20 * 20) c = HD_RGB(-MAXC / 2, MAXC, MAXC / 3);
      if (d < 10 * 10) c = HD_RGB(MAXC, MAXC, MAXC);
      spr[y * S + x] = c;
    }
  for (long i = 0; i < NR; i++) { rx[i] = (i * 397) % (W - 300); ry[i] = (i * 211) % (H - 200); rdx[i] = 3 + i % 7; rdy[i] = 2 + i % 5; }
  for (long i = 0; i < NS; i++) { px[i] = (i * 733) % (W - S); py[i] = (i * 389) % (H - S); pdx[i] = 4 + i % 9; pdy[i] = -(3 + i % 6); }

  long c0 = CYCLES, t0 = TIME_MS, g0 = G_OPS;
  for (long f = 0; f < FRAMES; f++) {
    gpu_dst(0, W, H);
    gpu_src(bg, W, H);
    gpu_copy(0, 0, 0, 0, W, H);
    for (long i = 0; i < NR; i++) {
      long col = HD_RGB((i * 4919) % MAXC, (i * 7717) % MAXC - MAXC / 2, MAXC - (i * 3001) % MAXC);
      gpu_fill_alpha(rx[i], ry[i], 300, 200, col, 240);
      rx[i] += rdx[i]; ry[i] += rdy[i];
      if (rx[i] < 0 || rx[i] > W - 300) rdx[i] = -rdx[i];
      if (ry[i] < 0 || ry[i] > H - 200) rdy[i] = -rdy[i];
    }
    gpu_src(spr, S, S);
    for (long i = 0; i < NS; i++) {
      gpu_copy_key(0, 0, px[i], py[i], S, S, key);
      px[i] += pdx[i]; py[i] += pdy[i];
      if (px[i] < 0 || px[i] > W - S) pdx[i] = -pdx[i];
      if (py[i] < 0 || py[i] > H - S) pdy[i] = -pdy[i];
    }
    gpu_blend(0, 0, W / 2 - S, H / 2 - S, S, S, 365);   /* sprite à moitié transparent */
    FB_PRESENT = 0;
  }
  long c1 = CYCLES, t1 = TIME_MS, g1 = G_OPS;
  long ms = t1 - t0; if (ms < 1) ms = 1;
  printf("gpu : %dx%d, %d images, %ld instr/image, %ld commandes/image, %ld images/s\n",
         W, H, FRAMES, (c1 - c0) / FRAMES, (g1 - g0) / FRAMES, FRAMES * 1000 / ms);
  return 0;
}
