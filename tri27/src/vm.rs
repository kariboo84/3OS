//! Machine virtuelle TRI-27.

use crate::isa::{decode, op, Inst};
use crate::trit::*;
use std::collections::VecDeque;

pub const Z: usize = 13; // indice tableau du registre zero
pub const SP: usize = 12; // -1
pub const RA: usize = 11; // -2
pub const A0: usize = 14; // +1

pub const FB_W: usize = 320;
pub const FB_H: usize = 200;

pub mod mmio {
    pub const CONSOLE_OUT: i64 = -1;
    pub const CONSOLE_IN: i64 = -2;
    pub const EXIT: i64 = -3;
    pub const CYCLES: i64 = -4;
    pub const FB_ADDR: i64 = -5;
    pub const FB_PRESENT: i64 = -6;
    pub const KEY: i64 = -7;
    pub const TIME_MS: i64 = -8;
    pub const VMODE: i64 = -9;
    pub const MOUSE_X: i64 = -10;
    pub const MOUSE_Y: i64 = -11;
    pub const MOUSE_BTN: i64 = -12;
    pub const DISK_SECTOR: i64 = -20;
    pub const DISK_ADDR: i64 = -21;
    pub const DISK_CMD: i64 = -22;
    pub const DISK_STATUS: i64 = -23;
    pub const DISK_COUNT: i64 = -24;
}
pub const SECTOR: usize = 729;

/// Registres réservés au noyau même avec IOPERM : arrêt machine et disque.
#[inline(always)]
pub fn mmio_privileged(a: i64) -> bool {
    a == mmio::EXIT || (-24..=-20).contains(&a)
}
pub const TRIT_W: usize = 576;
pub const TRIT_H: usize = 360;

pub mod csr {
    pub const MODE: usize = 0;
    pub const TVEC: usize = 1;
    pub const EPC: usize = 2;
    pub const CAUSE: usize = 3;
    pub const TVAL: usize = 4;
    pub const SCRATCH: usize = 5;
    pub const TIMECMP: usize = 6;
    pub const IE: usize = 7;
    pub const PMODE: usize = 8;
    pub const PIE: usize = 9;
    /// Mode utilisateur (+1) : adresses virtuelles [0, ULIMIT) → physiques + UBASE.
    pub const UBASE: usize = 10;
    pub const ULIMIT: usize = 11;
    /// ≠ 0 : le mode utilisateur accède directement aux périphériques (sauf privilégiés).
    pub const IOPERM: usize = 12;
    pub const COUNT: usize = 13;
}

pub mod cause {
    pub const ILLEGAL: i64 = 1;
    pub const PRIV: i64 = 2;
    pub const MEM: i64 = 3;
    pub const DIV0: i64 = 4;
    pub const ALIGN: i64 = 5;
    pub const ECALL: i64 = 8;
    pub const TIMER: i64 = 9;
}

pub struct Vm {
    pub regs: [i64; 27],
    pub pc: i64,
    pub mem: Vec<i16>,
    cache: Vec<Inst>,
    pub csr: [i64; csr::COUNT],
    pub mode: i64,
    pub halted: bool,
    pub exit_code: i64,
    pub error: Option<String>,
    pub cycles: u64,
    pub out: String,
    pub input: VecDeque<i64>,
    pub keys: VecDeque<i64>,
    pub fb_addr: i64,
    pub vmode: i64,
    pub mouse_x: i64,
    pub mouse_y: i64,
    pub mouse_btn: i64,
    pub frames: u64,
    pub frame_ready: bool,
    /// Copie RGBA de l'image au moment du FB_PRESENT (pour captures fiables),
    /// None tant qu'aucune image n'a été présentée. Taille du mode actif.
    pub present_rgba: Vec<u8>,
    /// Activé par le CLI (--ppm) : sans lui, FB_PRESENT ne coûte rien côté hôte.
    pub capture_present: bool,
    /// Disque bloc : secteurs de 729 trytes.
    pub disk: Vec<i16>,
    pub disk_sector: i64,
    pub disk_addr: i64,
    pub disk_status: i64,
    pub disk_dirty: bool,
    /// WFI exécuté : run() rend la main à l'hôte jusqu'au prochain appel.
    pub waiting: bool,
    #[cfg(feature = "prof")]
    pub prof_op: [u64; 256],
    #[cfg(feature = "prof")]
    pub prof_user: u64,
    #[cfg(feature = "prof")]
    pub prof_pc: Vec<u32>,
    #[cfg(feature = "prof")]
    pub prof_traps: [u64; 16],
    pub present_w: usize,
    pub present_h: usize,
    pub time_ms: i64,
    pub snd: crate::sound::Tsg,
}

