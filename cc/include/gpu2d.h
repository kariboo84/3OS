/* gpu2d.h — carte graphique 2D de TRI-27 (registres MMIO -60..-76, voir SPEC.md).
 * Surfaces au format du mode 3 : 1 mot (long) par pixel. Adresse 0 = l'écran (mode 3).
 * Une commande = quelques écritures de registres ; le travail pixel par pixel est fait par l'hôte. */
#ifndef GPU2D_H
#define GPU2D_H
#include <tri27io.h>

#define G_CMD    TRI27_MMIO(-60)
#define G_DST    TRI27_MMIO(-61)
#define G_DPITCH TRI27_MMIO(-62)
#define G_DH     TRI27_MMIO(-63)
#define G_SRC    TRI27_MMIO(-64)
#define G_SPITCH TRI27_MMIO(-65)
#define G_SH     TRI27_MMIO(-66)
#define G_X      TRI27_MMIO(-67)
#define G_Y      TRI27_MMIO(-68)
#define G_W      TRI27_MMIO(-69)
#define G_H      TRI27_MMIO(-70)
#define G_SX     TRI27_MMIO(-71)
#define G_SY     TRI27_MMIO(-72)
#define G_COLOR  TRI27_MMIO(-73)
#define G_ALPHA  TRI27_MMIO(-74)
#define G_STATUS TRI27_MMIO(-75)
#define G_OPS    TRI27_MMIO(-76)

#define GPU_FILL 1
#define GPU_COPY 2
#define GPU_COPY_KEY 3
#define GPU_BLEND 4
#define GPU_FILL_ALPHA 5
#define GPU_OPAQUE 729

/* destination / source : surface (0 = écran), largeur et hauteur en pixels */
static void gpu_dst(long *s, long w, long h) { G_DST = (long)s; G_DPITCH = w; G_DH = h; }
static void gpu_src(long *s, long w, long h) { G_SRC = (long)s; G_SPITCH = w; G_SH = h; }

static long gpu_rect(long x, long y, long w, long h) { G_X = x; G_Y = y; G_W = w; G_H = h; return 0; }

static long gpu_fill(long x, long y, long w, long h, long color) {
  gpu_rect(x, y, w, h); G_COLOR = color; G_CMD = GPU_FILL; return G_STATUS;
}
static long gpu_fill_alpha(long x, long y, long w, long h, long color, long alpha) {
  gpu_rect(x, y, w, h); G_COLOR = color; G_ALPHA = alpha; G_CMD = GPU_FILL_ALPHA; return G_STATUS;
}
static long gpu_copy(long sx, long sy, long x, long y, long w, long h) {
  gpu_rect(x, y, w, h); G_SX = sx; G_SY = sy; G_CMD = GPU_COPY; return G_STATUS;
}
/* copie en ignorant les pixels de couleur `key` (sprites) */
static long gpu_copy_key(long sx, long sy, long x, long y, long w, long h, long key) {
  gpu_rect(x, y, w, h); G_SX = sx; G_SY = sy; G_COLOR = key; G_CMD = GPU_COPY_KEY; return G_STATUS;
}
/* mélange source sur destination, alpha 0..729 */
static long gpu_blend(long sx, long sy, long x, long y, long w, long h, long alpha) {
  gpu_rect(x, y, w, h); G_SX = sx; G_SY = sy; G_ALPHA = alpha; G_CMD = GPU_BLEND; return G_STATUS;
}
#endif
