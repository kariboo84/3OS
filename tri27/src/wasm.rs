//! API C brute pour le front web (wasm32-unknown-unknown), sans wasm-bindgen.
//!
//! Protocole côté JS :
//!   p = src_alloc(len); écrire l'UTF-8 dans memory[p..p+len]; r = assemble(p, len)
//!   r == 0 → OK (programme chargé, CPU réinitialisé) ; sinon err_ptr()/err_len()
//!   run(n) → instructions exécutées (f64) ; out_ptr()/out_len() puis out_clear()
//!   fb_render() → pointeur RGBA 320×200×4 ; push_key / push_char / set_time_ms
//! Les entiers 64 bits sont renvoyés en f64 pour éviter les BigInt côté JS.

use crate::asm;
use crate::vm::{Vm, FB_H, FB_W};
use std::ptr::addr_of_mut;

/// 3^14 trytes de RAM.
pub const WEB_RAM: usize = 4_782_969;

struct State {
    vm: Vm,
    image: Vec<i16>,
    entry: i64,
    src: Vec<u8>,
    err: String,
    rgba: Vec<u8>,
}

static mut STATE: Option<State> = None;

fn st() -> &'static mut State {
    // SAFETY : wasm32 mono-thread, accès uniquement via ces exports.
    unsafe {
        let s = &mut *addr_of_mut!(STATE);
        s.get_or_insert_with(|| State {
            vm: Vm::new(WEB_RAM),
            image: Vec::new(),
            entry: 0,
            src: Vec::new(),
            err: String::new(),
            rgba: vec![0; FB_W * FB_H * 4],
        })
    }
}

fn fresh_vm(s: &mut State) {
    let mut vm = Vm::new(WEB_RAM);
    if !s.image.is_empty() {
        vm.load(0, &s.image);
    }
    vm.reset_cpu(s.entry);
    s.vm = vm;
    for px in s.rgba.chunks_exact_mut(4) {
        px.copy_from_slice(&[0, 0, 0, 255]);
    }
}

/// Réserve `len` octets pour le source et renvoie leur adresse.
#[no_mangle]
pub extern "C" fn src_alloc(len: usize) -> *mut u8 {
    let s = st();
    s.src.clear();
    s.src.resize(len, 0);
    s.src.as_mut_ptr()
}

/// Assemble le source (ptr,len) ; si OK, charge l'image dans une VM neuve.
/// 0 = OK, 1 = erreur d'assemblage, 2 = UTF-8 invalide, 3 = image trop grande.
#[no_mangle]
pub extern "C" fn assemble(ptr: *const u8, len: usize) -> i32 {
    let s = st();
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(e) => {
            s.err = format!("source non UTF-8 : {e}");
            return 2;
        }
    };
    match asm::assemble(&text) {
        Ok(img) => {
            if img.trytes.len() >= WEB_RAM {
                s.err = format!("image trop grande : {} trytes (RAM {})", img.trytes.len(), WEB_RAM);
                return 3;
            }
            s.image = img.trytes;
            s.entry = img.entry;
            s.err.clear();
            fresh_vm(s);
            0
        }
        Err(e) => {
            s.err = e;
            1
        }
    }
}

#[no_mangle]
pub extern "C" fn err_ptr() -> *const u8 {
    st().err.as_ptr()
}

#[no_mangle]
pub extern "C" fn err_len() -> usize {
    st().err.len()
}

/// Recharge l'image assemblée dans une VM neuve (RAM remise à zéro).
#[no_mangle]
pub extern "C" fn reset() {
    let s = st();
    let (out_keep, t) = (String::new(), s.vm.time_ms);
    fresh_vm(s);
    s.vm.out = out_keep;
    s.vm.time_ms = t;
}

/// Exécute au plus `n` instructions ; renvoie le nombre exécuté.
#[no_mangle]
pub extern "C" fn run(n: f64) -> f64 {
    let n = if n.is_finite() && n > 0.0 { n as u64 } else { 0 };
    st().vm.run(n) as f64
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    st().vm.out.as_ptr()
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    st().vm.out.len()
}

#[no_mangle]
pub extern "C" fn out_clear() {
    st().vm.out.clear();
}

/// Convertit le framebuffer en RGBA et renvoie le pointeur (320×200×4 octets).
#[no_mangle]
pub extern "C" fn fb_render() -> *const u8 {
    let s = st();
    s.vm.render_rgba(&mut s.rgba);
    s.vm.frame_ready = false;
    s.rgba.as_ptr()
}

#[no_mangle]
pub extern "C" fn fb_ptr() -> *const u8 {
    st().rgba.as_ptr()
}

#[no_mangle]
pub extern "C" fn fb_width() -> i32 {
    FB_W as i32
}

#[no_mangle]
pub extern "C" fn fb_height() -> i32 {
    FB_H as i32
}

/// Événement clavier : +code = appui, −code = relâche.
#[no_mangle]
pub extern "C" fn push_key(code: i32) {
    let q = &mut st().vm.keys;
    if q.len() < 4096 {
        q.push_back(code as i64);
    }
}

/// Caractère pour CONSOLE_IN.
#[no_mangle]
pub extern "C" fn push_char(c: i32) {
    let q = &mut st().vm.input;
    if q.len() < 65536 {
        q.push_back(c as i64);
    }
}

#[no_mangle]
pub extern "C" fn set_time_ms(t: f64) {
    st().vm.time_ms = t as i64;
}

#[no_mangle]
pub extern "C" fn halted() -> i32 {
    st().vm.halted as i32
}

#[no_mangle]
pub extern "C" fn exit_code() -> f64 {
    st().vm.exit_code as f64
}

/// 1 si la VM s'est arrêtée sur une erreur ; le message est alors copié
/// dans le tampon d'erreur (err_ptr/err_len).
#[no_mangle]
pub extern "C" fn has_error() -> i32 {
    let s = st();
    match &s.vm.error {
        Some(e) => {
            s.err = e.clone();
            1
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn cycles() -> f64 {
    st().vm.cycles as f64
}

#[no_mangle]
pub extern "C" fn frames() -> f64 {
    st().vm.frames as f64
}

#[no_mangle]
pub extern "C" fn pc() -> f64 {
    st().vm.pc as f64
}

#[no_mangle]
pub extern "C" fn ram_size() -> f64 {
    st().vm.mem.len() as f64
}
