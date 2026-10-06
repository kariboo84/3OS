#include <stdlib.h>
/* Generated nibble truth tables: binary C compatibility, no binary ISA. */
static const char and_table[256] = {
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,
  0,0,2,2,0,0,2,2,0,0,2,2,0,0,2,2,
  0,1,2,3,0,1,2,3,0,1,2,3,0,1,2,3,
  0,0,0,0,4,4,4,4,0,0,0,0,4,4,4,4,
  0,1,0,1,4,5,4,5,0,1,0,1,4,5,4,5,
  0,0,2,2,4,4,6,6,0,0,2,2,4,4,6,6,
  0,1,2,3,4,5,6,7,0,1,2,3,4,5,6,7,
  0,0,0,0,0,0,0,0,8,8,8,8,8,8,8,8,
  0,1,0,1,0,1,0,1,8,9,8,9,8,9,8,9,
  0,0,2,2,0,0,2,2,8,8,10,10,8,8,10,10,
  0,1,2,3,0,1,2,3,8,9,10,11,8,9,10,11,
  0,0,0,0,4,4,4,4,8,8,8,8,12,12,12,12,
  0,1,0,1,4,5,4,5,8,9,8,9,12,13,12,13,
  0,0,2,2,4,4,6,6,8,8,10,10,12,12,14,14,
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
};
static const char or_table[256] = {
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  1,1,3,3,5,5,7,7,9,9,11,11,13,13,15,15,
  2,3,2,3,6,7,6,7,10,11,10,11,14,15,14,15,
  3,3,3,3,7,7,7,7,11,11,11,11,15,15,15,15,
  4,5,6,7,4,5,6,7,12,13,14,15,12,13,14,15,
  5,5,7,7,5,5,7,7,13,13,15,15,13,13,15,15,
  6,7,6,7,6,7,6,7,14,15,14,15,14,15,14,15,
  7,7,7,7,7,7,7,7,15,15,15,15,15,15,15,15,
  8,9,10,11,12,13,14,15,8,9,10,11,12,13,14,15,
  9,9,11,11,13,13,15,15,9,9,11,11,13,13,15,15,
  10,11,10,11,14,15,14,15,10,11,10,11,14,15,14,15,
  11,11,11,11,15,15,15,15,11,11,11,11,15,15,15,15,
  12,13,14,15,12,13,14,15,12,13,14,15,12,13,14,15,
  13,13,15,15,13,13,15,15,13,13,15,15,13,13,15,15,
  14,15,14,15,14,15,14,15,14,15,14,15,14,15,14,15,
  15,15,15,15,15,15,15,15,15,15,15,15,15,15,15,15
};
static const char xor_table[256] = {
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
  1,0,3,2,5,4,7,6,9,8,11,10,13,12,15,14,
  2,3,0,1,6,7,4,5,10,11,8,9,14,15,12,13,
  3,2,1,0,7,6,5,4,11,10,9,8,15,14,13,12,
  4,5,6,7,0,1,2,3,12,13,14,15,8,9,10,11,
  5,4,7,6,1,0,3,2,13,12,15,14,9,8,11,10,
  6,7,4,5,2,3,0,1,14,15,12,13,10,11,8,9,
  7,6,5,4,3,2,1,0,15,14,13,12,11,10,9,8,
  8,9,10,11,12,13,14,15,0,1,2,3,4,5,6,7,
  9,8,11,10,13,12,15,14,1,0,3,2,5,4,7,6,
  10,11,8,9,14,15,12,13,2,3,0,1,6,7,4,5,
  11,10,9,8,15,14,13,12,3,2,1,0,7,6,5,4,
  12,13,14,15,8,9,10,11,4,5,6,7,0,1,2,3,
  13,12,15,14,9,8,11,10,5,4,7,6,1,0,3,2,
  14,15,12,13,10,11,8,9,6,7,4,5,2,3,0,1,
  15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0
};
/* Ten low nibbles, then the signed two-bit top digit: exactly 42 bits.
   Euclidean remainders are required for negative inputs (C % truncates). */
static long bitop(long a,long b,const char *table) {
  /* Preserve the old bit loop's minimum-word wraparound: (MIN-1)/2
     wraps to MAX/2. All other inputs use ordinary Euclidean digits. */
  if(a==-3812798742493L) a=3812798742493L;
  if(b==-3812798742493L) b=3812798742493L;
  long result=0, weight=1;
  for(int i=0;i<10;i++) {
    long x=a%16, y=b%16;
    if(x<0) x+=16;
    if(y<0) y+=16;
    result+=table[x*16+y]*weight;
    a=a/16-(a%16<0); b=b/16-(b%16<0); weight*=16;
  }
  long x=a%4, y=b%4;
  if(x<0) x+=4;
  if(y<0) y+=4;
  long top=table[x*16+y];
  if(top>=2) top-=4;
  return result+top*weight;
}
long __tri_and(long a,long b) { return bitop(a,b,and_table); }
long __tri_or(long a,long b) { return bitop(a,b,or_table); }
long __tri_xor(long a,long b) { return bitop(a,b,xor_table); }
static const long powers[42] = {
  1,2,4,8,16,32,64,128,256,512,1024,2048,4096,8192,16384,32768,65536,131072,262144,524288,1048576,2097152,4194304,8388608,16777216,33554432,67108864,134217728,268435456,536870912,1073741824,2147483648,4294967296,8589934592,17179869184,34359738368,68719476736,137438953472,274877906944,549755813888,1099511627776,2199023255552
};
long __tri_shl(long a,long k) { if(k<0 || k>41) abort(); return a*powers[k]; }
long __tri_shr(long a,long k) {
  if(k<0 || k>41) abort();
  long d=powers[k];
  return a/d-(a%d<0);
}
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
unsigned long __tri_ushr(unsigned long a,long k) {
  if(k<0 || k>41) abort();
  if(!k) return a;
  if((long)a>=0) return (long)a/powers[k];
  return __tri_udiv(a,powers[k]);
}
