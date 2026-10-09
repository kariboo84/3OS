/* vectest.c — les registres vectoriels survivent aux changements de contexte du noyau 3OS.
 * Le parent charge VP1 (27 trytes) avec VL = 27, lance l'enfant `vecb` (qui écrase VP1 et VL),
 * puis relit VP1 : il doit être intact, et VL aussi (sinon la relecture serait tronquée). */
#include <stdio.h>
#include <3os.h>
#include <tri27vec.h>

static long a[9], out[9];

int main(void) {
  for (int i = 0; i < 9; i++) { a[i] = i * 123456789L - 500000000L; out[i] = 0; }
  __builtin_vsetvl(27);
  __builtin_vld(VP1, a);
  long r = sys_exec("vecb");
  __builtin_vst(VP1, out);
  int ok = 1;
  for (int i = 0; i < 9; i++) if (out[i] != a[i]) ok = 0;
  printf("vectest : enfant %ld, registres vectoriels du parent %s\n", r, ok ? "intacts" : "CORROMPUS");
  return ok ? 0 : 1;
}