impl Vm {
    pub fn new(ram_trytes: usize) -> Vm {
        let ram = ram_trytes - ram_trytes % 3;
        let mut vm = Vm {
            regs: [0; 27],
            pc: 0,
            mem: vec![0; ram],
            cache: vec![Inst::UNDECODED; ram / 3],
            csr: [0; csr::COUNT],
            mode: -1,
            halted: false,
            exit_code: 0,
            error: None,
            cycles: 0,
            out: String::new(),
            input: VecDeque::new(),
            keys: VecDeque::new(),
            fb_addr: 0,
            vmode: 0,
            mouse_x: 0,
            mouse_y: 0,
            mouse_btn: 0,
            frames: 0,
            frame_ready: false,
            present_rgba: Vec::new(),
            capture_present: false,
            disk: Vec::new(),
            disk_sector: 0,
            disk_addr: 0,
            disk_status: 0,
            disk_dirty: false,
            waiting: false,
            #[cfg(feature = "prof")]
            prof_op: [0; 256],
            #[cfg(feature = "prof")]
            prof_user: 0,
            #[cfg(feature = "prof")]
            prof_pc: vec![0; ram / 3 + 1],
            #[cfg(feature = "prof")]
            prof_traps: [0; 16],
            present_w: 0,
            present_h: 0,
            time_ms: 0,
            snd: crate::sound::Tsg::new(),
        };
        vm.regs[SP] = ram as i64;
        vm
    }

    /// Charge des trytes en RAM et invalide le cache.
    pub fn load(&mut self, addr: i64, trytes: &[i16]) {
        let a = addr as usize;
        self.mem[a..a + trytes.len()].copy_from_slice(trytes);
        for c in self.cache.iter_mut() {
            *c = Inst::UNDECODED;
        }
    }

    pub fn reset_cpu(&mut self, entry: i64) {
        self.regs = [0; 27];
        self.regs[SP] = self.mem.len() as i64;
        self.pc = entry;
        self.mode = -1;
        self.csr = [0; csr::COUNT];
        self.halted = false;
        self.error = None;
        self.exit_code = 0;
    }

    /// Espace utilisateur courant (UBASE, ULIMIT), si le CPU est en mode utilisateur isolé.
    #[inline(always)]
    fn user_space(&self) -> Option<(i64, i64)> {
        if self.mode > 0 && self.csr[csr::ULIMIT] > 0 {
            Some((self.csr[csr::UBASE], self.csr[csr::ULIMIT]))
        } else {
            None
        }
    }

    /// Taille en trytes du framebuffer du mode vidéo courant.
    fn fb_trytes(&self) -> i64 {
        match self.vmode {
            1 => (TRIT_W / 9 * TRIT_H) as i64,
            2 => (TRIT_W * TRIT_H) as i64,
            _ => 320 * 200,
        }
    }

    /// Transfert synchrone d'un secteur : 1 = lire (disque → RAM), 2 = écrire.
    fn disk_cmd(&mut self, cmd: i64) {
        let s = self.disk_sector;
        let a = self.disk_addr;
        let nsec = (self.disk.len() / SECTOR) as i64;
        let ram_ok = a >= 0 && (a as usize) + SECTOR <= self.mem.len();
        self.disk_status = -1;
        if !ram_ok || s < 0 {
            return;
        }
        let (d, m) = (s as usize * SECTOR, a as usize);
        match cmd {
            1 if s < nsec => {
                self.mem[m..m + SECTOR].copy_from_slice(&self.disk[d..d + SECTOR]);
                let end = ((m + SECTOR + 2) / 3).min(self.cache.len());
                for c in &mut self.cache[m / 3..end] {
                    *c = Inst::UNDECODED;
                }
                self.disk_status = 0;
            }
            2 => {
                if self.disk.len() < d + SECTOR {
                    self.disk.resize(d + SECTOR, 0);
                }
                self.disk[d..d + SECTOR].copy_from_slice(&self.mem[m..m + SECTOR]);
                self.disk_dirty = true;
                self.disk_status = 0;
            }
            _ => {}
        }
    }

