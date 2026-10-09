//! Contrat des profondeurs : tailles, captures, bornes et commandes GPU.
use super::*;
use gpu::{cmd, reg};

#[test]
fn neuf_formats_et_capture() {
    for (w, h) in [(576, 360), (1280, 720), (1920, 1080)] {
        for depth in [1, 9, 27] {
            let mut v = Vm::new(7_000_002);
            v.mmio_write(mmio::VMODE, 3);
            v.mmio_write(mmio::FB_WIDTH, w);
            v.mmio_write(mmio::FB_HEIGHT, h);
            v.mmio_write(mmio::FB_DEPTH, depth);
            v.mmio_write(mmio::FB_ADDR, 1000);
            let n = w * h;
            assert_eq!(
                v.fb_trytes(),
                match depth {
                    1 => (n + 8) / 9,
                    9 => n,
                    _ => n * 3,
                }
            );
            assert_eq!(v.mmio_read(mmio::FB_DEPTH), depth);
            // Première et dernière trytes blanches ; dernier pixel partiel inclus.
            v.mem.set(1000, 9841);
            if depth == 27 {
                v.mem.set(1001, 9841);
                v.mem.set(1002, 9841);
            }
            let end = 1000 + v.fb_trytes() as usize;
            for a in end - if depth == 27 { 3 } else { 1 }..end {
                v.mem.set(a, 9841);
            }
            v.capture_present = true;
            v.mmio_write(mmio::FB_PRESENT, 0);
            assert_eq!((v.present_w, v.present_h), (w as usize, h as usize));
            assert_eq!(&v.present_rgba[..4], &[255, 255, 255, 255]);
            assert_eq!(
                &v.present_rgba[(n as usize - 1) * 4..],
                &[255, 255, 255, 255]
            );
            assert_eq!(
                v.present_hi.len(),
                if depth == 27 { n as usize * 3 } else { 0 }
            );
            v.mmio_write(mmio::FB_DEPTH, 27);
            assert_eq!(&v.present_rgba[..4], &[255, 255, 255, 255]); // image figée
        }
    }
    let mut v = Vm::new(3000);
    for invalid in [-1, 0, 2, 8, 28] {
        v.mmio_write(mmio::FB_DEPTH, invalid);
        v.gpu_write(reg::DEPTH, invalid);
        assert_eq!(v.mmio_read(mmio::FB_DEPTH), 27);
        assert_eq!(v.gpu_read(reg::DEPTH), 27);
    }
}

#[test]
fn trits_sans_padding_et_bornes_utilisateur() {
    let mut v = Vm::new(3000);
    v.vmode = 3;
    v.hd_w = 16;
    v.hd_h = 17;
    v.fb_depth = 1;
    assert_eq!(v.fb_trytes(), 31);
    v.mode = 1;
    v.csr[csr::UBASE] = 1000;
    v.csr[csr::ULIMIT] = 100;
    v.mmio_write(mmio::FB_ADDR, 69);
    assert_eq!(v.fb_addr, 1069);
    v.mmio_write(mmio::FB_ADDR, 70);
    assert_eq!(v.fb_addr, 0);
    v.mmio_write(mmio::FB_ADDR, 69);
    // Fin de ligne x=15 et début y=1 partagent la même tryte (indices trits 6,7).
    v.mem.set(1070, -729 + 2187);
    let mut rgba = vec![0; 16 * 17 * 4];
    v.render_rgba(&mut rgba);
    assert_eq!(&rgba[15 * 4..16 * 4], &[0, 0, 0, 255]);
    assert_eq!(&rgba[16 * 4..17 * 4], &[255, 255, 255, 255]);
    v.gpu_write(reg::CMD, cmd::FILL);
    assert_eq!(v.gpu.status, -1); // GPU trit refusé
}

