//! Carte graphique 2D (« blitter ») : registres MMIO −60…−77, commandes exécutées par l'hôte.
//! Surfaces TRGB (9 trits) ou profondes (27 trits). Adresse 0 = l'écran courant (mode 3).
//! En mode utilisateur, les adresses de surface sont virtuelles : traduites et bornées par UBASE/ULIMIT,
//! comme FB_ADDR. Toutes les opérations sont découpées aux bords des surfaces.

use super::*;

pub mod reg {
    pub const CMD: i64 = -60; // écriture : exécute la commande
    pub const DST: i64 = -61; // adresse surface destination (0 = écran)
    pub const DPITCH: i64 = -62; // largeur en pixels de la destination
    pub const DH: i64 = -63; // hauteur de la destination
    pub const SRC: i64 = -64; // adresse surface source (0 = écran)
    pub const SPITCH: i64 = -65;
    pub const SH: i64 = -66;
    pub const X: i64 = -67;
    pub const Y: i64 = -68;
    pub const W: i64 = -69;
    pub const H: i64 = -70;
    pub const SX: i64 = -71;
    pub const SY: i64 = -72;
    pub const COLOR: i64 = -73; // couleur (mot) ou couleur transparente (COPY_KEY)
    pub const ALPHA: i64 = -74; // 0…729 (729 = opaque)
    pub const STATUS: i64 = -75; // lecture : pixels écrits par la dernière commande, −1 = erreur
    pub const OPS: i64 = -76; // lecture : nombre de commandes exécutées
    pub const DEPTH: i64 = -77; // surfaces non écran : 1 refusé, 9 TRGB, 27 défaut
}

pub mod cmd {
    pub const FILL: i64 = 1;
    pub const COPY: i64 = 2;
    pub const COPY_KEY: i64 = 3;
    pub const BLEND: i64 = 4;
    pub const FILL_ALPHA: i64 = 5;
}

pub const ALPHA_ONE: i64 = 729;

#[derive(Clone)]
pub struct Gpu {
    pub dst: i64,
    pub dpitch: i64,
    pub dh: i64,
    pub src: i64,
    pub spitch: i64,
    pub sh: i64,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub sx: i64,
    pub sy: i64,
    pub color: i64,
    pub alpha: i64,
    pub status: i64,
    pub ops: u64,
    pub pixels: u64,
    pub depth: i64,
}

impl Default for Gpu {
    fn default() -> Self {
        Self { dst: 0, dpitch: 0, dh: 0, src: 0, spitch: 0, sh: 0,
            x: 0, y: 0, w: 0, h: 0, sx: 0, sy: 0, color: 0, alpha: 0,
            status: 0, ops: 0, pixels: 0, depth: 27 }
    }
}

pub fn owns(a: i64) -> bool {
    (reg::DEPTH..=reg::CMD).contains(&a)
}

fn split(v: i64) -> [i16; 3] {
    let t0 = crate::trit::bal_mod(v, 19683);
    let r = (v - t0) / 19683;
    let t1 = crate::trit::bal_mod(r, 19683);
    let t2 = crate::trit::bal_mod((r - t1) / 19683, 19683);
    [t0 as i16, t1 as i16, t2 as i16]
}

// Canaux TRGB équilibrés, pas de mélange du nombre encodé (qui créerait des retenues).
fn split9(v: i64) -> [i16; 3] {
    let b = bal_mod(v, 27);
    let q = (wrap9(v) - b) / 27;
    let g = bal_mod(q, 27);
    [b as i16, g as i16, ((q - g) / 27) as i16]
}
fn pack9(c: [i16; 3]) -> i16 { c[0] + c[1] * 27 + c[2] * 729 }

impl Vm {
    pub(super) fn gpu_read(&self, a: i64) -> i64 {
        let g = &self.gpu;
        match a {
            reg::DST => g.dst,
            reg::DPITCH => g.dpitch,
            reg::DH => g.dh,
            reg::SRC => g.src,
            reg::SPITCH => g.spitch,
            reg::SH => g.sh,
            reg::X => g.x,
            reg::Y => g.y,
            reg::W => g.w,
            reg::H => g.h,
            reg::SX => g.sx,
            reg::SY => g.sy,
            reg::COLOR => g.color,
            reg::ALPHA => g.alpha,
            reg::STATUS => g.status,
            reg::OPS => wrap27(g.ops as i64),
            reg::DEPTH => g.depth,
            _ => 0,
        }
    }

    pub(super) fn gpu_write(&mut self, a: i64, v: i64) {
        let g = &mut self.gpu;
        match a {
            reg::CMD => self.gpu_exec(v),
            reg::DST => g.dst = v,
            reg::DPITCH => g.dpitch = v,
            reg::DH => g.dh = v,
            reg::SRC => g.src = v,
            reg::SPITCH => g.spitch = v,
            reg::SH => g.sh = v,
            reg::X => g.x = v,
            reg::Y => g.y = v,
            reg::W => g.w = v,
            reg::H => g.h = v,
            reg::SX => g.sx = v,
            reg::SY => g.sy = v,
            reg::COLOR => g.color = v,
            reg::ALPHA => g.alpha = v.clamp(0, ALPHA_ONE),
            reg::DEPTH => g.depth = if v == 1 || v == 9 { v } else { 27 },
            _ => {}
        }
    }

