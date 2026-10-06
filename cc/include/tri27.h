#ifndef TRI27_INTRINSICS_H
#define TRI27_INTRINSICS_H
/* Intrinsèques ternaires de TRI-27 : chaque appel devient UNE instruction
 * (le compilateur les génère en ligne). Un mot = 27 trits t_i dans {-1,0,+1},
 * valeur = somme t_i * 3^i. Logique de Kleene : -1 = faux, 0 = inconnu, +1 = vrai. */
long __builtin_tmin(long,long);   /* min trit à trit  = ET de Kleene      (min)  */
long __builtin_tmax(long,long);   /* max trit à trit  = OU de Kleene      (max)  */
long __builtin_tmul(long,long);   /* produit trit à trit (XNOR ternaire)  (tmul) */
long __builtin_tcons(long,long);  /* consensus : t si a_i == b_i, sinon 0 (cons) */
long __builtin_tany(long,long);   /* accept-anything : somme saturée      (any)  */
long __builtin_sht(long,long);    /* décalage de k trits (k<0 : arrondi)  (sht)  */
long __builtin_tsum(long);        /* somme des 27 trits, -27..27          (tsum) */
long __builtin_tdot(long,long);   /* produit scalaire ternaire Σ a_i·b_i   (tdot) */

#define T_AND(a,b)  __builtin_tmin((a),(b))
#define T_OR(a,b)   __builtin_tmax((a),(b))
#define T_NOT(a)    (-(a))
#define T_MUL(a,b)  __builtin_tmul((a),(b))
#define T_CONS(a,b) __builtin_tcons((a),(b))
#define T_SUM(a)    __builtin_tsum(a)
#define T_DOT(a,b)  __builtin_tdot((a),(b))
#endif
