// TRI-27 stack backend. See ../README.md for the home-area ABI.
#include "chibicc.h"
static FILE *out;
static Obj *fn;
static int serial;
static void emit(char *fmt, ...);
// Expression stack: the first NSREG temporaries live in callee-saved s1..s10,
// deeper ones fall back to the memory stack. Saved/restored per function.
#define NSREG 10
static int depth, maxdepth;
// Promotion en registres : les variables locales scalaires dont l'adresse n'est
// jamais prise vivent dans s10, s9, ... ; la pile d'expressions garde s1..s(nsreg).
#define MAXPROMO 6
static Obj *promo[MAXPROMO];
static int npromo, nsreg=NSREG;
static int reg_of(Obj *v) {
  for(int i=0;i<npromo;i++) if(promo[i]==v) return 10-i;
  return 0;
}
static bool scalar(Type *t);
/* Conversions sans code sur TRI-27 : toutes sauf vers bool/char (cf. cast()). */
static bool const_val(Node *n, long *v);
static Node *nocast(Node *n) {
  long one;
  for(;;) {
    if(n && n->kind==ND_CAST && n->ty && n->ty->kind!=TY_BOOL && n->ty->kind!=TY_CHAR &&
       n->lhs->ty && scalar(n->lhs->ty) && n->ty->kind!=TY_VOID) { n=n->lhs; continue; }
    /* x*1 (index de tableau de char) : identité */
    if(n && n->kind==ND_MUL && const_val(n->rhs,&one) && one==1) { n=n->lhs; continue; }
    return n;
  }
}
static int reg_var(Node *n) { n=nocast(n); return n && n->kind==ND_VAR ? reg_of(n->var) : 0; }
static bool const_val(Node *n, long *v);
static bool fits16(long v);
/* Opérande « simple » : variable en registre (aucun code) ou constante 16 trits
 * (au plus un li dans `scratch`). */
/* constante, y compris sous une conversion en char si elle tient déjà sur une tryte */
static bool small_const(Node *n, long *k) {
  n=nocast(n);
  if(n->kind==ND_CAST && n->ty->kind==TY_CHAR && const_val(nocast(n->lhs),k)) return *k>=-9841 && *k<=9841 && !(n->ty->is_unsigned && *k<0);
  return const_val(n,k) && fits16(*k);
}
static bool simple(Node *n) {
  long k;
  return reg_var(n) || small_const(n,&k);
}
static char opbuf[4][8]; static int opi;
static const char *operand(Node *n, const char *scratch) {
  char *b=opbuf[opi++%4];
  int r=reg_var(n); long k;
  if(r) { sprintf(b,"s%d",r); return b; }
  small_const(n,&k);
  if(k==0) return "zero";
  emit("  li %s, %ld",scratch,k); return scratch;
}
static void spush(void) {
  if(depth<nsreg) emit("  mv s%d, a0",depth+1); else emit("  push a0");
  depth++; if(depth>maxdepth) maxdepth=depth;
}
static void spop(char *r) {
  depth--;
  if(depth<nsreg) emit("  mv %s, s%d",r,depth+1); else emit("  pop %s",r);
}
static bool scalar(Type *t) {
  return !(t->kind==TY_STRUCT||t->kind==TY_UNION||t->kind==TY_ARRAY||t->kind==TY_FUNC||t->kind==TY_VLA);
}
static bool fits16(long v) { return v>=-21523360L && v<=21523360L; }
static bool const_val(Node *n, long *v) {
  while(n->kind==ND_CAST && n->ty->size==3 && n->ty->kind!=TY_BOOL && !is_flonum(n->ty) && !is_flonum(n->lhs->ty)) n=n->lhs;
  if(n->ty && is_flonum(n->ty)) return false;
  long a,b;
  switch(n->kind) {
  case ND_NUM: *v=(long)tri_wrap(n->val,7625597484987L); return true;
  case ND_NEG: if(!const_val(n->lhs,&a)) return false; *v=-a; return true;
  case ND_ADD: case ND_SUB: case ND_MUL:
    if(!n->ty || n->ty->size!=3 || !const_val(n->lhs,&a) || !const_val(n->rhs,&b)) return false;
    if(a>21523360L||a<-21523360L||b>21523360L||b<-21523360L) return false;   // évite tout débordement hôte
    *v = n->kind==ND_ADD ? a+b : n->kind==ND_SUB ? a-b : a*b;
    *v=(long)tri_wrap(*v,7625597484987L); return true;
  default: return false;
  }
}
// Direct scalar variable (local non-VLA or global): returns 1 and fills the address operand.
static bool direct_var(Node *n, char *buf) {
  if(n->kind!=ND_VAR || !scalar(n->ty)) return false;
  Obj *v=n->var;
  if(v->is_local) { sprintf(buf,"%d(fp)",v->offset); return true; }
  if(v->is_tls) return false;
  sprintf(buf,"%s(zero)",v->name); return true;
}
static void expr(Node *n);
static void stmt(Node *n);
static void discard(Node *n);
static int postinc_reg(Node *n, long *kout);
static void branch_false(Node *n, int id, const char *prefix);
static void emit(char *fmt, ...) {
  va_list ap; va_start(ap,fmt); vfprintf(out,fmt,ap); va_end(ap); fputc('\n',out);
}
int align_to(int n,int a) { return (n+a-1)/a*a; }
static bool aggregate(Type *t) { return t->kind==TY_STRUCT || t->kind==TY_UNION; }
static void check(Type *t) {
  if (!t) return;
  if (is_flonum(t)) error("TRI27: floating point is not supported");
  if (t->kind==TY_ARRAY) check(t->base);
  if (aggregate(t)) for(Member *m=t->members;m;m=m->next) {
    if(m->is_bitfield) error("TRI27: bitfields are not supported");
    check(m->ty);
  }
}
static void cast(Type *t) {
  if(t->kind==TY_BOOL) { emit("  seq a0, a0, zero"); emit("  seq a0, a0, zero"); }
  else if(t->kind==TY_CHAR) {
    emit("  sxt a0, a0");
    if(t->is_unsigned) { int id=serial++; emit("  bgez a0, .L.uc%d",id); emit("  addi a0, a0, 19683"); emit(".L.uc%d:",id); }
  }
}
static void copy(int size) { // a0 source, t0 dest; preserve both
  int id=serial++;
  emit("  mv t1, a0"); emit("  mv t2, t0"); emit("  li t3, %d",size);
  emit(".L.copy%d:",id); emit("  beqz t3, .L.cend%d",id);
  emit("  ldt t4, 0(t1)"); emit("  stt t4, 0(t2)");
  emit("  addi t1, t1, 1"); emit("  addi t2, t2, 1"); emit("  addi t3, t3, -1");
  emit("  j .L.copy%d",id); emit(".L.cend%d:",id);
}
/* ---- choix des variables promues ---- */
typedef struct { Obj *v; long w; int bad; } Cand;
static Cand cand[512];
static int ncand;
static Cand *cand_of(Obj *v) {
  for(int i=0;i<ncand;i++) if(cand[i].v==v) return &cand[i];
  return NULL;
}
static void scan(Node *n, long w) {
  for(;n;n=n->next) {
    if(n->kind==ND_ADDR || n->kind==ND_CAS || n->kind==ND_EXCH ||
       (n->kind==ND_ASSIGN && n->lhs && n->lhs->kind!=ND_VAR)) {
      /* toute variable sous un & (même via membre/cast) est exclue */
      Node *x=n->lhs;
      while(x && (x->kind==ND_MEMBER || x->kind==ND_CAST || x->kind==ND_COMMA)) x = x->kind==ND_COMMA ? x->rhs : x->lhs;
      if(x && x->kind==ND_VAR) { Cand *c=cand_of(x->var); if(c) c->bad=1; }
    }
    if(n->kind==ND_VAR) { Cand *c=cand_of(n->var); if(c) c->w+=w; }
    long w2 = (n->kind==ND_FOR || n->kind==ND_DO) ? (w<100000 ? w*8 : w) : w;
    scan(n->lhs,w); scan(n->rhs,w); scan(n->cond,w2); scan(n->then,w2); scan(n->els,w);
    scan(n->init,w); scan(n->inc,w2); scan(n->body,n->kind==ND_FOR||n->kind==ND_DO?w2:w); scan(n->args,w);
    if(n->kind==ND_FOR || n->kind==ND_DO || n->kind==ND_IF || n->kind==ND_SWITCH ||
       n->kind==ND_BLOCK || n->kind==ND_STMT_EXPR || n->kind==ND_FUNCALL) {}
    /* les listes body/args sont parcourues par la boucle sur next ci-dessus via scan(body) */
  }
}
static void choose_promoted(Obj *f) {
  npromo=0; nsreg=NSREG; ncand=0;
  if(getenv("TRI27_NOREG")) return;
  for(Obj *v=f->locals;v && ncand<512;v=v->next) {
    if(!scalar(v->ty) || v->ty->kind==TY_VLA || v->ty->is_atomic || v->is_tls || !v->is_local) continue;
    if(f->va_area==v || f->alloca_bottom==v) continue;
    cand[ncand++] = (Cand){v,0,0};
  }
  scan(f->body,1);
  for(int k=0;k<MAXPROMO;k++) {
    Cand *best=NULL;
    for(int i=0;i<ncand;i++) if(!cand[i].bad && cand[i].w>0 && (!best || cand[i].w>best->w)) best=&cand[i];
    if(!best) break;
    promo[npromo++]=best->v; best->bad=1;
  }
  nsreg=NSREG-npromo;
}

