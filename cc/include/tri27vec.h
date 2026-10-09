/* tri27vec.h — intrinsèques vectoriels TRI-27 (extension v0.5, SPEC.md §Vecteurs).
 *
 * Chaque appel devient UNE instruction (en ligne, sans appel de fonction).
 * Un registre vectoriel est désigné par un ENTIER CONSTANT (0..26) : indice = nom + 13.
 *   v0 = 13, vp1 = 14 … vp13 = 26, vn1 = 12 … vn13 = 0.
 * Un registre vectoriel = 27 trytes ; VL (longueur active, CSR 13) = nombre de voies utilisées.
 *
 * Forme : `__builtin_vop(args)`. Le résultat scalaire est renvoyé dans la valeur de retour.
 */
#ifndef TRI27VEC_H
#define TRI27VEC_H
#include <tri27.h>

/* Réductions vers un scalaire (valeur de retour). */
long __builtin_vtdot(long va, long vb);  /* Σ trit à trit sur les 243 trits de VL voies (vtdot) */
long __builtin_vtmac(long va, long vb);  /* Σ tryte_a · trit_b (vtmac.t)                      */
long __builtin_vsum(long va);            /* Σ des trits de VL voies (vsum.t)                  */

/* Opérations vectorielles (registre de destination d'abord). */
void __builtin_vadd(long vd, long va, long vb);   /* vd = va + vb  (.T, modulo 3^9 par tryte) */
void __builtin_vsub(long vd, long va, long vb);
void __builtin_vmul(long vd, long va, long vb);
void __builtin_vmin(long vd, long va, long vb);   /* ET de Kleene trit à trit                */
void __builtin_vmax(long vd, long va, long vb);   /* OU de Kleene trit à trit                */
void __builtin_vtmul(long vd, long va, long vb);  /* produit trit à trit (XNOR)              */
void __builtin_vcons(long vd, long va, long vb);
void __builtin_vany(long vd, long va, long vb);
void __builtin_vneg(long vd, long va);

#endif
