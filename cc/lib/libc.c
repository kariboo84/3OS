#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <limits.h>

size_t strlen(const char *s) { size_t n=0; while(s[n]) n++; return n; }
int strcmp(const char *a,const char *b) { while(*a && *a==*b) {a++;b++;} return *a-*b; }
int strncmp(const char *a,const char *b,size_t n) { while(n && *a && *a==*b) {a++;b++;n--;} return n?*a-*b:0; }
char *strcpy(char *d,const char *s) { char *r=d; while((*d++=*s++)); return r; }
char *strncpy(char *d,const char *s,size_t n) { char *r=d; while(n && *s) {*d++=*s++;n--;} while(n--) *d++=0; return r; }
char *strcat(char *d,const char *s) { strcpy(d+strlen(d),s); return d; }
void *memset(void *d,int c,size_t n) { char *p=d; while(n--) *p++=c; return d; }
void *memcpy(void *d,const void *s,size_t n) { char *p=d; const char *q=s; while(n--) *p++=*q++; return d; }
void *memmove(void *d,const void *s,size_t n) { char *p=d; const char *q=s; if(p<q) return memcpy(d,s,n); while(n) {n--;p[n]=q[n];} return d; }
int memcmp(const void *a,const void *b,size_t n) { const unsigned char *p=a,*q=b; while(n--) {if(*p!=*q) return *p-*q;p++;q++;} return 0; }
char *strchr(const char *s,int c) { do {if(*s==c) return (char*)s;} while(*s++);return 0; }
char *strrchr(const char *s,int c) { char *r=0;do {if(*s==c) r=(char*)s;} while(*s++);return r; }
char *strstr(const char *s,const char *p) { size_t n=strlen(p); do {if(!strncmp(s,p,n)) return (char*)s;} while(*s++); return 0; }
int puts(const char *s) { while(*s) putchar(*s++); putchar('\n'); return 0; }
int isdigit(int c) { return c>='0' && c<='9'; }
int isalpha(int c) { return (c>='a' && c<='z') || (c>='A' && c<='Z'); }
int isalnum(int c) { return isalpha(c)||isdigit(c); }
int isspace(int c) { return c==' ' || (c>=9 && c<=13); }
int tolower(int c) { return c>='A' && c<='Z'?c+32:c; }
int toupper(int c) { return c>='a' && c<='z'?c-32:c; }
int abs(int n) { return n<0?-n:n; }
long labs(long n) { return n<0?-n:n; }
long strtol(const char *s,char **end,int base) {
  const char *orig=s; while(isspace(*s)) s++;
  int neg=0; if(*s=='-' || *s=='+') neg=*s++=='-';
  if((base==0 || base==16) && s[0]=='0' && (s[1]=='x'||s[1]=='X')) { base=16;s+=2; }
  if(!base) base=*s=='0'?8:10;
  if(base<2 || base>36) {if(end)*end=(char*)orig;return 0;}
  long n=0; int any=0;
  for(;;) { int c=tolower(*s),d=isdigit(c)?c-'0':c-'a'+10; if(d<0 || d>=base) break; n=n*base+d; s++;any=1; }
  if(end) *end=(char*)(any?s:orig);
  return neg?-n:n;
}
int atoi(const char *s) { return strtol(s,0,10); }
long atol(const char *s) { return strtol(s,0,10); }
extern char __tri_heap_start[];
static char *heap;
void *malloc(size_t n) {
  if(n>2000000UL) return 0;
  if(!heap) heap=__tri_heap_start;
  n=(n+2)/3*3;
  /* Conservative arena limit: default VM RAM is far larger. */
  if(heap+n+3>__tri_heap_start+2000000) return 0;
  *(size_t*)heap=n; char *r=heap+3; heap+=n+3; return r;
}
void free(void *p) { (void)p; }
void *calloc(size_t n,size_t size) { if(size && n>2000000UL/size) return 0; n*=size; void *p=malloc(n);if(p)memset(p,0,n);return p; }
void *realloc(void *p,size_t n) { if(!p)return malloc(n); if(!n)return 0; void *q=malloc(n);if(q) {size_t old=*((size_t*)p-1);memcpy(q,p,old<n?old:n);}return q; }

struct output {char *buf; size_t cap; size_t count; int console;};
static void emit(struct output *o,int c) {
  if(o->console) putchar(c);
  else if(o->cap && o->count<o->cap-1) o->buf[o->count]=c;
  o->count++;
}
static int format(struct output *o,const char *f,va_list ap) {
  while(*f) {
    if(*f!='%') {emit(o,*f++);continue;}
    f++; int zero=0,left=0,width=0,precision=-1;
    if(*f=='-') {left=1;f++;}
    if(*f=='0') {zero=1;f++;}
    if(*f=='*') {width=va_arg(ap,int);f++;} else while(isdigit(*f)) width=width*10+*f++-'0';
    if(*f=='.') { f++;precision=0; if(*f=='*') {precision=va_arg(ap,int);f++;} else while(isdigit(*f)) precision=precision*10+*f++-'0'; }
    while(*f=='l' || *f=='h' || *f=='z') f++;
    char spec=*f++; char buf[64]; char *s=buf; int len=0,neg=0;
    if(spec=='%') {buf[0]='%';len=1;}
    else if(spec=='c') {buf[0]=va_arg(ap,int);len=1;}
    else if(spec=='s') {s=va_arg(ap,char*);if(!s)s="(null)";len=strlen(s);if(precision>=0 && len>precision)len=precision;}
    else if(spec=='d'||spec=='i'||spec=='u'||spec=='x'||spec=='X'||spec=='p'||spec=='o') {
      long v=va_arg(ap,long); unsigned long u=v; int base=10;
      if(spec=='d'||spec=='i') {neg=v<0; u=neg?-v:v;}
      if(spec=='x'||spec=='X'||spec=='p')base=16;
      if(spec=='o')base=8;
      char digits[48];int n=0;
      do {int d=u%(unsigned long)base;digits[n++]=d<10?'0'+d:(spec=='X'?'A':'a')+d-10;u/=(unsigned long)base;} while(u);
      if(spec=='p') {buf[len++]='0';buf[len++]='x';}
      if(neg)buf[len++]='-';
      while(n)buf[len++]=digits[--n];
    } else {emit(o,'%');emit(o,spec);continue;}
    int padding=width>len?width-len:0;
    if(!left && zero && neg) {emit(o,'-');s++;len--;}
    if(!left) while(padding--)emit(o,zero?'0':' ');
    for(int i=0;i<len;i++)emit(o,s[i]);
    if(left)while(padding--)emit(o,' ');
  }
  if(!o->console && o->cap) o->buf[o->count<o->cap?o->count:o->cap-1]=0;
  return o->count;
}
int vsnprintf(char *b,size_t n,const char *f,va_list ap) {struct output o={b,n,0,0};return format(&o,f,ap);}
int vsprintf(char *b,const char *f,va_list ap) {return vsnprintf(b,3812798742493L,f,ap);}
int vprintf(const char *f,va_list ap) {struct output o={0,0,0,1};return format(&o,f,ap);}
int printf(const char *f,...) {va_list ap;va_start(ap,f);return vprintf(f,ap);}
int sprintf(char *b,const char *f,...) {va_list ap;va_start(ap,f);return vsprintf(b,f,ap);}
int snprintf(char *b,size_t n,const char *f,...) {va_list ap;va_start(ap,f);return vsnprintf(b,n,f,ap);}
void __tri_assert_fail(const char *expr,const char *file,int line) {printf("assertion failed: %s (%s:%d)\n",expr,file,line);exit(1);}
