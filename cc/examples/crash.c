/* crash.c — programme fautif : écrit hors de son espace. Le noyau doit le tuer
 * sans que le reste du système tombe. */
#include <stdio.h>
int main(void) {
  printf("crash : j'ecris en dehors de ma memoire...\n");
  /* plus haute adresse positive (27 trits) : toujours au-delà de ULIMIT, quelle que soit la RAM */
  long *p = (long *)3812798742491;
  *p = 42;
  printf("crash : ceci ne doit jamais s'afficher\n");
  return 0;
}
