//! Ternaire équilibré : trytes (9 trits) et mots (27 trits) stockés en i64.

use std::sync::OnceLock;

pub const fn pow3(k: u32) -> i64 {
    let mut r = 1i64;
    let mut i = 0;
    while i < k {
        r *= 3;
        i += 1;
    }
    r
}

pub const POW3: [i64; 28] = {
    let mut t = [0i64; 28];
    let mut i = 0;
    while i < 28 {
        t[i] = pow3(i as u32);
        i += 1;
    }
    t
};

pub const T9: i64 = pow3(9); // 19683
pub const H9: i64 = (T9 - 1) / 2; // 9841
pub const W27: i64 = pow3(27);
pub const H27: i64 = (W27 - 1) / 2;

/// Reste équilibré : résultat dans [-(m-1)/2, (m-1)/2], m impair.
#[inline(always)]
pub fn bal_mod(v: i64, m: i64) -> i64 {
    let h = (m - 1) / 2;
    (v + h).rem_euclid(m) - h
}

/// Ramène dans la plage d'un mot (modulo 3^27).
#[inline(always)]
pub fn wrap27(v: i64) -> i64 {
    if v > H27 || v < -H27 {
        bal_mod(v, W27)
    } else {
        v
    }
}

#[inline(always)]
pub fn wrap27_i128(v: i128) -> i64 {
    let m = W27 as i128;
    let h = H27 as i128;
    ((v + h).rem_euclid(m) - h) as i64
}

#[inline(always)]
pub fn wrap9(v: i64) -> i64 {
    if v > H9 || v < -H9 {
        bal_mod(v, T9)
    } else {
        v
    }
}

// ---------- logique trit à trit via plans de bits (p = trits +1, n = trits -1) ----------

struct Tables {
    to: Vec<u32>,   // tryte+H9 -> p | n<<9
    from: Vec<i16>, // p | n<<9 -> tryte
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let mut to = vec![0u32; T9 as usize];
        let mut from = vec![0i16; 1 << 18];
        for v in -H9..=H9 {
            let (mut x, mut p, mut n) = (v, 0u32, 0u32);
            for i in 0..9 {
                let d = bal_mod(x, 3);
                if d == 1 {
                    p |= 1 << i
                } else if d == -1 {
                    n |= 1 << i
                }
                x = (x - d) / 3;
            }
            to[(v + H9) as usize] = p | (n << 9);
            from[(p | (n << 9)) as usize] = v as i16;
        }
        Tables { to, from }
    })
}

#[inline]
pub fn to_planes(v: i64) -> (u32, u32) {
    let t = tables();
    let t0 = bal_mod(v, T9);
    let r = (v - t0) / T9;
    let t1 = bal_mod(r, T9);
    let t2 = (r - t1) / T9;
    let a = t.to[(t0 + H9) as usize];
    let b = t.to[(t1 + H9) as usize];
    let c = t.to[(t2 + H9) as usize];
    let p = (a & 0x1ff) | ((b & 0x1ff) << 9) | ((c & 0x1ff) << 18);
    let n = (a >> 9) | ((b >> 9) << 9) | ((c >> 9) << 18);
    (p, n)
}

#[inline]
pub fn from_planes(p: u32, n: u32) -> i64 {
    let t = tables();
    let g = |k: u32| t.from[(((p >> (9 * k)) & 0x1ff) | (((n >> (9 * k)) & 0x1ff) << 9)) as usize] as i64;
    g(0) + g(1) * T9 + g(2) * T9 * T9
}

const M27: u32 = (1 << 27) - 1;

pub fn tmin(a: i64, b: i64) -> i64 {
    let ((ap, an), (bp, bn)) = (to_planes(a), to_planes(b));
    from_planes(ap & bp, an | bn)
}
pub fn tmax(a: i64, b: i64) -> i64 {
    let ((ap, an), (bp, bn)) = (to_planes(a), to_planes(b));
    from_planes(ap | bp, an & bn)
}
pub fn tmul(a: i64, b: i64) -> i64 {
    let ((ap, an), (bp, bn)) = (to_planes(a), to_planes(b));
    from_planes((ap & bp) | (an & bn), (ap & bn) | (an & bp))
}
pub fn tcons(a: i64, b: i64) -> i64 {
    let ((ap, an), (bp, bn)) = (to_planes(a), to_planes(b));
    from_planes(ap & bp, an & bn)
}
pub fn tany(a: i64, b: i64) -> i64 {
    let ((ap, an), (bp, bn)) = (to_planes(a), to_planes(b));
    let (p, n) = (ap | bp, an | bn);
    from_planes(p & !n & M27, n & !p & M27)
}

/// Décalage de k trits : k>0 → ×3^k (mod 3^27) ; k<0 → troncature équilibrée (arrondi au plus proche).
#[inline]
pub fn sht(v: i64, k: i64) -> i64 {
    if k == 0 {
        v
    } else if k > 0 {
        if k >= 27 {
            0
        } else {
            wrap27_i128(v as i128 * POW3[k as usize] as i128)
        }
    } else {
        let k = -k;
        if k >= 27 {
            0
        } else {
            let m = POW3[k as usize];
            (v + (m - 1) / 2).div_euclid(m)
        }
    }
}

/// Partie haute (trits 27..53) du produit équilibré.
pub fn mulh(a: i64, b: i64) -> i64 {
    let p = a as i128 * b as i128;
    let m = W27 as i128;
    let lo = (p + H27 as i128).rem_euclid(m) - H27 as i128;
    ((p - lo) / m) as i64
}

/// Représentation en trits, poids fort d'abord, `width` trits.
pub fn to_trit_string(v: i64, width: usize) -> String {
    let mut x = v;
    let mut s = vec![b'0'; width];
    for i in 0..width {
        let d = bal_mod(x, 3);
        s[width - 1 - i] = match d {
            1 => b'+',
            -1 => b'-',
            _ => b'0',
        };
        x = (x - d) / 3;
    }
    String::from_utf8(s).unwrap()
}

pub fn from_trit_string(s: &str) -> Option<i64> {
    let mut v: i64 = 0;
    for c in s.chars() {
        let d = match c {
            '+' | '1' => 1,
            '-' | 'T' | 't' => -1,
            '0' => 0,
            '_' => continue,
            _ => return None,
        };
        v = v.checked_mul(3)?.checked_add(d)?;
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn planes_roundtrip_and_ops() {
        for v in [-H27, -12345678, -1, 0, 1, 42, 9841, -9842, H27] {
            let (p, n) = to_planes(v);
            assert_eq!(p & n, 0);
            assert_eq!(from_planes(p, n), v);
            assert_eq!(tmin(v, v), v);
            assert_eq!(tmax(v, -v), from_planes(p | n, 0));
            assert_eq!(tmul(v, -H27), -tmul(v, H27));
        }
        assert_eq!(sht(5, 1), 15);
        assert_eq!(sht(4, -1), 1); // 4 = ++ -> +
        assert_eq!(sht(5, -1), 2); // 5 = +-- -> +- = 2
        assert_eq!(wrap27(H27 + 1), -H27);
        assert_eq!(to_trit_string(5, 3), "+--");
        assert_eq!(from_trit_string("+--"), Some(5));
    }
}
