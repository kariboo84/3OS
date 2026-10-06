#include <assert.h>
#include <stdio.h>
#include <alloca.h>
struct Pair {int x,y;};
static int inspect(struct Pair p,void *scratch) { *(char*)scratch=7; return p.x+p.y; }
static int combine(struct Pair p,struct Pair q) { return p.x*10+q.x; }
int main(void) {
  struct Pair p={12,34};
  assert(inspect(p,alloca(30))==46);
  assert(combine((p.x=1,p),(p.x=2,p))==12);
  puts("aggregate/alloca: OK");
  return 0;
}
