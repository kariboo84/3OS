// Banc d'essai du compilateur : boucles entières, pointeurs, chaînes, appels.
#include <stdio.h>
#include <string.h>
static long fib(long n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
static char buf[4096], dst[4096];
int main(void) {
  long s = 0;
  for (long i = 0; i < 20000; i++) s += i * 3 - (i / 7);
  for (int k = 0; k < 4000; k++) buf[k] = 'a' + k % 26;
  buf[4000] = 0;
  long tot = 0;
  for (int r = 0; r < 20; r++) { strcpy(dst, buf); tot += strlen(dst); memset(dst, 0, 4000); }
  long f = fib(18);
  printf("s=%ld tot=%ld fib=%ld\n", s, tot, f);
  return !(s == 571408571 && tot == 80000 && f == 2584);
}