static void addr(Node *n) {
  switch(n->kind) {
  case ND_VAR:
    if(reg_var(n)) error_tok(n->tok,"TRI27: internal: address of register variable");
    if(n->var->is_local) emit("  %s a0, %s, %d",n->ty->kind==TY_VLA?"addi":"addi","fp",n->var->offset);
    else emit("  addi a0, zero, %s",n->var->name);
    if(n->ty->kind==TY_VLA) emit("  ldw a0, 0(a0)");
    return;
  case ND_VLA_PTR: emit("  addi a0, fp, %d",n->var->offset); return;
  case ND_DEREF: expr(n->lhs); return;
  case ND_MEMBER:
    if(n->member->is_bitfield) error_tok(n->tok,"TRI27: bitfields are not supported");
    addr(n->lhs); emit("  addi a0, a0, %d",n->member->offset); return;
  case ND_COMMA: expr(n->lhs); addr(n->rhs); return;
  case ND_FUNCALL: case ND_ASSIGN: case ND_COND:
    if(aggregate(n->ty)) { expr(n); return; }
  default: error_tok(n->tok,"TRI27: not an lvalue");
  }
}
static void load(Type *t) {
  if(aggregate(t)||t->kind==TY_ARRAY||t->kind==TY_FUNC||t->kind==TY_VLA) return;
  emit("  %s a0, 0(a0)",t->size==1?"ldt":"ldw");
  if(t->kind==TY_CHAR && t->is_unsigned) cast(t);
}
/* Intrinsèques ternaires : une instruction en ligne, sans appel. */
static const char *builtin_op(Node *n, int *nargs) {
  static const struct { const char *name, *op; int n; } B[] = {
    {"__builtin_tmin","min",2},{"__builtin_tmax","max",2},{"__builtin_tmul","tmul",2},
    {"__builtin_tcons","cons",2},{"__builtin_tany","any",2},{"__builtin_sht","sht",2},
    {"__builtin_tsum","tsum",1},{"__builtin_tdot","tdot",2},
  };
  if(n->lhs->kind!=ND_VAR || n->ret_buffer) return NULL;
  for(int i=0;i<(int)(sizeof B/sizeof B[0]);i++) if(!strcmp(n->lhs->var->name,B[i].name)) {
    int c=0; for(Node *a=n->args;a;a=a->next) c++;
    if(c!=B[i].n) return NULL;
    *nargs=c; return B[i].op;
  }
  return NULL;
}

/* Intrinsèques vectoriels (v0.5) : une instruction en ligne par appel.
 * Arguments : registre vectoriel = ENTIER CONSTANT 0..26 (bit de vmask à 1, indice = nom + 13) ;
 * au plus UN argument scalaire (bit à 0), évalué dans a0. Résultat scalaire éventuel dans a0.
 * Gabarit : %0, %1… = arguments dans l'ordre (nom de registre vectoriel ou a0). */
