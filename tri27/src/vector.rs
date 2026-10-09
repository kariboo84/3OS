//! Extension vectorielle ternaire v0.5 (SPEC.md §1 « Vecteurs », ARCHITECTURE.md §1).
//!
//! Un registre vectoriel = 27 trytes = 9 mots = 243 trits. 27 registres (indices 0..26 dans le
//! champ de 3 trits, comme les registres entiers). CSR `VL` (13) = nombre de voies actives :
//! une voie = 1 tryte en `.T` (au plus 27), 1 mot en `.W` (au plus 9).
//! Les voies au-delà de VL ne sont pas modifiées (destination inchangée) ; les lectures n'en tiennent pas compte.
//! Chaque instruction vectorielle compte pour 1 instruction retirée, quelle que soit VL.

use crate::isa::{op, Inst};
use crate::trit::*;
use crate::vm::{csr, Vm};

/// Trytes par registre vectoriel.
pub const VLEN: usize = 27;
/// Mots par registre vectoriel.
pub const WLEN: usize = 9;
pub type VReg = [i16; VLEN];

const M9: u32 = 0x1ff;

#[inline]
fn word_of(t: &[i16]) -> i64 {
    t[0] as i64 + t[1] as i64 * T9 + t[2] as i64 * T9 * T9
}

/// Écrit un mot (déjà ramené dans la plage d'un mot) sur 3 trytes, petit-boutiste.
#[inline]
fn put_word(t: &mut [i16], v: i64) {
    let t0 = bal_mod(v, T9);
    let r = (v - t0) / T9;
    let t1 = bal_mod(r, T9);
    let t2 = (r - t1) / T9;
    t[0] = t0 as i16;
    t[1] = t1 as i16;
    t[2] = t2 as i16;
}

/// Plans (trits +1, trits −1) d'un tryte seul : 9 trits de poids faible d'abord.
/// `to_planes` découpe un mot (3 trytes) : pour un tryte, on découpe la valeur en 9 trits ici.
#[inline]
fn tryte_planes(t: i64) -> (u32, u32) {
    let (mut x, mut p, mut n) = (t, 0u32, 0u32);
    for i in 0..9 {
        let d = bal_mod(x, 3);
        if d == 1 {
            p |= 1 << i;
        } else if d == -1 {
            n |= 1 << i;
        }
        x = (x - d) / 3;
    }
    (p, n)
}

/// Produit scalaire de deux trytes (9 trits) : Σ a_i·b_i sur 9 trits.
#[inline]
fn tdot_t(a: i64, b: i64) -> i64 {
    let ((ap, an), (bp, bn)) = (tryte_planes(a), tryte_planes(b));
    let pos = (ap & bp) | (an & bn);
    let neg = (ap & bn) | (an & bp);
    pos.count_ones() as i64 - neg.count_ones() as i64
}

/// Somme des 9 trits d'un tryte.
#[inline]
fn tsum_t(a: i64) -> i64 {
    let (p, n) = tryte_planes(a);
    p.count_ones() as i64 - n.count_ones() as i64
}

/// Sélection trit à trit : masque −1 → a, 0 → d (valeur précédente), +1 → b.
#[inline]
fn tsel(m: i64, a: i64, b: i64, d: i64) -> i64 {
    let ((mp, mn), (ap, an), (bp, bn), (dp, dn)) = (to_planes(m), to_planes(a), to_planes(b), to_planes(d));
    let mz = !(mp | mn) & M9;
    let p = (mn & ap) | (mp & bp) | (mz & dp);
    let n = (mn & an) | (mp & bn) | (mz & dn);
    from_planes(p, n)
}

impl Vm {
    /// Longueur active, bornée au nombre de voies du format (27 trytes ou 9 mots).
    #[inline(always)]
    fn vl_n(&self, max: usize) -> usize {
        self.csr[csr::VL].clamp(0, max as i64) as usize
    }

    /// Adresse physique d'un bloc de `n` trytes contigus : mêmes règles que LDT/LDW
    /// (UBASE/ULIMIT en mode utilisateur, RAM seulement). Accès MMIO vectoriel : piège.
    #[inline]
    fn vphys(&self, a: i64, n: usize) -> Result<usize, i64> {
        if a < 0 {
            return Err(a);
        }
        let p = match self.user_space() {
            Some((ub, ul)) => {
                if a + n as i64 > ul {
                    return Err(a);
                }
                a + ub
            }
            None => a,
        };
        if p < 0 || p as usize + n > self.mem.len() {
            return Err(a);
        }
        Ok(p as usize)
    }