    // ---------------- mémoire ----------------

    fn mmio_read(&mut self, a: i64) -> i64 {
        if crate::sound::Tsg::owns(a) {
            return self.snd.read(a);
        }
        match a {
            mmio::CONSOLE_IN => self.input.pop_front().unwrap_or(-1),
            mmio::CYCLES => wrap27(self.cycles as i64),
            mmio::FB_ADDR => match self.user_space() {
                // vu du processus : adresse virtuelle
                Some((ub, _)) if self.fb_addr > 0 => self.fb_addr - ub,
                _ => self.fb_addr,
            },
            mmio::KEY => self.keys.pop_front().unwrap_or(0),
            mmio::TIME_MS => self.time_ms,
            mmio::VMODE => self.vmode,
            mmio::MOUSE_X => self.mouse_x,
            mmio::MOUSE_Y => self.mouse_y,
            mmio::MOUSE_BTN => self.mouse_btn,
            mmio::DISK_SECTOR => self.disk_sector,
            mmio::DISK_ADDR => self.disk_addr,
            mmio::DISK_STATUS => self.disk_status,
            mmio::DISK_COUNT => (self.disk.len() / SECTOR) as i64,
            _ => 0,
        }
    }

    fn mmio_write(&mut self, a: i64, v: i64) {
        if crate::sound::Tsg::owns(a) {
            self.snd.write(a, v);
            return;
        }
        match a {
            mmio::CONSOLE_OUT => {
                if let Some(c) = char::from_u32(v.rem_euclid(T9) as u32) {
                    self.out.push(c)
                }
            }
            mmio::EXIT => {
                self.exit_code = v;
                self.halted = true;
            }
            mmio::FB_ADDR => {
                self.fb_addr = match self.user_space() {
                    // traduction virtuelle → physique ; refusé (0) s'il déborde de l'espace
                    Some((ub, ul)) => {
                        if v > 0 && v + self.fb_trytes() <= ul {
                            v + ub
                        } else {
                            0
                        }
                    }
                    None => v,
                }
            }
            mmio::DISK_SECTOR => self.disk_sector = v,
            mmio::DISK_ADDR => self.disk_addr = v,
            mmio::DISK_CMD => self.disk_cmd(v),
            mmio::VMODE => {
                self.vmode = if v == 1 || v == 2 { v } else { 0 };
                self.set_mouse(self.mouse_x, self.mouse_y, self.mouse_btn);
            }
            mmio::FB_PRESENT => {
                self.frames += 1;
                self.frame_ready = true;
                if !self.capture_present {
                    return;
                }
                let (w, h) = self.fb_dims();
                self.present_rgba.resize(w * h * 4, 0);
                let mut tmp = std::mem::take(&mut self.present_rgba);
                self.render_rgba(&mut tmp);
                self.present_rgba = tmp;
                self.present_w = w;
                self.present_h = h;
            }
            _ => {}
        }
    }

    #[inline(always)]
    fn ld_t(&mut self, a: i64) -> Result<i64, i64> {
        if a >= 0 {
            match self.mem.get(a as usize) {
                Some(&t) => Ok(t as i64),
                None => Err(a),
            }
        } else {
            Ok(self.mmio_read(a))
        }
    }

    #[inline(always)]
    fn ld_w(&mut self, a: i64) -> Result<i64, i64> {
        if a >= 0 {
            let u = a as usize;
            if u + 2 < self.mem.len() {
                let m = &self.mem;
                Ok(m[u] as i64 + m[u + 1] as i64 * T9 + m[u + 2] as i64 * T9 * T9)
            } else {
                Err(a)
            }
        } else {
            Ok(self.mmio_read(a))
        }
    }

    #[inline(always)]
    fn st_t(&mut self, a: i64, v: i64) -> Result<(), i64> {
        if a >= 0 {
            let u = a as usize;
            if u < self.mem.len() {
                self.mem[u] = wrap9(v) as i16;
                self.cache[u / 3] = Inst::UNDECODED;
                Ok(())
            } else {
                Err(a)
            }
        } else {
            self.mmio_write(a, v);
            Ok(())
        }
    }

