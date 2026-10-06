// TRI-27 stack backend. See ../README.md for the home-area ABI.
#include "chibicc.h"
static FILE *out;
static Obj *fn;
static int serial;
static void expr(Node *n);
static void stmt(Node *n);
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
    emit("  push a0"); emit("  ldt a0, 0(sp)"); emit("  addi sp, sp, 3");
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
static void addr(Node *n) {
  switch(n->kind) {
  case ND_VAR:
    if(n->var->is_local) emit("  %s a0, %s, %d",n->ty->kind==TY_VLA?"addi":"addi","fp",n->var->offset);
    else emit("  la a0, %s",n->var->name);
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
static void call(Node *n) {
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
  expr(n->lhs); emit("  push a0"); emit("  addi sp, sp, -%d",total);
  int i=0;
  if(n->ret_buffer) { emit("  addi a0, fp, %d",n->ret_buffer->offset); emit("  stw a0, 0(sp)"); i++; }
  for(Node *a=n->args;a;a=a->next,i++) {
    expr(a);
    if(aggregate(a->ty)) {
      emit("  addi t0, fp, %d",a->tri_arg_offset); copy(a->ty->size); emit("  mv a0, t0");
    }
    emit("  stw a0, %d(sp)",i*3);
  }
  emit("  ldw t6, %d(sp)",total);
  for(i=0;i<MIN(count,6);i++) emit("  ldw a%d, %d(sp)",i,i*3);
  emit("  jalr ra, t6, 0"); emit("  addi sp, sp, %d",total+3);
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
  case ND_NEG: expr(n->lhs); emit("  neg a0, a0"); return;
  case ND_VAR: case ND_MEMBER: addr(n); load(n->ty); return;
  case ND_DEREF: expr(n->lhs); load(n->ty); return;
  case ND_ADDR: addr(n->lhs); return;
  case ND_ASSIGN:
    addr(n->lhs); emit("  push a0"); expr(n->rhs); emit("  pop t0");
    if(aggregate(n->ty)) copy(n->ty->size);
    else emit("  %s a0, 0(t0)",n->ty->size==1?"stt":"stw");
    return;
  case ND_COMMA: expr(n->lhs); expr(n->rhs); return;
  case ND_CAST: expr(n->lhs); cast(n->ty); return;
  case ND_STMT_EXPR: for(Node *s=n->body;s;s=s->next) stmt(s); return;
  case ND_MEMZERO:
    emit("  addi t0, fp, %d",n->var->offset); emit("  li t1, %d",n->var->ty->size);
    emit(".L.zero%d:",id); emit("  beqz t1, .L.zend%d",id); emit("  stt zero, 0(t0)");
    emit("  addi t0, t0, 1"); emit("  addi t1, t1, -1"); emit("  j .L.zero%d",id); emit(".L.zend%d:",id); return;
  case ND_COND:
    expr(n->cond); emit("  beqz a0, .L.else%d",id); expr(n->then); emit("  j .L.end%d",id);
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
  expr(n->rhs); emit("  push a0"); expr(n->lhs); emit("  pop a1");
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
static void stmt(Node *n) {
  int id=serial++;
  switch(n->kind) {
  case ND_BLOCK: for(Node *s=n->body;s;s=s->next) stmt(s); return;
  case ND_EXPR_STMT: expr(n->lhs); return;
  case ND_RETURN:
    expr(n->lhs);
    if(n->lhs && aggregate(n->lhs->ty)) { emit("  ldw t0, %d(fp)",fn->params->offset); copy(n->lhs->ty->size); emit("  mv a0, t0"); }
    emit("  j .L.return.%s",fn->name); return;
  case ND_IF:
    expr(n->cond); emit("  beqz a0, .L.else%d",id); stmt(n->then); emit("  j .L.end%d",id);
    emit(".L.else%d:",id); if(n->els) stmt(n->els); emit(".L.end%d:",id); return;
  case ND_FOR:
    if(n->init) stmt(n->init); emit(".L.begin%d:",id);
    if(n->cond) { expr(n->cond); emit("  beqz a0, %s",n->brk_label); }
    stmt(n->then); emit("%s:",n->cont_label); expr(n->inc); emit("  j .L.begin%d",id); emit("%s:",n->brk_label); return;
  case ND_DO:
    emit(".L.begin%d:",id); stmt(n->then); emit("%s:",n->cont_label); expr(n->cond); emit("  bnez a0, .L.begin%d",id); emit("%s:",n->brk_label); return;
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
    check(fn->ty->return_ty);
    int size=0;
    for(Obj *v=fn->locals;v;v=v->next) { check(v->ty); size=align_to(size+v->ty->size,v->align); v->offset=-size; }
    arg_slots(fn->body,&size);
    fn->stack_size=align_to(size,3);
    emit("  .align 3"); emit("%s:",fn->name); emit("  push ra"); emit("  push fp"); emit("  mv fp, sp"); emit("  addi sp, sp, -%d",fn->stack_size);
    emit("  stw sp, %d(fp)",fn->alloca_bottom->offset);
    // Home all six registers before copying aggregates (which clobbers a0).
    for(int i=0;i<6;i++) emit("  stw a%d, %d(fp)",i,6+3*i);
    int i=0;
    for(Obj *v=fn->params;v;v=v->next,i++) {
      emit("  ldw a0, %d(fp)",6+3*i);
      if(aggregate(v->ty)) { emit("  addi t0, fp, %d",v->offset); copy(v->ty->size); }
      else emit("  %s a0, %d(fp)",v->ty->size==1?"stt":"stw",v->offset);
    }
    if(fn->va_area) { emit("  addi t0, fp, %d",6+3*i); emit("  stw t0, %d(fp)",fn->va_area->offset); }
    stmt(fn->body);
    if(!strcmp(fn->name,"main")) emit("  li a0, 0");
    emit(".L.return.%s:",fn->name); emit("  mv sp, fp"); emit("  pop fp"); emit("  pop ra"); emit("  ret");
  }
}