static const char *vbuiltin_op(Node *n, int *nargs, int *vmask) {
  static const struct { const char *name; int n; int vmask; const char *fmt; } V[] = {
    {"__builtin_vsetvl", 1, 0x0, "vsetvl a0, %0"},
    {"__builtin_vld",    2, 0x1, "vld %0, 0(%1)"},
    {"__builtin_vst",    2, 0x1, "vst %0, 0(%1)"},
    {"__builtin_vsplat", 2, 0x1, "vsplat.t %0, %1"},
    {"__builtin_vsplatw",2, 0x1, "vsplat.w %0, %1"},
    {"__builtin_vtdot",  2, 0x3, "vtdot a0, %0, %1"},
    {"__builtin_vtmac",  2, 0x3, "vtmac.t a0, %0, %1"},
    {"__builtin_vsum",   1, 0x1, "vsum.t a0, %0"},
    {"__builtin_vsumw",  1, 0x1, "vsum.w a0, %0"},
    {"__builtin_vadd",   3, 0x7, "vadd.t %0, %1, %2"},
    {"__builtin_vsub",   3, 0x7, "vsub.t %0, %1, %2"},
    {"__builtin_vmul",   3, 0x7, "vmul.t %0, %1, %2"},
    {"__builtin_vaddw",  3, 0x7, "vadd.w %0, %1, %2"},
    {"__builtin_vsubw",  3, 0x7, "vsub.w %0, %1, %2"},
    {"__builtin_vmulw",  3, 0x7, "vmul.w %0, %1, %2"},
    {"__builtin_vmin",   3, 0x7, "vmin %0, %1, %2"},
    {"__builtin_vmax",   3, 0x7, "vmax %0, %1, %2"},
    {"__builtin_vtmul",  3, 0x7, "vtmul %0, %1, %2"},
    {"__builtin_vcons",  3, 0x7, "vcons %0, %1, %2"},
    {"__builtin_vany",   3, 0x7, "vany %0, %1, %2"},
    {"__builtin_vcmp",   3, 0x7, "vcmp.t %0, %1, %2"},
    {"__builtin_vcmpw",  3, 0x7, "vcmp.w %0, %1, %2"},
    {"__builtin_vneg",   2, 0x3, "vneg %0, %1"},
    {"__builtin_vsel",   4, 0xf, "vsel %0, %1, %2, %3"},
  };
  if(n->lhs->kind!=ND_VAR || n->ret_buffer) return NULL;
  for(int i=0;i<(int)(sizeof V/sizeof V[0]);i++) if(!strcmp(n->lhs->var->name,V[i].name)) {
    int c=0; for(Node *a=n->args;a;a=a->next) c++;
    if(c!=V[i].n) error_tok(n->tok,"TRI27: %s attend %d arguments",V[i].name,V[i].n);
    *nargs=c; *vmask=V[i].vmask;
    return V[i].fmt;
  }
  return NULL;
}

/* Nom ABI d'un registre vectoriel (indice 0..26 = nom + 13). */
static void vreg_name(long c, char *buf) {
  if(c==13) strcpy(buf,"v0");
  else if(c>13) sprintf(buf,"vp%ld",c-13);
  else sprintf(buf,"vn%ld",13-c);
}

