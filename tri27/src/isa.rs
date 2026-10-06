//! Formats, opcodes, encodage/décodage TRI-27.

use crate::trit::{bal_mod, POW3};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fmt {
    R,  // op rd rs1 rs2
    R2, // op rd rs1
    N,  // pas d'opérande (format R)
    I,  // op rd rs1 imm16
    Mem, // op rd imm(rs1)
    Br, // op rd rs1 off16 (étiquette)
    Ecall, // op imm16
    CsrR, // op rd csr
    CsrW, // op rs1 csr
    Lui, // op rd imm19
    Jal, // op rd off19 (étiquette)
    B3, // op rs offn offp
}

pub mod op {
    pub const ILLEGAL: u8 = 0;
    pub const ADD: u8 = 1;
    pub const SUB: u8 = 2;
    pub const MUL: u8 = 3;
    pub const DIV: u8 = 4;
    pub const MOD: u8 = 5;
    pub const NEG: u8 = 6;
    pub const MIN: u8 = 7;
    pub const MAX: u8 = 8;
    pub const TMUL: u8 = 9;
    pub const CONS: u8 = 10;
    pub const ANY: u8 = 11;
    pub const CMP: u8 = 12;
    pub const SHT: u8 = 13;
    pub const SLT: u8 = 14;
    pub const SEQ: u8 = 15;
    pub const MULH: u8 = 16;
    /// Extension de signe d'une tryte : rd = valeur sur 9 trits de rs1 (cast char).
    pub const SXT: u8 = 17;
    /// Somme des 27 trits de rs1 (−27..27) : le « popcount » ternaire.
    pub const TSUM: u8 = 18;
    /// Produit scalaire ternaire : Σ a_i·b_i sur les 27 trits (= TSUM(TMUL a b)).
    pub const TDOT: u8 = 19;
    pub const ADDI: u8 = 20;
    pub const MULI: u8 = 21;
    pub const SHTI: u8 = 22;
    pub const LDT: u8 = 23;
    pub const LDW: u8 = 24;
    pub const STT: u8 = 25;
    pub const STW: u8 = 26;
    pub const BEQ: u8 = 27;
    pub const BNE: u8 = 28;
    pub const BLT: u8 = 29;
    pub const BGE: u8 = 30;
    pub const JALR: u8 = 31;
    pub const ECALL: u8 = 32;
    pub const CSRR: u8 = 33;
    pub const CSRW: u8 = 34;
    pub const MINI: u8 = 35;
    pub const MAXI: u8 = 36;
    pub const SLTI: u8 = 37;
    /// Division / reste par une constante (troncature vers zéro, comme DIV/MOD).
    pub const DIVI: u8 = 38;
    pub const MODI: u8 = 39;
    pub const LUI: u8 = 40;
    pub const JAL: u8 = 41;
    pub const BR3: u8 = 45;
    pub const HALT: u8 = 50;
    pub const ERET: u8 = 51;
    /// Attente d'événement : le CPU dort jusqu'au prochain tick hôte (privilégiée).
    pub const WFI: u8 = 52;
    pub const UNDECODED: u8 = 255;
}

pub struct OpInfo {
    pub name: &'static str,
    pub code: u8,
    pub fmt: Fmt,
}

macro_rules! ops {
    ($($n:literal $c:ident $f:ident),* $(,)?) => {
        pub const OPS: &[OpInfo] = &[$(OpInfo { name: $n, code: op::$c, fmt: Fmt::$f }),*];
    };
}

ops! {
    "add" ADD R, "sub" SUB R, "mul" MUL R, "div" DIV R, "mod" MOD R,
    "neg" NEG R2, "min" MIN R, "max" MAX R, "tmul" TMUL R, "cons" CONS R, "any" ANY R,
    "cmp" CMP R, "sht" SHT R, "slt" SLT R, "seq" SEQ R, "mulh" MULH R, "sxt" SXT R2, "tsum" TSUM R2, "tdot" TDOT R,
    "addi" ADDI I, "muli" MULI I, "shti" SHTI I,
    "ldt" LDT Mem, "ldw" LDW Mem, "stt" STT Mem, "stw" STW Mem,
    "beq" BEQ Br, "bne" BNE Br, "blt" BLT Br, "bge" BGE Br,
    "jalr" JALR I, "ecall" ECALL Ecall, "csrr" CSRR CsrR, "csrw" CSRW CsrW,
    "mini" MINI I, "maxi" MAXI I, "slti" SLTI I, "divi" DIVI I, "modi" MODI I,
    "lui" LUI Lui, "jal" JAL Jal, "br3" BR3 B3,
    "halt" HALT N, "eret" ERET N, "wfi" WFI N,
}

pub fn info_by_name(name: &str) -> Option<&'static OpInfo> {
    OPS.iter().find(|o| o.name == name)
}
pub fn info_by_code(code: u8) -> Option<&'static OpInfo> {
    OPS.iter().find(|o| o.code == code)
}

/// Format physique (disposition des trits) d'un format logique.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phys {
    R,
    I,
    J,
    B3,
}
pub fn phys(f: Fmt) -> Phys {
    match f {
        Fmt::R | Fmt::R2 | Fmt::N => Phys::R,
        Fmt::I | Fmt::Mem | Fmt::Br | Fmt::Ecall | Fmt::CsrR | Fmt::CsrW => Phys::I,
        Fmt::Lui | Fmt::Jal => Phys::J,
        Fmt::B3 => Phys::B3,
    }
}

/// Instruction décodée. Registres stockés en indice tableau (−13..13 → 0..26).
#[derive(Clone, Copy, Debug)]
pub struct Inst {
    pub op: u8,
    pub rd: u8,
    pub rs1: u8,
    pub rs2: u8,
    pub imm: i64,
    pub imm2: i64,
}

