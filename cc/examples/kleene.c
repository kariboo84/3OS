/* kleene.c — logique à 3 états native de TRI-27 : vérifie les instructions
 * ternaires contre une référence scalaire, trit par trit, et mesure TDOT. */
#include <stdio.h>
#include <tri27.h>
#include <tri27io.h>

static int trit(long v, int i) {            /* trit i de v, par divisions équilibrées (référence lente) */
  long x = v, t = 0;
  for (int k = 0; k <= i; k++) { t = x % 3; if (t > 1) t -= 3; if (t < -1) t += 3; x = (x - t) / 3; }
  return t;
}
static long pack(const int *t) {           /* trits → mot */
  long v = 0;
  for (int i = 26; i >= 0; i--) v = v * 3 + t[i];
  return v;
}
static unsigned long seed = 12345;
static int rnd3(void) { seed = seed * 1103515245 + 12345; return (int)((seed / 65536) % 3) - 1; }

int main(void) {
  const char *sym = "-0+";
  printf("Logique de Kleene sur TRI-27 (- faux, 0 inconnu, + vrai)\n");
  printf("  ET  | - 0 +     OU  | - 0 +\n");
  for (int a = -1; a <= 1; a++) {
    printf("   %c  |", sym[a + 1]);
    for (int b = -1; b <= 1; b++) printf(" %c", sym[T_AND(a, b) + 1]);
    printf("      %c  |", sym[a + 1]);
    for (int b = -1; b <= 1; b++) printf(" %c", sym[T_OR(a, b) + 1]);
    printf("\n");
  }

  /* 200 paires de mots aléatoires : chaque instruction comparée trit à trit */
  int bad = 0;
  for (int n = 0; n < 200; n++) {
    int ta[27], tb[27];
    for (int i = 0; i < 27; i++) { ta[i] = rnd3(); tb[i] = rnd3(); }
    long a = pack(ta), b = pack(tb);
    long vand = T_AND(a, b), vor = T_OR(a, b), vmul = T_MUL(a, b), vcons = T_CONS(a, b);
    long sum = 0, dot = 0;
    for (int i = 0; i < 27; i++) {
      int x = ta[i], y = tb[i];
      if (trit(vand, i) != (x < y ? x : y)) bad++;
      if (trit(vor, i) != (x > y ? x : y)) bad++;
      if (trit(vmul, i) != x * y) bad++;
      if (trit(vcons, i) != (x == y ? x : 0)) bad++;
      if (trit(T_NOT(a), i) != -x) bad++;
      sum += x; dot += x * y;
    }
    if (T_SUM(a) != sum) bad++;
    if (T_DOT(a, b) != dot) bad++;
  }
  printf("200 paires x 27 trits : %d erreur(s)\n", bad);

  /* coût : produit scalaire de 27 valeurs ternaires, scalaire vs TDOT */
  int ta[27], tb[27];
  for (int i = 0; i < 27; i++) { ta[i] = rnd3(); tb[i] = rnd3(); }
  long a = pack(ta), b = pack(tb), s1 = 0, s2 = 0;
  long c0 = CYCLES;
  for (int r = 0; r < 100; r++) for (int i = 0; i < 27; i++) s1 += ta[i] * tb[i];
  long c1 = CYCLES;
  for (int r = 0; r < 100; r++) s2 += T_DOT(a, b);
  long c2 = CYCLES;
  printf("produit scalaire 27 trits x100 : boucle %ld instr, TDOT %ld instr (%s)\n",
         c1 - c0, c2 - c1, s1 == s2 ? "meme resultat" : "DIFFERENT");
  return bad != 0;
}