static void call(Node *n) {
  int bn; const char *bop=builtin_op(n,&bn);
  int vbn, vmask; const char *vfmt=vbuiltin_op(n,&vbn,&vmask);
  if(vfmt) {
    char arg[4][8]; int k=0, scal=0;
    for(Node *a=n->args; a; a=a->next, k++) {
      long c;
      if(vmask>>k & 1) {
        if(!const_val(a,&c) || c<0 || c>26) error_tok(a->tok,"TRI27: registre vectoriel constant 0..26 attendu");
        vreg_name(c,arg[k]);
      } else {
        if(scal++) error_tok(a->tok,"TRI27: un seul argument scalaire par intrinsèque vectoriel");
        expr(a); strcpy(arg[k],"a0");
      }
    }
    char line[96]; int o=0;
    for(const char *f=vfmt; *f; f++) {
      if(*f=='%' && f[1]>='0' && f[1]<='3') { o+=sprintf(line+o,"%s",arg[f[1]-'0']); f++; }
      else line[o++]=*f;
    }
    line[o]=0;
    emit("  %s", line);
    return;
  }

  if(bop) {
    Node *a1=n->args, *a2=bn==2?n->args->next:NULL;
    if(bn==1) { if(reg_var(a1)) emit("  %s a0, s%d",bop,reg_var(a1)); else { expr(a1); emit("  %s a0, a0",bop); } return; }
    const char *lo, *ro;
    if(simple(a2)) { if(simple(a1)) lo=operand(a1,"a0"); else { expr(a1); lo="a0"; } ro=operand(a2,"a1"); }
    else if(simple(a1)) { expr(a2); ro="a0"; lo=operand(a1,"a1"); }
    else { expr(a2); spush(); expr(a1); spop("a1"); lo="a0"; ro="a1"; }
    emit("  %s a0, %s, %s",bop,lo,ro); return;
  }
  if(n->lhs->kind==ND_VAR && !strcmp(n->lhs->var->name,"alloca")) {
    expr(n->args);
    int id=serial++;
    emit("  addi a0, a0, 2"); emit("  li t0, 3"); emit("  div a0, a0, t0"); emit("  muli a0, a0, 3");
    emit("  ldw t0, %d(fp)",fn->alloca_bottom->offset);
    emit("  sub t1, t0, sp"); emit("  mv t2, sp"); emit("  sub sp, sp, a0"); emit("  mv t3, sp");
    emit(".L.alloc%d:",id); emit("  beqz t1, .L.aend%d",id);
    emit("  ldt t4, 0(t2)"); emit("  stt t4, 0(t3)"); emit("  addi t2, t2, 1"); emit("  addi t3, t3, 1"); emit("  addi t1, t1, -1"); emit("  j .L.alloc%d",id);
    emit(".L.aend%d:",id); emit("  sub a0, t0, a0"); emit("  stw a0, %d(fp)",fn->alloca_bottom->offset);
    return;
  }
  int count=n->ret_buffer?1:0;
  for(Node *a=n->args;a;a=a->next) count++;
  int total=MAX(count,6)*3;
  bool direct = n->lhs->kind==ND_VAR && n->lhs->var->ty->kind==TY_FUNC && !n->lhs->var->is_local;
  if(direct) emit("  addi sp, sp, -%d",total);
  else { expr(n->lhs); emit("  push a0"); emit("  addi sp, sp, -%d",total); }
  int i=0;
  if(n->ret_buffer) { emit("  addi a0, fp, %d",n->ret_buffer->offset); emit("  stw a0, 0(sp)"); i++; }
  for(Node *a=n->args;a;a=a->next,i++) {
    expr(a);
    if(aggregate(a->ty)) {
      emit("  addi t0, fp, %d",a->tri_arg_offset); copy(a->ty->size); emit("  mv a0, t0");
    }
    emit("  stw a0, %d(sp)",i*3);
  }
  if(!direct) emit("  ldw t6, %d(sp)",total);
  for(i=0;i<MIN(count,6);i++) emit("  ldw a%d, %d(sp)",i,i*3);
  if(direct) { emit("  jal ra, %s",n->lhs->var->name); emit("  addi sp, sp, %d",total); }
  else { emit("  jalr ra, t6, 0"); emit("  addi sp, sp, %d",total+3); }
  if(n->ret_buffer) emit("  addi a0, fp, %d",n->ret_buffer->offset);
  else cast(n->ty);
}
static void helper(char *name) { emit("  addi sp, sp, -18"); emit("  call %s",name); emit("  addi sp, sp, 18"); }
static void expr(Node *n) {
  if(!n) return;
  check(n->ty);
  int id=serial++;
  switch(n->kind) {
  case ND_NULL_EXPR: return;
  case ND_NUM: emit("  li a0, %ld",(long)tri_wrap(n->val,7625597484987L)); return;
  case ND_ADD: case ND_SUB: case ND_MUL: { long cv; if(const_val(n,&cv)) { emit("  li a0, %ld",cv); return; } break; }
  case ND_NEG: expr(n->lhs); emit("  neg a0, a0"); return;
  case ND_VAR: {
    char a[256];
    int r=reg_var(n);
    if(r) { emit("  mv a0, s%d",r); return; }
    if(direct_var(n,a)) { emit("  %s a0, %s",n->ty->size==1?"ldt":"ldw",a); if(n->ty->kind==TY_CHAR && n->ty->is_unsigned) cast(n->ty); return; }
    addr(n); load(n->ty); return;
  }
  case ND_MEMBER: addr(n); load(n->ty); return;
  case ND_DEREF: expr(n->lhs); load(n->ty); return;
  case ND_ADDR: addr(n->lhs); return;
  case ND_ASSIGN: {
    char a[256];
    int r=reg_var(n->lhs);
    if(r && !aggregate(n->ty)) { expr(n->rhs); emit("  mv s%d, a0",r); return; }
    if(!aggregate(n->ty) && direct_var(n->lhs,a)) { expr(n->rhs); emit("  %s a0, %s",n->ty->size==1?"stt":"stw",a); return; }
    if(!aggregate(n->ty) && simple(n->rhs)) {
      long kv; Node *e=nocast(n->rhs);
      bool ok = !(n->ty->size==1 && !reg_var(n->rhs) && const_val(e,&kv) && (kv>9841 || kv<-9841));
      if(ok && !reg_var(n->rhs) && n->rhs->kind==ND_CAST && n->rhs->ty->kind==TY_BOOL) ok=false;
      if(ok) {
        addr(n->lhs);
        const char *ro=operand(n->rhs,"a1");
        emit("  %s %s, 0(a0)",n->ty->size==1?"stt":"stw",ro);
        emit("  mv a0, %s",ro);
        return;
      }
    }
    addr(n->lhs); spush(); expr(n->rhs);
    if(aggregate(n->ty)) { spop("t0"); copy(n->ty->size); }
    else if(depth-1<nsreg) { depth--; emit("  %s a0, 0(s%d)",n->ty->size==1?"stt":"stw",depth+1); }
    else { spop("t0"); emit("  %s a0, 0(t0)",n->ty->size==1?"stt":"stw"); }
    return;
  }
  case ND_COMMA: discard(n->lhs); expr(n->rhs); return;
  case ND_CAST: expr(n->lhs); cast(n->ty); return;
  case ND_STMT_EXPR:   /* ({ ... }) : la dernière expression est la valeur du bloc */
    for(Node *s=n->body;s;s=s->next) {
      if(!s->next && s->kind==ND_EXPR_STMT) expr(s->lhs); else stmt(s);
    }
    return;
  case ND_MEMZERO:
    if(reg_of(n->var)) { emit("  mv s%d, zero",reg_of(n->var)); return; }
    if(n->var->ty->size<=30) {
      int sz=n->var->ty->size, o=n->var->offset, k=0;
      for(;k+3<=sz;k+=3) emit("  stw zero, %d(fp)",o+k);
      for(;k<sz;k++) emit("  stt zero, %d(fp)",o+k);
      return;
    }
    emit("  addi t0, fp, %d",n->var->offset); emit("  li t1, %d",n->var->ty->size);
    emit(".L.zero%d:",id); emit("  beqz t1, .L.zend%d",id); emit("  stt zero, 0(t0)");
    emit("  addi t0, t0, 1"); emit("  addi t1, t1, -1"); emit("  j .L.zero%d",id); emit(".L.zend%d:",id); return;
  case ND_COND:
    branch_false(n->cond,id,".L.else"); expr(n->then); emit("  j .L.end%d",id);
    emit(".L.else%d:",id); expr(n->els); emit(".L.end%d:",id); return;
  case ND_NOT: expr(n->lhs); emit("  seq a0, a0, zero"); return;
  case ND_BITNOT: expr(n->lhs); emit("  neg a0, a0"); emit("  addi a0, a0, -1"); return;
  case ND_LOGAND: case ND_LOGOR:
    expr(n->lhs); emit("  %s a0, .L.logic%d",n->kind==ND_LOGAND?"beqz":"bnez",id);
    expr(n->rhs); emit("  %s a0, .L.logic%d",n->kind==ND_LOGAND?"beqz":"bnez",id);
    emit("  li a0, %d",n->kind==ND_LOGAND); emit("  j .L.end%d",id);
    emit(".L.logic%d:",id); emit("  li a0, %d",n->kind==ND_LOGOR); emit(".L.end%d:",id); return;
  case ND_FUNCALL: call(n); return;
  case ND_LABEL_VAL: emit("  la a0, %s",n->unique_label); return;
  case ND_CAS: case ND_EXCH: error_tok(n->tok,"TRI27: atomics are not supported");
  default: break;
  }
  long k;
  { long pk; int pr=postinc_reg(n,&pk);
    if(pr) { emit("  mv a0, s%d",pr); emit("  addi s%d, s%d, %ld",pr,pr,pk); return; } }
  /* Binary payload is signed 42 bits, not the full ternary word. */
  if(n->kind==ND_BITAND || n->kind==ND_BITOR || n->kind==ND_BITXOR) {
    Node *value=n->lhs;
    bool constant=const_val(n->rhs,&k);
    if(!constant && const_val(n->lhs,&k)) { constant=true; value=n->rhs; }
    if(constant && k==0) {
      expr(value); /* preserve side effects, even for AND zero */
      if(n->kind==ND_BITAND) emit("  li a0, 0");
      else {
        emit("  li t0, -3812798742493"); emit("  bne a0, t0, .L.bitmin%d",id);
        emit("  li a0, 3812798742493"); emit(".L.bitmin%d:",id);
        emit("  li t0, 2199023255552");
        emit("  blt a0, t0, .L.bitlow%d",id);
        emit("  li t0, 4398046511104"); emit("  sub a0, a0, t0");
        emit("  j .L.bitend%d",id);
        emit(".L.bitlow%d:",id); emit("  neg t0, t0");
        emit("  bge a0, t0, .L.bitend%d",id);
        emit("  li t0, 4398046511104"); emit("  add a0, a0, t0");
        emit(".L.bitend%d:",id);
      }
      return;
    }
    if(constant && n->kind==ND_BITAND && k>0 && k<2199023255552L &&
       (k & (k+1))==0 && fits16(k+1)) {
      const char *src="a0";
      if(simple(value)) src=operand(value,"a0"); else expr(value);
      emit("  mv a0, %s",src);
      emit("  li t0, -3812798742493"); emit("  bne a0, t0, .L.maskmin%d",id);
      emit("  li a0, 3812798742493"); emit(".L.maskmin%d:",id);
      emit("  modi a0, a0, %ld",k+1);
      emit("  bgez a0, .L.mask%d",id); emit("  addi a0, a0, %ld",k+1);
      emit(".L.mask%d:",id); return;
    }
  }
  bool ulhs = n->lhs->ty && n->lhs->ty->is_unsigned && n->lhs->ty->kind!=TY_PTR;
  if(const_val(n->rhs,&k) && fits16(k) && fits16(-k)) {
    switch(n->kind) {
    case ND_ADD: if(reg_var(n->lhs)) { emit("  addi a0, s%d, %ld",reg_var(n->lhs),k); return; } expr(n->lhs); emit("  addi a0, a0, %ld",k); return;
    case ND_SUB: if(reg_var(n->lhs)) { emit("  addi a0, s%d, %ld",reg_var(n->lhs),-k); return; } expr(n->lhs); emit("  addi a0, a0, %ld",-k); return;
    case ND_MUL: if(k==1) { expr(n->lhs); return; }
      if(reg_var(n->lhs)) { emit("  muli a0, s%d, %ld",reg_var(n->lhs),k); return; } expr(n->lhs); emit("  muli a0, a0, %ld",k); return;
    case ND_EQ: case ND_NE:
      expr(n->lhs); emit("  addi a0, a0, %ld",-k); emit("  seq a0, a0, zero");
      if(n->kind==ND_NE) emit("  seq a0, a0, zero"); return;
    case ND_LT: if(!ulhs) { if(reg_var(n->lhs)) emit("  slti a0, s%d, %ld",reg_var(n->lhs),k); else { expr(n->lhs); emit("  slti a0, a0, %ld",k); } return; } break;
    case ND_LE: if(!ulhs && fits16(k+1)) { expr(n->lhs); emit("  slti a0, a0, %ld",k+1); return; } break;
    case ND_DIV: case ND_MOD:
      if(!n->ty->is_unsigned && k!=0) {
        const char *src="a0"; char b[8];
        if(reg_var(n->lhs)) { sprintf(b,"s%d",reg_var(n->lhs)); src=b; } else expr(n->lhs);
        emit("  %s a0, %s, %ld",n->kind==ND_DIV?"divi":"modi",src,k); return;
      }
      break;
    case ND_SHL: if(k>=0 && k<=24) { expr(n->lhs); emit("  muli a0, a0, %ld",1L<<k); return; } break;
    case ND_SHR:
      if(!n->ty->is_unsigned && k>=0 && k<=24) {
        int id2=serial++;
        expr(n->lhs);
        if(k>0) { emit("  bgez a0, .L.shr%d",id2); emit("  addi a0, a0, %ld",-((1L<<k)-1)); emit(".L.shr%d:",id2); emit("  divi a0, a0, %ld",1L<<k); }
        return;
      }
      break;
    default: break;
    }
  }
  /* opérandes en registre : add/sub/mul/div/mod/seq/slt signés sans passer par la pile */
  bool sgn = !(n->lhs->ty && n->lhs->ty->is_unsigned && n->lhs->ty->kind!=TY_PTR) && !(n->ty && n->ty->is_unsigned && n->ty->kind!=TY_PTR);
  if(simple(n->lhs) || simple(n->rhs)) {
    const char *mn=NULL;
    switch(n->kind) {
    case ND_ADD: mn="add"; break; case ND_SUB: mn="sub"; break; case ND_MUL: mn="mul"; break;
    case ND_DIV: if(sgn) mn="div"; break; case ND_MOD: if(sgn) mn="mod"; break;
    case ND_EQ: case ND_NE: mn="seq"; break;
    case ND_LT: case ND_LE: if(sgn) mn="slt"; break;
    default: break;
    }
    if(mn) {
      const char *lo, *ro;
      if(simple(n->rhs)) { if(simple(n->lhs)) lo=operand(n->lhs,"a0"); else { expr(n->lhs); lo="a0"; } ro=operand(n->rhs,"a1"); }
      else { expr(n->rhs); ro="a0"; lo=operand(n->lhs,"a1"); }
      if(n->kind==ND_LE) { emit("  slt a0, %s, %s",ro,lo); emit("  seq a0, a0, zero"); return; }
      emit("  %s a0, %s, %s",mn,lo,ro);
      if(n->kind==ND_NE) emit("  seq a0, a0, zero");
      return;
    }
  }
  expr(n->rhs); spush(); expr(n->lhs); spop("a1");
  switch(n->kind) {
  case ND_ADD: emit("  add a0, a0, a1"); return;
  case ND_SUB: emit("  sub a0, a0, a1"); return;
  case ND_MUL: emit("  mul a0, a0, a1"); return;
  case ND_DIV: case ND_MOD:
    if(n->ty->is_unsigned) helper(n->kind==ND_DIV?"__tri_udiv":"__tri_umod");
    else emit("  %s a0, a0, a1",n->kind==ND_DIV?"div":"mod"); return;
  case ND_EQ: case ND_NE:
    emit("  seq a0, a0, a1"); if(n->kind==ND_NE) emit("  seq a0, a0, zero"); return;
  case ND_LT: case ND_LE:
    if(n->lhs->ty->is_unsigned && n->lhs->ty->kind!=TY_PTR) {
      // Rotate the ternary residue ordering into signed order without overflow.
      emit("  li t0, 3812798742493"); emit("  sub a0, a0, t0"); emit("  sub a1, a1, t0");
    }
    if(n->kind==ND_LT) emit("  slt a0, a0, a1");
    else { emit("  slt a0, a1, a0"); emit("  seq a0, a0, zero"); } return;
  case ND_BITAND: helper("__tri_and"); return;
  case ND_BITOR: helper("__tri_or"); return;
  case ND_BITXOR: helper("__tri_xor"); return;
  case ND_SHL: helper("__tri_shl"); return;
  case ND_SHR: helper(n->ty->is_unsigned?"__tri_ushr":"__tri_shr"); return;
  default: error_tok(n->tok,"TRI27: unsupported expression %d",n->kind);
  }
}
/* Évalue n pour ses seuls effets : la valeur est jetée. Les post-incréments
 * (x = x + 1) - 1 et les casts sans effet ne calculent pas de résultat inutile. */
