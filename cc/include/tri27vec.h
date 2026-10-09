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

/* Longueur active (voies : trytes en .T, mots en .W) ; renvoie la valeur retenue (0..27). */
long __builtin_vsetvl(long n);
/* Chargement / rangement de VL trytes à l'adresse p. */
void __builtin_vld(long vd, const void *p);
void __builtin_vst(long vd, void *p);
/* Diffusion d'un scalaire sur toutes les voies (.T tryte, .W mot). */
void __builtin_vsplat(long vd, long x);
void __builtin_vsplatw(long vd, long x);
long __builtin_vsumw(long va);
void __builtin_vaddw(long vd, long va, long vb);
void __builtin_vsubw(long vd, long va, long vb);
void __builtin_vmulw(long vd, long va, long vb);
void __builtin_vcmp(long vd, long va, long vb);   /* masque : signe(a - b) par tryte */
void __builtin_vcmpw(long vd, long va, long vb);
void __builtin_vsel(long vd, long vm, long va, long vb); /* trit de masque -1 -> a, 0 -> garde vd, +1 -> b */

/* Réductions vers un scalaire (valeur de retour). */
long __builtin_vtdot(long va, long vb);  /* Σ trit à trit sur les 243 trits de VL voies (vtdot) */
long __builtin_vtmac(long va, long vb);  /* Σ a_i · b_i sur les trytes (vtmac.t)               */
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

/* Noms des registres vectoriels (indice = nom + 13). */
#define VN13 0
#define V0 13
#define VP1 14
#define VP2 15
#define VP3 16
#define VP4 17

#endif
