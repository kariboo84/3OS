/* crash.c — programme fautif : écrit hors de son espace. Le noyau doit le tuer
 * sans que le reste du système tombe. */
#include <stdio.h>
int main(void) {
  printf("crash : j'ecris en dehors de ma memoire...\n");
  long *p = (long *)900000;   /* au-delà de ULIMIT (3^12) */
  *p = 42;
  printf("crash : ceci ne doit jamais s'afficher\n");
  return 0;
}