/* Calcule une opération simple directement dans s<r> (valeur jetée ailleurs) :
 *   s = a OP b  avec a ou b simple ;  s = a  avec a simple. */
/* v++ / v-- en valeur sur une variable registre : forme chibicc ((v = v + k) - k).
 * Renvoie le registre et k. */
static int postinc_reg(Node *n, long *kout) {
  long c, k2;
  n=nocast(n);
  if(!n || (n->kind!=ND_ADD && n->kind!=ND_SUB) || !const_val(n->rhs,&c)) return 0;
  if(n->kind==ND_SUB) c=-c;
  Node *a=nocast(n->lhs);
  if(a->kind!=ND_ASSIGN) return 0;
  int r=reg_var(a->lhs);
  if(!r || a->lhs->ty->kind==TY_CHAR || a->lhs->ty->kind==TY_BOOL) return 0;
  Node *b=nocast(a->rhs);
  if((b->kind!=ND_ADD && b->kind!=ND_SUB) || reg_var(b->lhs)!=r || !const_val(b->rhs,&k2)) return 0;
  if(b->kind==ND_SUB) k2=-k2;
  if(k2!=-c || !fits16(k2)) return 0;
  *kout=k2; return r;
}

static bool emit_binop_to(Node *rhs, int r) {
  Node *e=nocast(rhs);
  char d[8]; sprintf(d,"s%d",r);
  long k;
  if(e->ty && e->ty->kind==TY_CHAR) return false;           /* troncature nécessaire */
  if(rhs->kind==ND_CAST && (rhs->ty->kind==TY_CHAR || rhs->ty->kind==TY_BOOL)) return false;
  if(simple(e)) { const char *o=operand(e,"a0"); emit("  mv %s, %s",d,o); return true; }
  const char *mn=NULL;
  bool sgn = e->ty && !(e->ty->is_unsigned && e->ty->kind!=TY_PTR);
  switch(e->kind) {
  case ND_ADD: mn="add"; break; case ND_SUB: mn="sub"; break; case ND_MUL: mn="mul"; break;
  case ND_DIV: if(sgn) mn="div"; break; case ND_MOD: if(sgn) mn="mod"; break;
  default: return false;
  }
  if(!mn) return false;
  if((e->kind==ND_ADD || e->kind==ND_SUB) && const_val(e->rhs,&k) && fits16(k) && fits16(-k) && reg_var(e->lhs)) {
    emit("  addi %s, s%d, %ld",d,reg_var(e->lhs),e->kind==ND_ADD?k:-k); return true;
  }
  if(!simple(e->lhs) && !simple(e->rhs)) return false;
  const char *lo, *ro;
  if(simple(e->rhs)) { if(simple(e->lhs)) lo=operand(e->lhs,"a0"); else { expr(e->lhs); lo="a0"; } ro=operand(e->rhs,"a1"); }
  else { expr(e->rhs); ro="a0"; lo=operand(e->lhs,"a1"); }
  emit("  %s %s, %s, %s",mn,d,lo,ro);
  return true;
}