impl Inst {
    pub const UNDECODED: Inst = Inst { op: op::UNDECODED, rd: 13, rs1: 13, rs2: 13, imm: 0, imm2: 0 };
}

#[inline]
fn reg(v: i64) -> u8 {
    (v + 13) as u8
}

pub fn decode(w: i64) -> Inst {
    let mut v = w;
    let mut take = |k: usize| {
        let m = POW3[k];
        let d = bal_mod(v, m);
        v = (v - d) / m;
        d
    };
    let opv = take(5);
    let code = if (1..=120).contains(&opv) { opv as u8 } else { op::ILLEGAL };
    let Some(info) = info_by_code(code) else {
        return Inst { op: op::ILLEGAL, rd: 13, rs1: 13, rs2: 13, imm: opv, imm2: 0 };
    };
    let mut i = Inst { op: code, rd: 13, rs1: 13, rs2: 13, imm: 0, imm2: 0 };
    match phys(info.fmt) {
        Phys::R => {
            i.rd = reg(take(3));
            i.rs1 = reg(take(3));
            i.rs2 = reg(take(3));
        }
        Phys::I => {
            i.rd = reg(take(3));
            i.rs1 = reg(take(3));
            i.imm = take(16);
        }
        Phys::J => {
            i.rd = reg(take(3));
            i.imm = take(19);
        }
        Phys::B3 => {
            i.rd = reg(take(3));
            i.imm = take(9);
            i.imm2 = take(9);
        }
    }
    i
}

/// Encode. Registres en valeur signée (−13..13). Renvoie Err si un champ déborde.
pub fn encode(code: u8, rd: i64, rs1: i64, rs2: i64, imm: i64, imm2: i64) -> Result<i64, String> {
    let info = info_by_code(code).ok_or("opcode inconnu")?;
    let fits = |v: i64, k: usize| v.abs() <= (POW3[k] - 1) / 2;
    for r in [rd, rs1, rs2] {
        if !fits(r, 3) {
            return Err(format!("registre hors plage: {r}"));
        }
    }
    let c = code as i64;
    Ok(match phys(info.fmt) {
        Phys::R => c + rd * POW3[5] + rs1 * POW3[8] + rs2 * POW3[11],
        Phys::I => {
            if !fits(imm, 16) {
                return Err(format!("immédiat 16 trits hors plage: {imm}"));
            }
            c + rd * POW3[5] + rs1 * POW3[8] + imm * POW3[11]
        }
        Phys::J => {
            if !fits(imm, 19) {
                return Err(format!("immédiat 19 trits hors plage: {imm}"));
            }
            c + rd * POW3[5] + imm * POW3[8]
        }
        Phys::B3 => {
            if !fits(imm, 9) || !fits(imm2, 9) {
                return Err(format!("décalage BR3 hors plage (±9841): {imm}/{imm2}"));
            }
            c + rd * POW3[5] + imm * POW3[8] + imm2 * POW3[17]
        }
    })
}

pub const REG_NAMES: [&str; 27] = [
    "s10", "s9", "s8", "s7", "s6", "s5", "s4", "s3", "s2", "s1", "fp", "ra", "sp", // -13..-1
    "zero", // 0
    "a0", "a1", "a2", "a3", "a4", "a5", "t0", "t1", "t2", "t3", "t4", "t5", "t6", // 1..13
];

/// Nom → valeur signée −13..13.
pub fn reg_by_name(s: &str) -> Option<i64> {
    let s = s.to_ascii_lowercase();
    if let Some(i) = REG_NAMES.iter().position(|n| *n == s) {
        return Some(i as i64 - 13);
    }
    match s.as_str() {
        "s0" => return Some(-3),
        "x0" | "r0" => return Some(0),
        _ => {}
    }
    let (sign, rest) = if let Some(r) = s.strip_prefix('p') {
        (1, r)
    } else if let Some(r) = s.strip_prefix('n') {
        (-1, r)
    } else {
        return None;
    };
    let k: i64 = rest.parse().ok()?;
    if (1..=13).contains(&k) {
        Some(sign * k)
    } else {
        None
    }
}

pub fn disasm(w: i64, pc: i64) -> String {
    let i = decode(w);
    let Some(info) = info_by_code(i.op) else { return format!(".word {w}") };
    let r = |x: u8| REG_NAMES[x as usize];
    let tgt = |off: i64| pc + off * 3;
    match info.fmt {
        Fmt::R => format!("{} {}, {}, {}", info.name, r(i.rd), r(i.rs1), r(i.rs2)),
        Fmt::R2 => format!("{} {}, {}", info.name, r(i.rd), r(i.rs1)),
        Fmt::N => info.name.to_string(),
        Fmt::I => format!("{} {}, {}, {}", info.name, r(i.rd), r(i.rs1), i.imm),
        Fmt::Mem => format!("{} {}, {}({})", info.name, r(i.rd), i.imm, r(i.rs1)),
        Fmt::Br => format!("{} {}, {}, @{}", info.name, r(i.rd), r(i.rs1), tgt(i.imm)),
        Fmt::Ecall => format!("ecall {}", i.imm),
        Fmt::CsrR => format!("csrr {}, {}", r(i.rd), i.imm),
        Fmt::CsrW => format!("csrw {}, {}", r(i.rs1), i.imm),
        Fmt::Lui => format!("lui {}, {}", r(i.rd), i.imm),
        Fmt::Jal => format!("jal {}, @{}", r(i.rd), tgt(i.imm)),
        Fmt::B3 => format!("br3 {}, @{}, @{}", r(i.rd), tgt(i.imm), tgt(i.imm2)),
    }
}
