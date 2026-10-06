#include <stdlib.h>
/* Binary operations use a signed 42-bit two's-complement payload.
   No native ternary logic is mistaken for binary AND/OR/XOR. */
static long bitop(long a,long b,int op) {
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
long __tri_and(long a,long b) { return bitop(a,b,0); }
long __tri_or(long a,long b) { return bitop(a,b,1); }
long __tri_xor(long a,long b) { return bitop(a,b,2); }
long __tri_shl(long a,long k) { if(k<0 || k>41) abort(); while(k--) a*=2; return a; }
long __tri_shr(long a,long k) { if(k<0 || k>41) abort(); while(k--) { long r=a%2; a=a/2-(r<0); } return a; }
/* Ternary unsigned values are residues mod 3^27, negatives encode the upper half. */
static unsigned long udivrem(unsigned long a,unsigned long b,unsigned long *rem) {
  if(!b) abort();
  unsigned long result=0;
  while(a>=b) {
    unsigned long d=b, q=1;
    while(d<=3812798742493UL && d+d<=a) { d+=d; q+=q; }
    a-=d; result+=q;
  }
  *rem=a;
  return result;
}
unsigned long __tri_udiv(unsigned long a,unsigned long b) { unsigned long r; return udivrem(a,b,&r); }
unsigned long __tri_umod(unsigned long a,unsigned long b) { unsigned long r; udivrem(a,b,&r); return r; }
unsigned long __tri_ushr(unsigned long a,long k) { if(k<0 || k>41) abort(); while(k--) a=__tri_udiv(a,2); return a; }