static void discard(Node *n) {
  if(!n) return;
  while(n->kind==ND_CAST) n=n->lhs;
  long k;
  if((n->kind==ND_ADD || n->kind==ND_SUB) && const_val(n->rhs,&k)) { discard(n->lhs); return; }
  if(n->kind==ND_COMMA) { discard(n->lhs); discard(n->rhs); return; }
  int r = n->kind==ND_ASSIGN && !aggregate(n->ty) ? reg_var(n->lhs) : 0;
  if(r && emit_binop_to(n->rhs, r)) return;
  if(n->kind==ND_ASSIGN && !r && !aggregate(n->ty) && scalar(n->ty)) {
    /* valeur jetée : la troncature en char est faite par stt elle-même */
    Node *v=n->rhs;
    if(n->ty->size==1 && v->kind==ND_CAST && v->ty->kind==TY_CHAR) v=v->lhs;
    if(simple(v)) {
      char a[256];
      const char *st = n->ty->size==1 ? "stt" : "stw";
      if(direct_var(n->lhs,a)) { const char *o=operand(v,"a1"); emit("  %s %s, %s",st,o,a); return; }
      long pk; int pr = n->lhs->kind==ND_DEREF ? postinc_reg(n->lhs->lhs,&pk) : 0;
      if(pr) { const char *o=operand(v,"a1"); emit("  %s %s, 0(s%d)",st,o,pr); emit("  addi s%d, s%d, %ld",pr,pr,pk); return; }
      addr(n->lhs); { const char *o=operand(v,"a1"); emit("  %s %s, 0(a0)",st,o); }
      return;
    }
  }
  expr(n);
}

