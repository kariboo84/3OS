/* vecb.c — enfant de vectest : écrase VP1 et VL, tourne assez longtemps pour être préempté. */
#include <stdio.h>
#include <tri27vec.h>

int main(void) {
  __builtin_vsetvl(5);
  long s = 0;
  for (long i = 0; i < 200000; i++) {
    __builtin_vsplat(VP1, i);
    s += __builtin_vsum(VP1);
  }
  printf("vecb : VP1 et VL ecrases (%ld)\n", s % 1000);
  return 7;
}
