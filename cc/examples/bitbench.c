#include <stdio.h>
/* All native comparison operations are defined: positive left shifts,
   bounded intermediates; negative right shifts require arithmetic GCC >>. */
int main(void) {
  long sum=0;
  for(long i=1;i<=200;i++) {
    long a=i*7919-900000, b=i*3571-400000, k=i%17;
    unsigned long u=i*12347;
    sum += (a&b) + (a|b) + (a^b);
    sum += (a&255) + (1023&b) + (a&0) + (a|0) + (a^0);
    sum += (i<<k) + (a>>k) + (u>>k) + (a>>3);
  }
  printf("bits checksum: %ld\n",sum);
  return 0;
}