/* Saut conditionnel direct : vers L si la condition vaut `when` (0 = fausse, 1 = vraie).
 * Comparaisons signées → beq/bne/blt/bge sans matérialiser de booléen. */
static void branch(Node *n, int when, char *L) {
  int id=serial++;
  if(n->kind==ND_NOT) { branch(n->lhs,!when,L); return; }
  if(n->kind==ND_LOGAND || n->kind==ND_LOGOR) {
    int and=n->kind==ND_LOGAND;
    if(and != when) { branch(n->lhs,when,L); branch(n->rhs,when,L); return; }
    char skip[32]; sprintf(skip,".L.bskip%d",id);
    branch(n->lhs,!when,skip); branch(n->rhs,when,L); emit("%s:",skip); return;
  }
  int k_eq=n->kind==ND_EQ, k_ne=n->kind==ND_NE, k_lt=n->kind==ND_LT, k_le=n->kind==ND_LE;
  if((k_eq||k_ne||k_lt||k_le) && n->lhs->ty && n->rhs->ty && !aggregate(n->lhs->ty)) {
    bool uns=(n->lhs->ty->is_unsigned && n->lhs->ty->kind!=TY_PTR) || (n->rhs->ty->is_unsigned && n->rhs->ty->kind!=TY_PTR);
    long k;
    if(k_eq||k_ne) {
      int jump_if_equal = k_eq ? when : !when;
      if(simple(n->lhs) || simple(n->rhs)) {
        const char *lo, *ro;
        if(simple(n->rhs)) { if(simple(n->lhs)) lo=operand(n->lhs,"a0"); else { expr(n->lhs); lo="a0"; } ro=operand(n->rhs,"a1"); }
        else { expr(n->rhs); ro="a0"; lo=operand(n->lhs,"a1"); }
        emit("  %s %s, %s, %s",jump_if_equal?"beq":"bne",lo,ro,L); return;
      }
      expr(n->rhs); spush(); expr(n->lhs); spop("a1");
      emit("  %s a0, a1, %s",jump_if_equal?"beq":"bne",L); return;
    }
    if(!uns) {
      if(simple(n->lhs) || simple(n->rhs)) {
        const char *lo, *ro;
        if(simple(n->rhs)) { if(simple(n->lhs)) lo=operand(n->lhs,"a0"); else { expr(n->lhs); lo="a0"; } ro=operand(n->rhs,"a1"); }
        else { expr(n->rhs); ro="a0"; lo=operand(n->lhs,"a1"); }
        if(k_lt) emit("  %s %s, %s, %s",when?"blt":"bge",lo,ro,L);
        else emit("  %s %s, %s, %s",when?"bge":"blt",ro,lo,L);
        return;
      }
      if(const_val(n->rhs,&k) && k==0) {
        expr(n->lhs);
        /* a<0 : bltz/bgez ; a<=0 : blez/bgtz */
        if(k_lt) emit("  %s a0, %s",when?"bltz":"bgez",L);
        else emit("  %s a0, %s",when?"blez":"bgtz",L);
        return;
      }
      expr(n->rhs); spush(); expr(n->lhs); spop("a1");
      /* a<b : blt a0,a1 ; a<=b ⇔ !(b<a) */
      if(k_lt) emit("  %s a0, a1, %s",when?"blt":"bge",L);
      else emit("  %s a1, a0, %s",when?"bge":"blt",L);
      return;
    }
  }
  expr(n); emit("  %s a0, %s",when?"bnez":"beqz",L);
}
static void branch_false(Node *n, int id, const char *prefix) {
  char L[48]; sprintf(L,"%s%d",prefix,id); branch(n,0,L);
}