    #[inline(always)]
    fn st_w(&mut self, a: i64, v: i64) -> Result<(), i64> {
        if a >= 0 {
            let u = a as usize;
            if u + 2 < self.mem.len() {
                let t0 = bal_mod(v, T9);
                let r = (v - t0) / T9;
                let t1 = bal_mod(r, T9);
                let t2 = (r - t1) / T9;
                self.mem[u] = t0 as i16;
                self.mem[u + 1] = t1 as i16;
                self.mem[u + 2] = t2 as i16;
                self.cache[u / 3] = Inst::UNDECODED;
                self.cache[(u + 2) / 3] = Inst::UNDECODED;
                Ok(())
            } else {
                Err(a)
            }
        } else {
            self.mmio_write(a, v);
            Ok(())
        }
    }

    pub fn peek_word(&self, a: i64) -> i64 {
        let u = a as usize;
        if a < 0 || u + 2 >= self.mem.len() {
            return 0;
        }
        self.mem[u] as i64 + self.mem[u + 1] as i64 * T9 + self.mem[u + 2] as i64 * T9 * T9
    }

    // ---------------- pièges ----------------

    fn trap(&mut self, c: i64, tval: i64) {
        #[cfg(feature = "prof")]
        {
            self.prof_traps[c.clamp(0, 15) as usize] += 1;
        }
        let tvec = self.csr[csr::TVEC];
        if tvec == 0 {
            self.halted = true;
            self.exit_code = -1;
            let name = match c {
                cause::ILLEGAL => "instruction illégale",
                cause::PRIV => "privilège",
                cause::MEM => "accès mémoire",
                cause::DIV0 => "division par zéro",
                cause::ALIGN => "pc désaligné",
                cause::ECALL => "ecall inconnu",
                _ => "piège",
            };
            self.error = Some(format!("{name} (cause {c}) pc={} tval={tval}", self.pc));
            return;
        }
        self.csr[csr::EPC] = self.pc;
        self.csr[csr::CAUSE] = c;
        self.csr[csr::TVAL] = tval;
        self.csr[csr::PMODE] = self.mode;
        self.csr[csr::PIE] = self.csr[csr::IE];
        self.csr[csr::IE] = 0;
        self.mode = -1;
        self.pc = tvec;
    }

    fn host_ecall(&mut self, n: i64) -> bool {
        let a0 = self.regs[A0];
        match n {
            0 => {
                self.exit_code = a0;
                self.halted = true;
            }
            1 => {
                if let Some(c) = char::from_u32(a0.rem_euclid(T9) as u32) {
                    self.out.push(c)
                }
            }
            2 => self.out.push_str(&a0.to_string()),
            3 => {
                let s = to_trit_string(a0, 27);
                let t = s.trim_start_matches('0');
                self.out.push_str(if t.is_empty() { "0" } else { t })
            }
            _ => return false,
        }
        true
    }

    // ---------------- exécution ----------------

    /// Exécute au plus `max` instructions. Renvoie le nombre exécuté.
    pub fn run(&mut self, max: u64) -> u64 {
        let start = self.cycles;
        let end = start.saturating_add(max);
        self.waiting = false;
        while !self.halted && !self.waiting && self.cycles < end {
            if self.csr[csr::IE] != 0 {
                let tc = self.csr[csr::TIMECMP];
                if tc > 0 && self.cycles as i64 >= tc {
                    self.trap(cause::TIMER, 0);
                    continue;
                }
            }
            self.step();
        }
        self.cycles - start
    }