    /// Exécute une instruction vectorielle (codes VSETVL..VSPLATW). Err(adresse) = piège MEM.
    pub(crate) fn vec_exec(&mut self, i: Inst) -> Result<(), i64> {
        let (rd, s1, s2) = (i.rd as usize, i.rs1 as usize, i.rs2 as usize);
        match i.op {
            op::VSETVL => {
                let v = self.regs[s1].clamp(0, VLEN as i64);
                self.csr[csr::VL] = v;
                self.regs[rd] = v;
            }
            op::VLD => {
                let n = self.vl_n(VLEN);
                let base = wrap27(self.regs[s1] + i.imm);
                if n > 0 {
                    let p = self.vphys(base, n)?;
                    self.mem.read_slice(p, &mut self.vregs[rd][..n]);
                }
            }
            op::VST => {
                let n = self.vl_n(VLEN);
                let base = wrap27(self.regs[s1] + i.imm);
                if n > 0 {
                    let p = self.vphys(base, n)?;
                    self.mem.write_slice(p, &self.vregs[rd][..n]);
                    self.cache.invalidate_range(p / 3, (p + n + 2) / 3);
                }
            }
            op::VLDS => {
                let n = self.vl_n(VLEN);
                let (base, stride) = (self.regs[s1], self.regs[s2]);
                for k in 0..n {
                    let p = self.vphys(wrap27(base + k as i64 * stride), 1)?;
                    self.vregs[rd][k] = self.mem.get(p);
                }
            }
            op::VSTS => {
                let n = self.vl_n(VLEN);
                let (base, stride) = (self.regs[s1], self.regs[s2]);
                for k in 0..n {
                    let p = self.vphys(wrap27(base + k as i64 * stride), 1)?;
                    self.mem.set(p, self.vregs[rd][k]);
                    self.cache.invalidate(p / 3);
                }
            }
            // ---- arithmétique tryte (.T, modulo 3^9) et mot (.W, modulo 3^27) ----
            op::VADDT | op::VSUBT | op::VMULT => {
                let n = self.vl_n(VLEN);
                let (a, b) = (self.vregs[s1], self.vregs[s2]);
                let d = &mut self.vregs[rd];
                for k in 0..n {
                    let (x, y) = (a[k] as i64, b[k] as i64);
                    d[k] = wrap9(match i.op {
                        op::VADDT => x + y,
                        op::VSUBT => x - y,
                        _ => x * y,
                    }) as i16;
                }
            }
            op::VADDW | op::VSUBW | op::VMULW => {
                let n = self.vl_n(WLEN);
                let (a, b) = (self.vregs[s1], self.vregs[s2]);
                let d = &mut self.vregs[rd];
                for j in 0..n {
                    let (x, y) = (word_of(&a[3 * j..]), word_of(&b[3 * j..]));
                    let v = match i.op {
                        op::VADDW => wrap27(x + y),
                        op::VSUBW => wrap27(x - y),
                        _ => wrap27_i128(x as i128 * y as i128),
                    };
                    put_word(&mut d[3 * j..3 * j + 3], v);
                }
            }
            // ---- logique trit à trit (chaque tryte = 9 trits, 27 voies = 243 trits) ----
            op::VMIN | op::VMAX | op::VTMUL | op::VCONS | op::VANY => {
                let n = self.vl_n(VLEN);
                let (a, b) = (self.vregs[s1], self.vregs[s2]);
                let d = &mut self.vregs[rd];
                for k in 0..n {
                    let (x, y) = (a[k] as i64, b[k] as i64);
                    d[k] = match i.op {
                        op::VMIN => tmin(x, y),
                        op::VMAX => tmax(x, y),
                        op::VTMUL => tmul(x, y),
                        op::VCONS => tcons(x, y),
                        _ => tany(x, y),
                    } as i16;
                }
            }
            op::VNEG => {
                let n = self.vl_n(VLEN);
                let a = self.vregs[s1];
                let d = &mut self.vregs[rd];
                for k in 0..n {
                    d[k] = -a[k];
                }
            }
            op::VSEL => {
                // vsel vd(rd), vm(rs1), va(rs2), vb(rs3 = imm2)
                let n = self.vl_n(VLEN);
                let (m, a, b) = (self.vregs[s1], self.vregs[s2], self.vregs[(i.imm2 + 13) as usize]);
                let d = &mut self.vregs[rd];
                for k in 0..n {
                    d[k] = tsel(m[k] as i64, a[k] as i64, b[k] as i64, d[k] as i64) as i16;
                }
            }
            // ---- comparaisons : la voie reçoit −H (tout −1), 0, +H (tout +1) : masque pour VSEL ----
            op::VCMPT => {
                let n = self.vl_n(VLEN);
                let (a, b) = (self.vregs[s1], self.vregs[s2]);
                let d = &mut self.vregs[rd];
                for k in 0..n {
                    d[k] = ((a[k] as i64 - b[k] as i64).signum() * H9) as i16;
                }
            }
            op::VCMPW => {
                let n = self.vl_n(WLEN);
                let (a, b) = (self.vregs[s1], self.vregs[s2]);
                let d = &mut self.vregs[rd];
                for j in 0..n {
                    let s = (word_of(&a[3 * j..]) - word_of(&b[3 * j..])).signum();
                    put_word(&mut d[3 * j..3 * j + 3], s * H27);
                }
            }
            // ---- réductions vers un scalaire ----
            op::VTDOT | op::VTMACT => {
                let n = self.vl_n(VLEN);
                let (a, b) = (self.vregs[s1], self.vregs[s2]);
                let mut s = 0i64;
                for k in 0..n {
                    s += if i.op == op::VTDOT {
                        tdot_t(a[k] as i64, b[k] as i64)
                    } else {
                        a[k] as i64 * b[k] as i64
                    };
                }
                self.regs[rd] = s;
            }
            op::VSUMT => {
                let n = self.vl_n(VLEN);
                let a = self.vregs[s1];
                self.regs[rd] = a[..n].iter().map(|&x| tsum_t(x as i64)).sum();
            }
            op::VSUMW => {
                let n = self.vl_n(WLEN);
                let a = self.vregs[s1];
                self.regs[rd] = wrap27((0..n).map(|j| word_of(&a[3 * j..])).sum());
            }
            // ---- diffusion d'un scalaire ----
            op::VSPLATT => {
                let n = self.vl_n(VLEN);
                let v = wrap9(self.regs[s1]) as i16;
                self.vregs[rd][..n].fill(v);
            }
            op::VSPLATW => {
                let n = self.vl_n(WLEN);
                let v = wrap27(self.regs[s1]);
                let d = &mut self.vregs[rd];
                for j in 0..n {
                    put_word(&mut d[3 * j..3 * j + 3], v);
                }
            }
            _ => {}
        }
        Ok(())
    }
}
