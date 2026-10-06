#include <stdio.h>
#include <stdlib.h>
/* Exact pre-optimization reference, including ternary-word wraparound. */
long __tri_and(long,long);
long __tri_or(long,long);
long __tri_xor(long,long);
long __tri_shl(long,long);
long __tri_shr(long,long);
unsigned long __tri_udiv(unsigned long,unsigned long);
unsigned long __tri_ushr(unsigned long,long);
static long reference(long a,long b,int op) {
  long result=0, weight=1;
  for(int i=0;i<42;i++) {
    long x=a%2, y=b%2;
    if(x<0) x+=2;
    if(y<0) y+=2;
    if(i==41) weight=-weight;
    if((op==0 && x && y) || (op==1 && (x || y)) || (op==2 && x!=y)) result+=weight;
    a=(a-x)/2; b=(b-y)/2;
    if(i!=41) weight*=2;
  }
  return result;
}
static void eq(long got,long want) {
  if(got!=want) { printf("bitcheck FAIL: %ld != %ld\n",got,want); exit(1); }
}
static long values[]={-3812798742493L,-3812798742492L,-3812798742480L,
  -2199023255553L,-2199023255552L,-1099511627776L,-1025,-16,-15,-1,
  0,1,15,16,1023,1099511627776L,2199023255551L,2199023255552L,3812798742493L};
int main(void) {
  for(int i=0;i<sizeof(values)/sizeof(*values);i++) {
    long a=values[i];
    eq(a&0,0); eq(a|0,reference(a,0,1)); eq(0^a,reference(a,0,2));
    eq(a&255,reference(a,255,0)); eq(1023&a,reference(a,1023,0));
    for(int j=0;j<sizeof(values)/sizeof(*values);j++) {
      long b=values[j];
      eq(__tri_and(a,b),reference(a,b,0)); eq(a&b,reference(a,b,0));
      eq(__tri_or(a,b),reference(a,b,1)); eq(a|b,reference(a,b,1));
      eq(__tri_xor(a,b),reference(a,b,2)); eq(a^b,reference(a,b,2));
    }
    long left=a, right=a; unsigned long uright=(unsigned long)a;
    for(long k=0;k<42;k++) {
      eq(__tri_shl(a,k),left); eq(a<<k,left);
      eq(__tri_shr(a,k),right); eq(a>>k,right);
      eq(__tri_ushr((unsigned long)a,k),(long)uright);
      eq(((unsigned long)a)>>k,(long)uright);
      left*=2; long r=right%2; right=right/2-(r<0);
      uright=__tri_udiv(uright,2);
    }
  }
  int side=0; eq((side++ & 0),0); eq(side,1);
  eq((side++ | 0),1); eq(side,2); eq((255 & side++),2); eq(side,3);
  puts("bitcheck OK"); return 0;
}