    /// Surface → (base physique, largeur, hauteur, trytes/pixel). Trits et conversions refusés.
    fn surface(&self, addr: i64, pitch: i64, h: i64) -> Option<(usize, i64, i64, usize)> {
        let (base, w, h, depth) = if addr == 0 {
            if self.vmode != 3 || self.fb_addr <= 0 { return None; }
            (self.fb_addr, self.hd_w as i64, self.hd_h as i64, self.fb_depth)
        } else {
            if pitch <= 0 || h <= 0 || addr < 0 { return None; }
            let base = match self.user_space() {
                Some((ub, _)) => addr.checked_add(ub)?,
                None => addr,
            };
            (base, pitch, h, self.gpu.depth)
        };
        let stride = match depth { 9 => 1, 27 => 3, _ => return None };
        let len = w.checked_mul(h)?.checked_mul(stride as i64)?;
        let end = base.checked_add(len)?;
        if let Some((ub, ul)) = self.user_space() {
            if base < ub || end > ub.checked_add(ul)? { return None; }
        }
        (base >= 0 && end >= base && end as usize <= self.mem.len()).then_some((base as usize, w, h, stride))
    }

    fn gpu_exec(&mut self, c: i64) {
        let g = self.gpu.clone();
        self.gpu.ops += 1;
        self.gpu.status = -1;
        let Some((db, dw, dh, stride)) = self.surface(g.dst, g.dpitch, g.dh) else { return };
        // rectangle destination découpé à la surface ; décalage reporté sur la source
        let (mut x, mut y, mut w, mut h, mut sx, mut sy) = (g.x, g.y, g.w, g.h, g.sx, g.sy);
        if x < 0 {
            w += x;
            sx -= x;
            x = 0;
        }
        if y < 0 {
            h += y;
            sy -= y;
            y = 0;
        }
        w = w.min(dw - x);
        h = h.min(dh - y);
        let src = if matches!(c, cmd::COPY | cmd::COPY_KEY | cmd::BLEND) {
            let Some((sb, sw, shh, ss)) = self.surface(g.src, g.spitch, g.sh) else { return };
            if ss != stride { return; } // aucune conversion implicite entre profondeurs
            if sx < 0 {
                w += sx;
                x -= sx;
                sx = 0;
            }
            if sy < 0 {
                h += sy;
                y -= sy;
                sy = 0;
            }
            w = w.min(sw - sx);
            h = h.min(shh - sy);
            Some((sb, sw))
        } else {
            None
        };
        if w <= 0 || h <= 0 {
            self.gpu.status = 0;
            return;
        }
        let (wu, hu) = (w as usize, h as usize);
        let drow = |r: usize| db + stride * ((y as usize + r) * dw as usize + x as usize);
        let mut sbuf = vec![0i16; wu * stride];
        let mut dbuf = vec![0i16; wu * stride];
        let a = g.alpha.clamp(0, ALPHA_ONE) as i32;
        let mix = |d: i16, s: i16| (d as i32 + ((s as i32 - d as i32) * a) / ALPHA_ONE as i32) as i16;
        match c {
            cmd::FILL => {
                let t = split(g.color);
                for r in 0..hu {
                    if stride == 3 { self.mem.fill3(drow(r), wu, t); }
                    else { dbuf.fill(wrap9(g.color) as i16); self.mem.write_slice(drow(r), &dbuf); }
                }
            }
            cmd::FILL_ALPHA => {
                let t = split(g.color);
                for r in 0..hu {
                    self.mem.read_slice(drow(r), &mut dbuf);
                    for (k, d) in dbuf.iter_mut().enumerate() {
                        *d = if stride == 3 { mix(*d, t[k % 3]) } else {
                            let dc = split9(*d as i64);
                            let sc = split9(g.color);
                            pack9([mix(dc[0], sc[0]), mix(dc[1], sc[1]), mix(dc[2], sc[2])])
                        };
                    }
                    self.mem.write_slice(drow(r), &dbuf);
                }
            }
            cmd::COPY | cmd::COPY_KEY | cmd::BLEND => {
                let (sb, sw) = src.unwrap();
                let srow = |r: usize| sb + stride * ((sy as usize + r) * sw as usize + sx as usize);
                // même surface et destination plus bas : parcourir de bas en haut (défilement)
                let rows: Vec<usize> = if sb == db && y > sy { (0..hu).rev().collect() } else { (0..hu).collect() };
                let key = split(g.color);
                for r in rows {
                    self.mem.read_slice(srow(r), &mut sbuf);
                    match c {
                        cmd::COPY => {}
                        cmd::COPY_KEY => {
                            self.mem.read_slice(drow(r), &mut dbuf);
                            for p in 0..wu {
                                let transparent = if stride == 3 { sbuf[3 * p..3 * p + 3] == key }
                                    else { sbuf[p] == wrap9(g.color) as i16 };
                                if transparent {
                                    let k = stride * p;
                                    sbuf[k..k + stride].copy_from_slice(&dbuf[k..k + stride]);
                                }
                            }
                        }
                        _ => {
                            self.mem.read_slice(drow(r), &mut dbuf);
                            for k in 0..wu * stride {
                                sbuf[k] = if stride == 3 { mix(dbuf[k], sbuf[k]) } else {
                                    let d = split9(dbuf[k] as i64);
                                    let s = split9(sbuf[k] as i64);
                                    pack9([mix(d[0], s[0]), mix(d[1], s[1]), mix(d[2], s[2])])
                                };
                            }
                        }
                    }
                    self.mem.write_slice(drow(r), &sbuf);
                }
            }
            _ => return,
        }
        // le code éventuellement écrasé doit être redécodé
        let first = drow(0);
        let last = drow(hu - 1) + wu * stride;
        self.cache.invalidate_range(first / 3, last.div_ceil(3));
        self.gpu.status = w * h;
        self.gpu.pixels += (w * h) as u64;
    }
}
