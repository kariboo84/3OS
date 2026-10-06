#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <limits.h>
#include <stdint.h>
#include <stdbool.h>
#include <ctype.h>
#include <assert.h>
#include <tri27.h>
struct __attribute__((packed)) Packed { char c; int *p; };
static int value=1234567890123L;
static struct Packed packed={7,&value};
static long wrap=3812798742493L+1;
static unsigned long uq=((unsigned long)-1)/10, ur=((unsigned long)-1)%10;
static char chars[]={9841,-9841,9842,19682};
static unsigned char uchars[]={19682,9842};
static int huge_literal_type=_Generic(2147483648,int:1,long:2);
static int long_rank=_Generic(1+2L,long:1,default:0);
struct Pair { int x; char y; };
static struct Pair pair_fn(struct Pair p,int d) {p.x+=d;return p;}
static int many(int a,int b,int c,int d,int e,int f,int g,int h) {return a+b+c+d+e+f+g+h;}
static long varsum(int n,...) { va_list ap,copy; va_start(ap,n);va_copy(copy,ap);long sum=0;while(n--)sum+=va_arg(copy,long);va_end(copy);va_end(ap);return sum; }
int main(void) {
  assert(sizeof(int)==3 && sizeof(char)==1 && sizeof(void*)==3);
  assert(INT_MAX==3812798742493L && INT_MIN==-3812798742493L);
  assert(huge_literal_type==1 && long_rank==1);
  assert(packed.c==7 && *packed.p==value && sizeof(packed)==4);
  assert(wrap==INT_MIN);
  long maximum=INT_MAX; assert(maximum+1==wrap);
  assert(chars[0]==9841 && chars[1]==-9841 && chars[2]==-9841 && chars[3]==-1);
  assert(uchars[0]==19682 && uchars[1]==9842);
  assert(uq==762559748498L && ur==6);
  unsigned long u=-1; assert(u/10==uq && u%10==ur);
  assert(u>3812798742493UL && u+1==0 && u/1==u && u/u==1);
  assert((unsigned char)-1==19682);
  struct Pair p={100,9}; struct Pair q=pair_fn(p,23); assert(q.x==123 && q.y==9 && p.x==100);
  assert(many(1,2,3,4,5,6,7,8)==36);
  assert(varsum(8,1L,2L,3L,4L,5L,6L,7L,8L)==36);
  char buf[128];
  int len=snprintf(buf,sizeof(buf),"%05d %i %u %x %c %s %p %ld %lu %%",-12,7,42U,255U,'Q',"ok",(void*)27,-7L,99UL);
  assert(!strcmp(buf,"-0012 7 42 ff Q ok 0x1b -7 99 %")); assert(len==strlen(buf));
  assert(snprintf(buf,4,"abcdef")==6 && !strcmp(buf,"abc"));
  assert(snprintf(0,0,"hello %d",123)==9);
  sprintf(buf,"%u",u);assert(!strcmp(buf,"7625597484986"));
  sprintf(buf,"%-5s:%04d","a",12);assert(!strcmp(buf,"a    :0012"));
  char *heap=calloc(10,3);assert(heap && heap[29]==0 && (long)heap%3==0);
  strcpy(heap,"abc");strcat(heap,"def");assert(strlen(heap)==6 && !strcmp(heap,"abcdef"));
  memmove(heap+1,heap,6); assert(!memcmp(heap,"aabcdef",7));
  memmove(heap,heap+1,6);assert(!memcmp(heap,"abcdef",6));
  strncpy(heap,"xy",6);assert(heap[2]==0 && heap[5]==0);
  heap=realloc(heap,100);assert(heap && !strcmp(heap,"xy"));free(heap);
  assert(calloc(2000000,2)==0);
  assert(strchr("abca",'b')[0]=='b');assert(strrchr("abca",'a')[1]==0);
  assert(strstr("abcdef","cd")[2]=='e' && strstr("abc","z")==0);
  char *end;assert(strtol(" -0x7f!",&end,0)==-127 && *end=='!');
  assert(atoi(" -123")==-123 && abs(-42)==42);
  assert(isdigit('9') && !isdigit('x') && isalpha('Z') && isspace('\t'));
  assert(toupper('a')=='A' && tolower('Z')=='z');
  int a=-31,b=14; assert((a&b)==0 && (a|b)==-17 && (a^b)==-17 && ~a==30);
  assert((a>>2)==-8 && (b<<3)==112);
  assert(__builtin_sht(7,2)==63);
  assert(__builtin_tmin(1,-1)==-1 && __builtin_tmax(1,-1)==1);
  assert(__builtin_tmul(1,-1)==-1);
  puts("runtime: OK (types, ABI, packed relocation, unsigned, libc, binary, ternary)");
  return 0;
}