static void stmt(Node *n) {
  int id=serial++;
  switch(n->kind) {
  case ND_BLOCK: for(Node *s=n->body;s;s=s->next) stmt(s); return;
  case ND_EXPR_STMT: discard(n->lhs); return;
  case ND_RETURN:
    expr(n->lhs);
    if(n->lhs && aggregate(n->lhs->ty)) { emit("  ldw t0, %d(fp)",fn->params->offset); copy(n->lhs->ty->size); emit("  mv a0, t0"); }
    emit("  j .L.return.%s",fn->name); return;
  case ND_IF:
    branch_false(n->cond,id,".L.else"); stmt(n->then); emit("  j .L.end%d",id);
    emit(".L.else%d:",id); if(n->els) stmt(n->els); emit(".L.end%d:",id); return;
  case ND_FOR:
    /* boucle tournée : test en bas, un seul saut par itération */
    if(n->init) stmt(n->init);
    if(n->cond) emit("  j .L.cond%d",id);
    emit(".L.begin%d:",id);
    stmt(n->then); emit("%s:",n->cont_label); discard(n->inc);
    if(n->cond) { char L[32]; emit(".L.cond%d:",id); sprintf(L,".L.begin%d",id); branch(n->cond,1,L); }
    else emit("  j .L.begin%d",id);
    emit("%s:",n->brk_label); return;
  case ND_DO:
    emit(".L.begin%d:",id); stmt(n->then); emit("%s:",n->cont_label);
    { char L[32]; sprintf(L,".L.begin%d",id); branch(n->cond,1,L); } emit("%s:",n->brk_label); return;
  case ND_SWITCH:
    expr(n->cond);
    for(Node *c=n->case_next;c;c=c->case_next) {
      int k=serial++; emit("  li t0, %ld",c->begin);
      if(c->begin==c->end) emit("  beq a0, t0, %s",c->label);
      else { emit("  blt a0, t0, .L.next%d",k); emit("  li t0, %ld",c->end); emit("  ble a0, t0, %s",c->label); emit(".L.next%d:",k); }
    }
    emit("  j %s",n->default_case?n->default_case->label:n->brk_label); stmt(n->then); emit("%s:",n->brk_label); return;
  case ND_CASE: emit("%s:",n->label); stmt(n->lhs); return;
  case ND_LABEL: emit("%s:",n->unique_label); stmt(n->lhs); return;
  case ND_GOTO: emit("  j %s",n->unique_label); return;
  case ND_GOTO_EXPR: expr(n->lhs); emit("  jr a0"); return;
  case ND_ASM: emit("%s",n->asm_str); return;
  default: error_tok(n->tok,"TRI27: unsupported statement %d",n->kind);
  }
}
// Aggregate copies must not live in the movable expression stack: an alloca
// in a later argument shifts that stack. Give each argument a stable fp slot.
static void arg_slots(Node *n, int *size) {
  if(!n) return;
  arg_slots(n->lhs,size); arg_slots(n->rhs,size); arg_slots(n->cond,size);
  arg_slots(n->then,size); arg_slots(n->els,size); arg_slots(n->init,size); arg_slots(n->inc,size);
  for(Node *s=n->body;s;s=s->next) arg_slots(s,size);
  for(Node *a=n->args;a;a=a->next) {
    arg_slots(a,size);
    if(aggregate(a->ty)) { *size=align_to(*size+a->ty->size,3); a->tri_arg_offset=-*size; }
  }
}
void codegen(Obj *prog, FILE *output) {
  out=output;
  for(Obj *v=prog;v;v=v->next) if(v->is_static && strncmp(v->name,".L",2)) v->name=format(".L.static.%s",v->name);
  for(Obj *v=prog;v;v=v->next) {
    if(v->is_function || !v->is_definition) continue;
    check(v->ty);
    if(v->is_tls) error("TRI27: thread-local storage is not supported");
    if(v->is_tentative && !v->is_static) { emit("; COMMON %s %d %d",v->name,v->ty->size,v->align); continue; }
    emit("  .align %d",v->align); emit("%s:",v->name);
    if(!v->init_data) { emit("  .space %d",v->ty->size); continue; }
    Relocation *r=v->rel;
    for(int p=0;p<v->ty->size;) {
      if(r && r->offset==p) { emit("  .wordu %s%+ld",*r->label,r->addend); p+=3; r=r->next; }
      else emit("  .tryte %ld",(long)v->init_data[p++]);
    }
  }
  for(fn=prog;fn;fn=fn->next) {
    if(!fn->is_function || !fn->is_definition || !fn->is_live) continue;
    choose_promoted(fn);
    check(fn->ty->return_ty);
    int size=0;
    for(Obj *v=fn->locals;v;v=v->next) { check(v->ty); size=align_to(size+v->ty->size,v->align); v->offset=-size; }
    arg_slots(fn->body,&size);
    fn->stack_size=align_to(size,3);
    FILE *real=out; char *body=NULL; size_t blen=0;
    out=open_memstream(&body,&blen);
    depth=0; maxdepth=0;
    bool agg=false; for(Obj *v=fn->params;v;v=v->next) if(aggregate(v->ty)) agg=true;
    int i=0;
    if(!agg && !fn->va_area) {
      /* chemin direct : registres d'arguments → registre promu ou slot, sans home area */
      for(Obj *v=fn->params;v;v=v->next,i++) {
        char src[16];
        if(i<6) sprintf(src,"a%d",i); else { emit("  ldw t0, %d(fp)",6+3*i); strcpy(src,"t0"); }
        int r=reg_of(v);
        if(r && v->ty->size!=1) emit("  mv s%d, %s",r,src);
        else if(r) { emit("  mv a0, %s",src); emit("  sxt a0, a0"); if(v->ty->kind==TY_CHAR && v->ty->is_unsigned) cast(v->ty); emit("  mv s%d, a0",r); }
        else emit("  %s %s, %d(fp)",v->ty->size==1?"stt":"stw",src,v->offset);
      }
      goto params_done;
    }
    // Home all six registers before copying aggregates (which clobbers a0).
    for(int i=0;i<6;i++) emit("  stw a%d, %d(fp)",i,6+3*i);
    for(Obj *v=fn->params;v;v=v->next,i++) {
      emit("  ldw a0, %d(fp)",6+3*i);
      if(aggregate(v->ty)) { emit("  addi t0, fp, %d",v->offset); copy(v->ty->size); }
      else emit("  %s a0, %d(fp)",v->ty->size==1?"stt":"stw",v->offset);
    }
    if(fn->va_area) { emit("  addi t0, fp, %d",6+3*i); emit("  stw t0, %d(fp)",fn->va_area->offset); }
    for(Obj *v=fn->params;v;v=v->next) if(reg_of(v)) {   /* paramètre promu : slot → registre */
      emit("  %s a0, %d(fp)",v->ty->size==1?"ldt":"ldw",v->offset);
      if(v->ty->kind==TY_CHAR && v->ty->is_unsigned) cast(v->ty);
      emit("  mv s%d, a0",reg_of(v));
    }
  params_done:
    stmt(fn->body);
    if(!strcmp(fn->name,"main")) emit("  li a0, 0");
    fclose(out); out=real;
    int ns=MIN(maxdepth,nsreg);
    int saved[NSREG], nsaved=0;           /* registres s à sauver : pile d'expressions + variables */
    for(int r=1;r<=ns;r++) saved[nsaved++]=r;
    for(int k=0;k<npromo;k++) saved[nsaved++]=10-k;
    int frame=fn->stack_size+3*nsaved;
    emit("  .align 3"); emit("%s:",fn->name);
    if(npromo) { fprintf(out,"; REGVARS"); for(int k=0;k<npromo;k++) fprintf(out," s%d",10-k); fprintf(out,"\n"); }
    emit("  push ra"); emit("  push fp"); emit("  mv fp, sp"); emit("  addi sp, sp, -%d",frame);
    for(int k=0;k<nsaved;k++) emit("  stw s%d, %d(fp)",saved[k],-fn->stack_size-3*(k+1));
    emit("  stw sp, %d(fp)",fn->alloca_bottom->offset);
    fwrite(body,1,blen,out); free(body);
    emit(".L.return.%s:",fn->name);
    for(int k=0;k<nsaved;k++) emit("  ldw s%d, %d(fp)",saved[k],-fn->stack_size-3*(k+1));
    emit("  mv sp, fp"); emit("  pop fp"); emit("  pop ra"); emit("  ret");
  }
}
