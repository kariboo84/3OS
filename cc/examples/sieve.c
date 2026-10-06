#include <stdio.h>
static char composite[100001];
int main(void) {
  int count=0;
  for(int i=2;i*i<=100000;i++)
    if(!composite[i]) for(int j=i*i;j<=100000;j+=i) composite[j]=1;
  for(int i=2;i<=100000;i++) count+=!composite[i];
  printf("primes <= 100000: %d\n",count);
  return count!=9592;
}
