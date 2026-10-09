/* ternet.c — inférence d'un réseau de neurones ternaire sur TRI-27.
 * Poids, entrées et activations dans {-1,0,+1} ; chaque produit scalaire de 27
 * termes est UNE instruction TDOT. Vérifie chaque prédiction contre la référence
 * entière calculée sur l'hôte (ternet/train.py) et mesure le coût par image. */
#include <stdio.h>
#include <tri27.h>
#include <tri27io.h>
#include <tri27vec.h>
#include "ternet_model.h"

/* x : 3 mots (64 pixels ternaires) -> classe ; h_out reçoit les activations cachées */
static int classify(const long *x, long *h_out) {
  long h[TN_HW];
  for (int w = 0; w < TN_HW; w++) h[w] = 0;
  long p = 1;                                   /* 3^(j % 27) : position du trit caché */
  for (int j = 0; j < TN_H; j++) {
    const long *wj = TN_W1[j];
    long s = T_DOT(wj[0], x[0]) + T_DOT(wj[1], x[1]) + T_DOT(wj[2], x[2]);
    if (s > TN_TP[j]) h[j / 27] += p;            /* +1 : neurone « pour »   */
    else if (s < TN_TN[j]) h[j / 27] -= p;       /* -1 : neurone « contre » ; 0 : « sans avis » */
    p *= 3;
    if (j % 27 == 26) p = 1;
  }
  int best = 0;
  long bs = 0;
  for (int k = 0; k < 10; k++) {
    long s = 0;
    for (int w = 0; w < TN_HW; w++) s += T_DOT(TN_W2[k][w], h[w]);
    s = s * TN_S[k] + TN_C[k];
    if (k == 0 || s > bs) { bs = s; best = k; }
  }
  if (h_out) for (int w = 0; w < TN_HW; w++) h_out[w] = h[w];
  return best;
}

/* ---- même réseau avec les vecteurs (v0.5) : un produit scalaire de 81 trits = VLD + VTDOT ---- */
static int classify_vec(const long *x) {
  long h[TN_HW];
  for (int w = 0; w < TN_HW; w++) h[w] = 0;
  __builtin_vsetvl(9);                           /* 9 trytes = 3 mots = 81 trits */
  __builtin_vld(VP1, x);
  long p = 1;
  for (int j = 0; j < TN_H; j++) {
    __builtin_vld(VP2, TN_W1[j]);
    long s = __builtin_vtdot(VP2, VP1);
    if (s > TN_TP[j]) h[j / 27] += p;
    else if (s < TN_TN[j]) h[j / 27] -= p;
    p *= 3;
    if (j % 27 == 26) p = 1;
  }
  __builtin_vsetvl(TN_HW * 3);
  __builtin_vld(VP1, h);
  int best = 0;
  long bs = 0;
  for (int k = 0; k < 10; k++) {
    __builtin_vld(VP2, TN_W2[k]);
    long s = __builtin_vtdot(VP2, VP1) * TN_S[k] + TN_C[k];
    if (k == 0 || s > bs) { bs = s; best = k; }
  }
  return best;
}

/* ---- même réseau en version scalaire classique (un entier par poids), pour comparer ---- */
static signed char w1u[TN_H][81], w2u[10][TN_HW * 27], xu[81];
static void unpack(long v, signed char *t) {
  for (int i = 0; i < 27; i++) { long r = v % 3; if (r > 1) r -= 3; if (r < -1) r += 3; t[i] = r; v = (v - r) / 3; }
}
static int classify_scalar(void) {
  signed char h[TN_HW * 27];
  for (int j = 0; j < TN_H; j++) {
    long s = 0;
    for (int i = 0; i < 64; i++) s += w1u[j][i] * xu[i];
    h[j] = s > TN_TP[j] ? 1 : (s < TN_TN[j] ? -1 : 0);
  }
  int best = 0;
  long bs = 0;
  for (int k = 0; k < 10; k++) {
    long s = 0;
    for (int j = 0; j < TN_H; j++) s += w2u[k][j] * h[j];
    s = s * TN_S[k] + TN_C[k];
    if (k == 0 || s > bs) { bs = s; best = k; }
  }
  return best;
}

int main(void) {
  int ok = 0, same = 0;
  long c0 = CYCLES;
  for (int i = 0; i < TN_NTEST; i++) {
    int y = classify(TN_X[i], 0);
    if (y == TN_Y[i]) ok++;
    if (y == TN_HOST[i]) same++;
    else printf("  divergence image %d : VM %d, hote %d\n", i, y, TN_HOST[i]);
  }
  long c1 = CYCLES;
  printf("ternet : %d neurones caches, %d images de test\n", TN_H, TN_NTEST);
  printf("  precision VM : %d/%d (%ld.%ld %%)\n", ok, TN_NTEST, ok * 1000L / TN_NTEST / 10, ok * 1000L / TN_NTEST % 10);
  printf("  identique a la reference hote : %d/%d\n", same, TN_NTEST);
  printf("  cout TDOT : %ld instructions par image\n", (c1 - c0) / TN_NTEST);
  int samev = 0;
  long v0 = CYCLES;
  for (int i = 0; i < TN_NTEST; i++) if (classify_vec(TN_X[i]) == TN_HOST[i]) samev++;
  long v1 = CYCLES;
  printf("  cout vecteurs : %ld instructions par image (identique : %d/%d)\n", (v1 - v0) / TN_NTEST, samev, TN_NTEST);
  for (int j = 0; j < TN_H; j++) for (int w = 0; w < 3; w++) unpack(TN_W1[j][w], &w1u[j][w * 27]);
  for (int k = 0; k < 10; k++) for (int w = 0; w < TN_HW; w++) unpack(TN_W2[k][w], &w2u[k][w * 27]);
  long cost = 0;
  int same2 = 0;
  for (int i = 0; i < TN_NTEST; i++) {
    for (int w = 0; w < 3; w++) unpack(TN_X[i][w], &xu[w * 27]);   /* hors mesure */
    long a = CYCLES;
    int y = classify_scalar();
    cost += CYCLES - a;
    if (y == TN_HOST[i]) same2++;
  }
  printf("  cout scalaire : %ld instructions par image (identique : %d/%d)\n", cost / TN_NTEST, same2, TN_NTEST);
  return same != TN_NTEST || samev != TN_NTEST;
}
