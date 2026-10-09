//! Carte graphique 2D (« blitter ») : registres MMIO −60…−76, commandes exécutées par l'hôte.
//! Surfaces au format du mode 3 (1 mot = 1 pixel : trytes B, V, R). Adresse 0 = l'écran courant (mode 3).
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
}

pub mod cmd {
    pub const FILL: i64 = 1;
    pub const COPY: i64 = 2;
    pub const COPY_KEY: i64 = 3;
    pub const BLEND: i64 = 4;
    pub const FILL_ALPHA: i64 = 5;
}

pub const ALPHA_ONE: i64 = 729;

#[derive(Default, Clone)]
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
}

pub fn owns(a: i64) -> bool {
    (reg::OPS..=reg::CMD).contains(&a)
}

fn split(v: i64) -> [i16; 3] {
    let t0 = crate::trit::bal_mod(v, 19683);
    let r = (v - t0) / 19683;
    let t1 = crate::trit::bal_mod(r, 19683);
    let t2 = crate::trit::bal_mod((r - t1) / 19683, 19683);
    [t0 as i16, t1 as i16, t2 as i16]
}

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
            _ => {}
        }
    }

    /// Surface → (base physique, largeur, hauteur), ou None si invalide / hors de l'espace du processus.
    fn surface(&self, addr: i64, pitch: i64, h: i64) -> Option<(usize, i64, i64)> {
        if addr == 0 {
            if self.vmode != 3 || self.fb_addr <= 0 {
                return None;
            }
            let (w, h) = (self.hd_w as i64, self.hd_h as i64);
            let end = self.fb_addr + w * h * 3;
            return (end as usize <= self.mem.len()).then_some((self.fb_addr as usize, w, h));
        }
        if pitch <= 0 || h <= 0 || addr < 0 {
            return None;
        }
        let len = pitch.checked_mul(h)?.checked_mul(3)?;
        let base = match self.user_space() {
            Some((ub, ul)) => {
                if addr + len > ul {
                    return None;
                }
                addr + ub
            }
            None => addr,
        };
        ((base + len) as usize <= self.mem.len()).then_some((base as usize, pitch, h))
    }

    fn gpu_exec(&mut self, c: i64) {
        let g = self.gpu.clone();
        self.gpu.ops += 1;
        self.gpu.status = -1;
        let Some((db, dw, dh)) = self.surface(g.dst, g.dpitch, g.dh) else { return };
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
            let Some((sb, sw, shh)) = self.surface(g.src, g.spitch, g.sh) else { return };
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
        let drow = |r: usize| db + 3 * ((y as usize + r) * dw as usize + x as usize);
        let mut sbuf = vec![0i16; wu * 3];
        let mut dbuf = vec![0i16; wu * 3];
        let a = g.alpha.clamp(0, ALPHA_ONE) as i32;
        let mix = |d: i16, s: i16| (d as i32 + ((s as i32 - d as i32) * a) / ALPHA_ONE as i32) as i16;
        match c {
            cmd::FILL => {
                let t = split(g.color);
                for r in 0..hu {
                    self.mem.fill3(drow(r), wu, t);
                }
            }
            cmd::FILL_ALPHA => {
                let t = split(g.color);
                for r in 0..hu {
                    self.mem.read_slice(drow(r), &mut dbuf);
                    for (k, d) in dbuf.iter_mut().enumerate() {
                        *d = mix(*d, t[k % 3]);
                    }
                    self.mem.write_slice(drow(r), &dbuf);
                }
            }
            cmd::COPY | cmd::COPY_KEY | cmd::BLEND => {
                let (sb, sw) = src.unwrap();
                let srow = |r: usize| sb + 3 * ((sy as usize + r) * sw as usize + sx as usize);
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
                                if sbuf[3 * p..3 * p + 3] == key {
                                    sbuf[3 * p..3 * p + 3].copy_from_slice(&dbuf[3 * p..3 * p + 3]);
                                }
                            }
                        }
                        _ => {
                            self.mem.read_slice(drow(r), &mut dbuf);
                            for k in 0..wu * 3 {
                                sbuf[k] = mix(dbuf[k], sbuf[k]);
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
        let last = drow(hu - 1) + wu * 3;
        self.cache.invalidate_range(first / 3, last.div_ceil(3));
        self.gpu.status = w * h;
        self.gpu.pixels += (w * h) as u64;
    }
}