    #[inline(always)]
    pub fn step(&mut self) {
        let pc = self.pc;
        // mode utilisateur avec ULIMIT > 0 : espace virtuel [0, ULIMIT) décalé de UBASE
        let user = self.mode > 0 && self.csr[csr::ULIMIT] > 0;
        let (ub, ul) = if user { (self.csr[csr::UBASE], self.csr[csr::ULIMIT]) } else { (0, 0) };
        if user && (pc < 0 || pc + 3 > ul) {
            self.trap(cause::MEM, pc);
            return;
        }
        let ppc = pc + ub;
        if ppc < 0 || ppc % 3 != 0 || (ppc as usize) + 2 >= self.mem.len() {
            self.trap(cause::ALIGN, pc);
            return;
        }
        let ci = (ppc / 3) as usize;
        let mut i = self.cache[ci];
        if i.op == op::UNDECODED {
            let w = self.peek_word(ppc);
            i = decode(w);
            self.cache[ci] = i;
        }
        self.cycles += 1;
        #[cfg(feature = "prof")]
        {
            self.prof_op[i.op as usize] += 1;
            self.prof_pc[ci] += 1;
            if user { self.prof_user += 1; }
        }
        let mut next = pc + 3;
        let (rd, s1, s2) = (i.rd as usize, i.rs1 as usize, i.rs2 as usize);
        macro_rules! r {
            ($x:expr) => {
                self.regs[$x]
            };
        }
        macro_rules! set {
            ($v:expr) => {{
                let v = $v;
                self.regs[rd] = v;
            }};
        }
        macro_rules! mem {
            ($e:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(a) => {
                        self.trap(cause::MEM, a);
                        return;
                    }
                }
            };
        }
        // adresse virtuelle → physique (mode utilisateur : bornes + décalage ; MMIO interdit)
        macro_rules! va {
            ($a:expr, $n:expr) => {{
                let a = $a;
                if user {
                    if a < 0 && self.csr[csr::IOPERM] != 0 && !mmio_privileged(a) {
                        a // périphérique accordé par le noyau
                    } else if a < 0 || a + $n > ul {
                        self.trap(cause::MEM, a);
                        return;
                    } else {
                        a + ub
                    }
                } else {
                    a
                }
            }};
        }
        macro_rules! kernel {
            () => {
                if self.mode > -1 {
                    self.trap(cause::PRIV, i.op as i64);
                    return;
                }
            };
        }
        match i.op {
            op::ADD => set!(wrap27(r!(s1) + r!(s2))),
            op::SUB => set!(wrap27(r!(s1) - r!(s2))),
            op::MUL => set!(wrap27_i128(r!(s1) as i128 * r!(s2) as i128)),
            op::DIV | op::MOD => {
                let d = r!(s2);
                if d == 0 {
                    self.trap(cause::DIV0, 0);
                    return;
                }
                set!(if i.op == op::DIV { r!(s1) / d } else { r!(s1) % d })
            }
            op::NEG => set!(-r!(s1)),
            op::SXT => set!(wrap9(r!(s1))),
            op::MIN => set!(tmin(r!(s1), r!(s2))),
            op::MAX => set!(tmax(r!(s1), r!(s2))),
            op::TMUL => set!(tmul(r!(s1), r!(s2))),
            op::CONS => set!(tcons(r!(s1), r!(s2))),
            op::ANY => set!(tany(r!(s1), r!(s2))),
            op::CMP => set!((r!(s1) - r!(s2)).signum()),
            op::SHT => set!(sht(r!(s1), r!(s2))),
            op::SLT => set!((r!(s1) < r!(s2)) as i64),
            op::SEQ => set!((r!(s1) == r!(s2)) as i64),
            op::MULH => set!(mulh(r!(s1), r!(s2))),
            op::ADDI => set!(wrap27(r!(s1) + i.imm)),
            op::MULI => set!(wrap27_i128(r!(s1) as i128 * i.imm as i128)),
            op::DIVI | op::MODI => {
                if i.imm == 0 {
                    self.trap(cause::DIV0, 0);
                    return;
                }
                set!(if i.op == op::DIVI { r!(s1) / i.imm } else { r!(s1) % i.imm })
            }
            op::SHTI => set!(sht(r!(s1), i.imm)),
            op::MINI => set!(tmin(r!(s1), i.imm)),
            op::MAXI => set!(tmax(r!(s1), i.imm)),
            op::SLTI => set!((r!(s1) < i.imm) as i64),
            op::LDT => {
                let a = va!(wrap27(r!(s1) + i.imm), 1);
                let v = mem!(self.ld_t(a));
                set!(v)
            }
            op::LDW => {
                let a = va!(wrap27(r!(s1) + i.imm), 3);
                let v = mem!(self.ld_w(a));
                set!(v)
            }
            op::STT => {
                let (a, v) = (va!(wrap27(r!(s1) + i.imm), 1), r!(rd));
                mem!(self.st_t(a, v))
            }
            op::STW => {
                let (a, v) = (va!(wrap27(r!(s1) + i.imm), 3), r!(rd));
                mem!(self.st_w(a, v))
            }
            op::BEQ => {
                if r!(rd) == r!(s1) {
                    next = pc + i.imm * 3
                }
            }
            op::BNE => {
                if r!(rd) != r!(s1) {
                    next = pc + i.imm * 3
                }
            }
            op::BLT => {
                if r!(rd) < r!(s1) {
                    next = pc + i.imm * 3
                }
            }
            op::BGE => {
                if r!(rd) >= r!(s1) {
                    next = pc + i.imm * 3
                }
            }
            op::BR3 => {
                let v = r!(rd);
                if v < 0 {
                    next = pc + i.imm * 3
                } else if v > 0 {
                    next = pc + i.imm2 * 3
                }
            }
            op::JAL => {
                set!(pc + 3);
                next = pc + i.imm * 3;
            }
            op::JALR => {
                let t = wrap27(r!(s1) + i.imm);
                set!(pc + 3);
                next = t;
            }
            op::LUI => set!(wrap27_i128(i.imm as i128 * POW3[16] as i128)),
            op::ECALL => {
                if self.csr[csr::TVEC] != 0 {
                    self.trap(cause::ECALL, i.imm);
                    return;
                }
                if !self.host_ecall(i.imm) {
                    self.trap(cause::ECALL, i.imm);
                    return;
                }
            }
            op::CSRR => {
                kernel!();
                let k = i.imm as usize;
                set!(if k == csr::MODE { self.mode } else { self.csr.get(k).copied().unwrap_or(0) })
            }
            op::CSRW => {
                kernel!();
                let k = i.imm as usize;
                let v = r!(s1);
                if k == csr::MODE {
                    self.mode = v.signum();
                } else if k < csr::COUNT {
                    self.csr[k] = v;
                }
            }
            op::ERET => {
                kernel!();
                next = self.csr[csr::EPC];
                self.mode = self.csr[csr::PMODE];
                self.csr[csr::IE] = self.csr[csr::PIE];
            }
            op::HALT => {
                kernel!();
                self.halted = true;
            }
            op::WFI => {
                kernel!();
                self.waiting = true;
            }
            _ => {
                self.trap(cause::ILLEGAL, i.imm);
                return;
            }
        }
        self.regs[Z] = 0;
        self.pc = next;
    }

    /// Dimensions du mode vidéo courant.
    pub fn fb_dims(&self) -> (usize, usize) {
        if self.vmode >= 1 { (TRIT_W, TRIT_H) } else { (FB_W, FB_H) }
    }

    /// Fixe la souris (pixels du mode courant, bornés ; btn = gauche + 3·droit).
    pub fn set_mouse(&mut self, x: i64, y: i64, btn: i64) {
        let (w, h) = self.fb_dims();
        self.mouse_x = x.clamp(0, w as i64 - 1);
        self.mouse_y = y.clamp(0, h as i64 - 1);
        self.mouse_btn = btn;
    }

    /// Framebuffer → RGBA (largeur×hauteur du mode courant ×4).
    /// Mode 1 (TRIT) : trit −1 noir, 0 gris (170,170,170), +1 blanc.
    pub fn render_rgba(&self, buf: &mut [u8]) {
        let base = self.fb_addr;
        let (w, h) = self.fb_dims();
        let inmem = |a: i64| base > 0 && a >= 0 && (a as usize) < self.mem.len();
        if self.vmode == 1 {
            let per = w / 9;
            for y in 0..h {
                for tx in 0..per {
                    let a = base + (y * per + tx) as i64;
                    let mut t = if inmem(a) { self.mem[a as usize] as i64 } else { 0 };
                    for k in 0..9 {
                        let b = bal_mod(t, 3);
                        t = (t - b) / 3;
                        let v: u8 = match b { -1 => 0, 0 => 170, _ => 255 };
                        let o = (y * w + tx * 9 + k) * 4;
                        buf[o] = v;
                        buf[o + 1] = v;
                        buf[o + 2] = v;
                        buf[o + 3] = 255;
                    }
                }
            }
            return;
        }
        let lut = |c: i64| ((c + 13) * 255 / 26) as u8;
        for p in 0..w * h {
            let a = base + p as i64;
            let t = if inmem(a) { self.mem[a as usize] as i64 } else { 0 };
            let b = bal_mod(t, 27);
            let r1 = (t - b) / 27;
            let g = bal_mod(r1, 27);
            let r = (r1 - g) / 27;
            let o = p * 4;
            buf[o] = lut(r);
            buf[o + 1] = lut(g);
            buf[o + 2] = lut(b);
            buf[o + 3] = 255;
        }
    }
}
