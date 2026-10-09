/* hd.c — démo du mode vidéo 3 : 1920x1080, 1 mot par pixel, 19 683 niveaux par canal.
 * Haut : rouge croissant de gauche à droite, vert de haut en bas.
 * Bas : rampe de gris en 1920 pas sur 19 683 niveaux (≈ 10 niveaux par pixel : invisible en 8 bits,
 * mesurable dans la capture 16 bits). Une barre blanche se déplace sur 8 images. */
#include <stdio.h>
#include <tri27io.h>

#define W 1920
#define H 1080
#define MAXC 9841L

static long col[W];   /* terme rouge (trytes 2) par colonne */
static long gray[W];  /* gris : même niveau sur les 3 canaux */

int main(void) {
  long here;
  /* framebuffer sous la pile : W*H mots, aligné sur 3 */
  long *fb = (long *)((((long)&here - 100000L - (long)W * H * 3) / 3) * 3);
  FB_WIDTH = W;
  FB_HEIGHT = H;
  VMODE = 3;
  FB_ADDR = (long)fb;
  for (long x = 0; x < W; x++) {
    long v = -MAXC + x * (2 * MAXC) / (W - 1);
    col[x] = v * 387420489L;
    gray[x] = HD_RGB(v, v, v);
  }
  long t0 = CYCLES;
  for (long f = 0; f < 8; f++) {
    for (long y = 0; y < H; y++) {
      long *row = fb + y * W;
      if (y < H * 3 / 4) {
        long g = -MAXC + y * (2 * MAXC) / (H * 3 / 4 - 1);
        long rowterm = -MAXC + g * 19683L;   /* bleu au minimum, vert selon la ligne */
        for (long x = 0; x < W; x++) row[x] = rowterm + col[x];
      } else {
        for (long x = 0; x < W; x++) row[x] = gray[x];
      }
    }
    long bx = 100 + f * 200;
    for (long y = 200; y < 600; y++)
      for (long x = bx; x < bx + 40; x++) fb[y * W + x] = HD_RGB(MAXC, MAXC, MAXC);
    FB_PRESENT = 0;
  }
  long t1 = CYCLES;
  printf("hd : %dx%d, 1 mot/pixel, 8 images, %ld instr/image\n", W, H, (t1 - t0) / 8);
  return 0;
}
