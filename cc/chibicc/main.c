#include "chibicc.h"
StringArray include_paths;
bool opt_fcommon=true, opt_fpic;
char *base_file;
bool file_exists(char *p) { struct stat s; return stat(p,&s)==0; }
int main(int argc,char **argv) {
  char *output=NULL; bool preprocess_only=false;
  init_macros();
  for(int i=1;i<argc;i++) {
    char *a=argv[i];
    if(!strcmp(a,"-o")) { output=argv[++i]; continue; }
    if(!strcmp(a,"-E")) { preprocess_only=true; continue; }
    if(!strcmp(a,"-S") || !strcmp(a,"-c")) continue;
    if(!strncmp(a,"-I",2)) { strarray_push(&include_paths,a[2]?a+2:argv[++i]); continue; }
    if(!strncmp(a,"-D",2)) { char *d=a[2]?a+2:argv[++i]; char *eq=strchr(d,'='); if(eq) define_macro(strndup(d,eq-d),eq+1); else define_macro(d,"1"); continue; }
    if(!strncmp(a,"-U",2)) { undef_macro(a[2]?a+2:argv[++i]); continue; }
    if(a[0]=='-') error("TRI27: unknown option %s",a);
    if(base_file) error("TRI27: use ../tri27cc.py for multiple files/linking");
    base_file=a;
  }
  if(!base_file) error("usage: chibicc [-E|-S] [-Ipath] [-Dname=value] file.c -o file.tas");
  strarray_push(&include_paths,format("%s/../include",dirname(strdup(argv[0]))));
  Token *t=tokenize_file(base_file);
  if(!t) error("cannot read %s",base_file);
  t=preprocess(t);
  FILE *f=output?fopen(output,"w"):stdout;
  if(!f) error("cannot create %s",output);
  if(preprocess_only) {
    for(Token *p=t;p->kind!=TK_EOF;p=p->next) fprintf(f,"%s%.*s",p->at_bol?"\n":p->has_space?" ":"",p->len,p->loc);
    fputc('\n',f);
  } else {
    for(Token *p=t;p->kind!=TK_EOF;p=p->next) {
      if(equal(p,"float") || equal(p,"double") || (p->ty && is_flonum(p->ty))) error_tok(p,"TRI27: floating point is not supported");
      if(p->kind==TK_STR && p->ty->base->size!=1) error_tok(p,"TRI27: wide strings are not supported");
    }
    codegen(parse(t),f);
  }
  if(f!=stdout) fclose(f);
  return 0;
}