fn color(depth: i64, r: i64, g: i64, b: i64) -> i64 {
    if depth == 9 {
        b + 27 * g + 729 * r
    } else {
        b + T9 * g + T9 * T9 * r
    }
}
fn pixel(v: &Vm, a: usize, depth: i64) -> i64 {
    if depth == 9 {
        v.mem.get(a) as i64
    } else {
        let (b, g, r) = v.mem.get3(a);
        b as i64 + T9 * g as i64 + T9 * T9 * r as i64
    }
}

#[test]
fn gpu_deux_profondeurs() {
    for depth in [9, 27] {
        let mut v = Vm::new(30_000);
        v.vmode = 3;
        v.fb_addr = 1000;
        v.hd_w = 16;
        v.hd_h = 16;
        v.fb_depth = depth;
        v.gpu.depth = depth;
        v.gpu.w = 4;
        v.gpu.h = 2;
        let stride = if depth == 9 { 1 } else { 3 };
        let red = color(depth, 13, -13, -13);
        let blue = color(depth, -13, -13, 13);
        v.gpu.color = red;
        v.gpu_write(reg::CMD, cmd::FILL);
        assert_eq!(v.gpu.status, 8);
        assert_eq!(pixel(&v, 1000, depth), red);
        v.gpu.dst = 5000;
        v.gpu.dpitch = 16;
        v.gpu.dh = 16;
        v.gpu.src = 0;
        v.gpu_write(reg::CMD, cmd::COPY);
        assert_eq!(pixel(&v, 5000, depth), red);
        v.gpu.dst = 0;
        v.gpu.color = blue;
        v.gpu_write(reg::CMD, cmd::FILL);
        v.gpu.src = 5000;
        v.gpu.spitch = 16;
        v.gpu.sh = 16;
        v.gpu.color = red;
        v.gpu_write(reg::CMD, cmd::COPY_KEY);
        assert_eq!(pixel(&v, 1000, depth), blue);
        v.gpu.alpha = 365;
        v.gpu_write(reg::CMD, cmd::BLEND);
        assert_eq!(pixel(&v, 1000, depth), color(depth, 0, -13, 0));
        v.gpu.color = color(depth, 13, 13, 13);
        v.gpu.alpha = 729;
        v.gpu_write(reg::CMD, cmd::FILL_ALPHA);
        assert_eq!(pixel(&v, 1000, depth), color(depth, 13, 13, 13));
        // Découpage, défilement sur la même surface et préservation du pixel voisin.
        v.gpu.x = -2;
        v.gpu.y = -1;
        v.gpu.w = 4;
        v.gpu.h = 2;
        v.gpu.color = red;
        v.gpu_write(reg::CMD, cmd::FILL);
        assert_eq!(v.gpu.status, 2);
        v.gpu.src = 0;
        v.gpu.x = 0;
        v.gpu.y = 1;
        v.gpu.sx = 0;
        v.gpu.sy = 0;
        v.gpu.w = 2;
        v.gpu.h = 2;
        v.gpu_write(reg::CMD, cmd::COPY);
        assert_eq!(pixel(&v, 1000 + 16 * stride, depth), red);
        assert_eq!(
            pixel(&v, 1000 + 32 * stride, depth),
            color(depth, 13, 13, 13)
        );
        // Une surface virtuelle hors limites, même écran, ne doit rien écrire.
        v.mode = 1;
        v.csr[csr::UBASE] = 900;
        v.csr[csr::ULIMIT] = 150;
        v.gpu_write(reg::CMD, cmd::FILL);
        assert_eq!(v.gpu.status, -1);
        v.mode = -1;
        v.gpu.dst = i64::MAX;
        v.gpu_write(reg::CMD, cmd::FILL);
        assert_eq!(v.gpu.status, -1);
        v.gpu.dst = 0;
        v.gpu.depth = if depth == 9 { 27 } else { 9 };
        v.gpu.src = 5000;
        v.gpu_write(reg::CMD, cmd::COPY);
        assert_eq!(v.gpu.status, -1);
    }
}
