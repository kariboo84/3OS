//! Assembleur TRI-27 (.tas), deux passes.

use crate::isa::{self, encode, info_by_name, op, Fmt};
use crate::trit::{bal_mod, from_trit_string, wrap9, POW3};
use std::collections::HashMap;

pub struct Image {
    pub trytes: Vec<i16>,
    pub entry: i64,
    pub symbols: HashMap<String, i64>,
    /// adresse → ligne source (pour le débogage)
    pub lines: Vec<(i64, usize)>,
}

fn csr_by_name(s: &str) -> Option<i64> {
    Some(match s.to_ascii_lowercase().as_str() {
        "mode" => 0,
        "tvec" => 1,
        "epc" => 2,
        "cause" => 3,
        "tval" => 4,
        "scratch" => 5,
        "timecmp" => 6,
        "ie" => 7,
        "pmode" => 8,
        "pie" => 9,
        _ => return None,
    })
}

fn strip_comment(line: &str) -> &str {
    let mut in_s = false;
    let mut in_c = false;
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'\\' && (in_s || in_c) {
            i += 2;
            continue;
        }
        if c == b'"' && !in_c {
            in_s = !in_s
        } else if c == b'\'' && !in_s {
            in_c = !in_c
        } else if (c == b';' || c == b'#') && !in_s && !in_c {
            return &line[..i];
        }
        i += 1;
    }
    line
}

fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let (mut in_s, mut in_c, mut esc) = (false, false, false);
    for ch in s.chars() {
        if esc {
            cur.push(ch);
            esc = false;
            continue;
        }
        match ch {
            '\\' if in_s || in_c => {
                cur.push(ch);
                esc = true
            }
            '"' if !in_c => {
                in_s = !in_s;
                cur.push(ch)
            }
            '\'' if !in_s => {
                in_c = !in_c;
                cur.push(ch)
            }
            ',' if !in_s && !in_c => {
                out.push(cur.trim().to_string());
                cur.clear()
            }
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string())
    }
    out
}

fn unescape(s: &str) -> Result<Vec<i64>, String> {
    let mut out = vec![];
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            let e = it.next().ok_or("échappement incomplet")?;
            out.push(match e {
                'n' => 10,
                't' => 9,
                'r' => 13,
                '0' => 0,
                'e' => 27,
                '\\' => 92,
                '"' => 34,
                '\'' => 39,
                _ => return Err(format!("échappement inconnu \\{e}")),
            });
        } else {
            out.push(c as i64);
        }
    }
    Ok(out)
}

struct Ctx<'a> {
    syms: &'a HashMap<String, i64>,
    final_pass: bool,
}

impl Ctx<'_> {
    /// Expression : termes séparés par + et -. Termes : nombre, 0x.., 0t+-0, 'c', symbole.
    fn eval(&self, e: &str) -> Result<i64, String> {
        let e = e.trim();
        if e.is_empty() {
            return Err("expression vide".into());
        }
        let mut total: i64 = 0;
        let mut sign = 1;
        let mut term = String::new();
        let mut first = true;
        let chars: Vec<char> = e.chars().collect();
        let mut i = 0;
        let mut in_c = false;
        let flush = |term: &mut String, sign: i64, total: &mut i64| -> Result<(), String> {
            let t = term.trim();
            if t.is_empty() {
                return Ok(());
            }
            *total += sign * self.term(t)?;
            term.clear();
            Ok(())
        };
        while i < chars.len() {
            let c = chars[i];
            if c == '\'' {
                in_c = !in_c;
                term.push(c);
            } else if in_c {
                term.push(c);
                if c == '\\' && i + 1 < chars.len() {
                    i += 1;
                    term.push(chars[i]);
                }
            } else if (c == '+' || c == '-') && !(term.trim() == "0t" || term.trim().starts_with("0t")) {
                if term.trim().is_empty() {
                    if c == '-' {
                        sign = -sign
                    }
                } else {
                    flush(&mut term, sign, &mut total)?;
                    sign = if c == '-' { -1 } else { 1 };
                }
            } else if c == ' ' && term.trim().starts_with("0t") {
                // espace termine un littéral ternaire
                flush(&mut term, sign, &mut total)?;
                sign = 1;
            } else {
                term.push(c);
            }
            first = false;
            i += 1;
        }
        let _ = first;
        flush(&mut term, sign, &mut total)?;
        Ok(total)
    }

    fn term(&self, t: &str) -> Result<i64, String> {
        if let Some(h) = t.strip_prefix("0x") {
            return i64::from_str_radix(h, 16).map_err(|_| format!("hex invalide: {t}"));
        }
        if let Some(tr) = t.strip_prefix("0t") {
            return from_trit_string(tr).ok_or(format!("trits invalides: {t}"));
        }
        if t.starts_with('\'') && t.ends_with('\'') && t.len() >= 3 {
            let v = unescape(&t[1..t.len() - 1])?;
            return v.first().copied().ok_or("caractère vide".into());
        }
        if t.chars().next().unwrap().is_ascii_digit() {
            return t.parse::<i64>().map_err(|_| format!("nombre invalide: {t}"));
        }
        match self.syms.get(t) {
            Some(v) => Ok(*v),
            None if !self.final_pass => Ok(0),
            None => Err(format!("symbole inconnu: {t}")),
        }
    }

    fn known(&self, e: &str) -> bool {
        // vrai si l'expression ne dépend d'aucun symbole non défini
        e.split(|c: char| c == '+' || c == '-' || c.is_whitespace())
            .filter(|t| !t.is_empty())
            .all(|t| {
                let c = t.chars().next().unwrap();
                c.is_ascii_digit() || c == '\'' || self.syms.contains_key(t)
            })
    }
}

fn reg(s: &str) -> Result<i64, String> {
    isa::reg_by_name(s.trim()).ok_or(format!("registre inconnu: {s}"))
}

/// "imm(reg)" / "(reg)" / "imm"
fn mem_operand(cx: &Ctx, s: &str) -> Result<(i64, i64), String> {
    let s = s.trim();
    if let Some(p) = s.rfind('(') {
        if s.ends_with(')') {
            let base = reg(&s[p + 1..s.len() - 1])?;
            let off = if s[..p].trim().is_empty() { 0 } else { cx.eval(&s[..p])? };
            return Ok((off, base));
        }
    }
    Ok((cx.eval(s)?, 0))
}

enum Item {
    Inst(u8, i64, i64, i64, i64, i64),
}

fn split_li(v: i64) -> (i64, i64) {
    let lo = bal_mod(v, POW3[16]);
    ((v - lo) / POW3[16], lo)
}

/// Assemble une instruction (ou pseudo) à `pc`. Renvoie la liste d'instructions.
fn assemble_inst(cx: &Ctx, mn: &str, args: &[String], pc: i64, li_long: Option<bool>) -> Result<Vec<Item>, String> {
    let a = |k: usize| -> Result<&str, String> { args.get(k).map(|s| s.as_str()).ok_or(format!("{mn}: argument {} manquant", k + 1)) };
    let off = |lbl: &str, at: i64| -> Result<i64, String> {
        let t = cx.eval(lbl)?;
        if cx.final_pass && t % 3 != 0 {
            return Err(format!("cible non alignée: {lbl}={t}"));
        }
        Ok((t - at) / 3)
    };
    let one = |o: u8, rd, rs1, rs2, imm, imm2| Ok(vec![Item::Inst(o, rd, rs1, rs2, imm, imm2)]);
    // pseudo-instructions
    match mn {
        "nop" => return one(op::ADDI, 0, 0, 0, 0, 0),
        "mv" => return one(op::ADDI, reg(a(0)?)?, reg(a(1)?)?, 0, 0, 0),
        "not" => return one(op::NEG, reg(a(0)?)?, reg(a(1)?)?, 0, 0, 0),
        "j" => return one(op::JAL, 0, 0, 0, off(a(0)?, pc)?, 0),
        "call" => return one(op::JAL, -2, 0, 0, off(a(0)?, pc)?, 0),
        "ret" => return one(op::JALR, 0, -2, 0, 0, 0),
        "jr" => return one(op::JALR, 0, reg(a(0)?)?, 0, 0, 0),
        "beqz" => return one(op::BEQ, reg(a(0)?)?, 0, 0, off(a(1)?, pc)?, 0),
        "bnez" => return one(op::BNE, reg(a(0)?)?, 0, 0, off(a(1)?, pc)?, 0),
        "bltz" => return one(op::BLT, reg(a(0)?)?, 0, 0, off(a(1)?, pc)?, 0),
        "bgez" => return one(op::BGE, reg(a(0)?)?, 0, 0, off(a(1)?, pc)?, 0),
        "bgtz" => return one(op::BLT, 0, reg(a(0)?)?, 0, off(a(1)?, pc)?, 0),
        "blez" => return one(op::BGE, 0, reg(a(0)?)?, 0, off(a(1)?, pc)?, 0),
        "bgt" => return one(op::BLT, reg(a(1)?)?, reg(a(0)?)?, 0, off(a(2)?, pc)?, 0),
        "ble" => return one(op::BGE, reg(a(1)?)?, reg(a(0)?)?, 0, off(a(2)?, pc)?, 0),
        "push" => {
            let r = reg(a(0)?)?;
            return Ok(vec![Item::Inst(op::ADDI, -1, -1, 0, -3, 0), Item::Inst(op::STW, r, -1, 0, 0, 0)]);
        }
        "pop" => {
            let r = reg(a(0)?)?;
            return Ok(vec![Item::Inst(op::LDW, r, -1, 0, 0, 0), Item::Inst(op::ADDI, -1, -1, 0, 3, 0)]);
        }
        "li" | "la" => {
            let rd = reg(a(0)?)?;
            let v = cx.eval(a(1)?)?;
            let long = li_long.unwrap_or(true);
            if !long {
                return one(op::ADDI, rd, 0, 0, v, 0);
            }
            let (hi, lo) = split_li(v);
            return Ok(vec![Item::Inst(op::LUI, rd, 0, 0, hi, 0), Item::Inst(op::ADDI, rd, rd, 0, lo, 0)]);
        }
        _ => {}
    }
    let info = info_by_name(mn).ok_or(format!("instruction inconnue: {mn}"))?;
    let c = info.code;
    match info.fmt {
        Fmt::R => one(c, reg(a(0)?)?, reg(a(1)?)?, reg(a(2)?)?, 0, 0),
        Fmt::R2 => one(c, reg(a(0)?)?, reg(a(1)?)?, 0, 0, 0),
        Fmt::N => one(c, 0, 0, 0, 0, 0),
        Fmt::I => one(c, reg(a(0)?)?, reg(a(1)?)?, 0, cx.eval(a(2)?)?, 0),
        Fmt::Mem => {
            let (o, b) = mem_operand(cx, a(1)?)?;
            one(c, reg(a(0)?)?, b, 0, o, 0)
        }
        Fmt::Br => one(c, reg(a(0)?)?, reg(a(1)?)?, 0, off(a(2)?, pc)?, 0),
        Fmt::Ecall => one(c, 0, 0, 0, if args.is_empty() { 0 } else { cx.eval(a(0)?)? }, 0),
        Fmt::CsrR => one(c, reg(a(0)?)?, 0, 0, csr_by_name(a(1)?).map(Ok).unwrap_or_else(|| cx.eval(a(1)?))?, 0),
        Fmt::CsrW => one(c, 0, reg(a(0)?)?, 0, csr_by_name(a(1)?).map(Ok).unwrap_or_else(|| cx.eval(a(1)?))?, 0),
        Fmt::Lui => one(c, reg(a(0)?)?, 0, 0, cx.eval(a(1)?)?, 0),
        Fmt::Jal => {
            if args.len() == 1 {
                one(c, -2, 0, 0, off(a(0)?, pc)?, 0)
            } else {
                one(c, reg(a(0)?)?, 0, 0, off(a(1)?, pc)?, 0)
            }
        }
        Fmt::B3 => {
            let o = |s: &str| -> Result<i64, String> { if s == "_" || s == "." { Ok(1) } else { off(s, pc) } };
            one(c, reg(a(0)?)?, 0, 0, o(a(1)?)?, o(a(2)?)?)
        }
    }
}

pub fn assemble(src: &str) -> Result<Image, String> {
    let mut syms: HashMap<String, i64> = HashMap::new();
    let mut li_sizes: HashMap<usize, bool> = HashMap::new();
    let mut result = None;
    for pass in 0..3 {
        let final_pass = pass == 2;
        let mut mem: Vec<i16> = vec![];
        let mut lines = vec![];
        let mut pc: i64 = 0;
        let mut new_syms = syms.clone();
        let put = |mem: &mut Vec<i16>, at: i64, v: i64| -> Result<(), String> {
            if at < 0 {
                return Err(format!("adresse négative: {at}"));
            }
            let u = at as usize;
            if mem.len() <= u {
                mem.resize(u + 1, 0);
            }
            mem[u] = wrap9(v) as i16;
            Ok(())
        };
        for (ln, raw) in src.lines().enumerate() {
            let err = |e: String| format!("ligne {}: {e}\n  {}", ln + 1, raw.trim());
            let mut line = strip_comment(raw).trim().to_string();
            // étiquettes
            loop {
                let Some(p) = line.find(':') else { break };
                let lbl = line[..p].trim();
                if lbl.is_empty() || !lbl.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') {
                    break;
                }
                if pass == 0 && new_syms.contains_key(lbl) {
                    return Err(err(format!("étiquette en double: {lbl}")));
                }
                new_syms.insert(lbl.to_string(), pc);
                line = line[p + 1..].trim().to_string();
            }
            if line.is_empty() {
                continue;
            }
            let (mn, rest) = match line.find(char::is_whitespace) {
                Some(p) => (line[..p].to_ascii_lowercase(), line[p..].trim().to_string()),
                None => (line.to_ascii_lowercase(), String::new()),
            };
            let args = split_args(&rest);
            // new_syms = symboles de la passe précédente + ceux déjà (re)définis dans cette passe :
            // une chaîne de .equ (B = A+1, C = B+1, …) se résout en une passe.
            let cx = Ctx { syms: &new_syms, final_pass };
            if let Some(d) = mn.strip_prefix('.') {
                match d {
                    "org" => pc = cx.eval(&rest).map_err(err)?,
                    "equ" | "set" => {
                        let v = cx.eval(args.get(1).ok_or_else(|| err("valeur manquante".into()))?).map_err(err)?;
                        new_syms.insert(args[0].clone(), v);
                    }
                    "align" => {
                        let n = cx.eval(&rest).map_err(err)?.max(1);
                        while pc % n != 0 {
                            pc += 1
                        }
                    }
                    "space" | "zero" => pc += cx.eval(&rest).map_err(err)?,
                    "tryte" | "byte" => {
                        for x in &args {
                            put(&mut mem, pc, cx.eval(x).map_err(err)?).map_err(err)?;
                            pc += 1;
                        }
                    }
                    "word" | "wordu" | "trits" => {
                        // .wordu preserves the current address for packed C data.
                        if d != "wordu" {
                            while pc % 3 != 0 {
                                pc += 1
                            }
                        }
                        for x in &args {
                            let v = if d == "trits" {
                                from_trit_string(x).ok_or_else(|| err(format!("trits invalides: {x}")))?
                            } else {
                                cx.eval(x).map_err(err)?
                            };
                            let t0 = bal_mod(v, 19683);
                            let r = (v - t0) / 19683;
                            let t1 = bal_mod(r, 19683);
                            let t2 = bal_mod((r - t1) / 19683, 19683);
                            for (k, t) in [t0, t1, t2].into_iter().enumerate() {
                                put(&mut mem, pc + k as i64, t).map_err(err)?;
                            }
                            pc += 3;
                        }
                    }
                    "str" | "string" | "asciz" => {
                        let s = rest.trim();
                        if !(s.starts_with('"') && s.ends_with('"') && s.len() >= 2) {
                            return Err(err("chaîne attendue".into()));
                        }
                        for c in unescape(&s[1..s.len() - 1]).map_err(err)? {
                            if c > 9841 {
                                return Err(err(format!("caractère U+{c:04X} hors d'un tryte (max 9841)")));
                            }
                            put(&mut mem, pc, c).map_err(err)?;
                            pc += 1;
                        }
                        put(&mut mem, pc, 0).map_err(err)?;
                        pc += 1;
                    }
                    _ => return Err(err(format!("directive inconnue: .{d}"))),
                }
                continue;
            }
            while pc % 3 != 0 {
                pc += 1
            }
            // taille de li/la : fixée à la passe 0
            let li_long = if mn == "li" || mn == "la" {
                if pass == 0 {
                    let e = args.get(1).cloned().unwrap_or_default();
                    let long = mn == "la"
                        || !cx.known(&e)
                        || cx.eval(&e).map(|v| v.abs() > (POW3[16] - 1) / 2).unwrap_or(true);
                    li_sizes.insert(ln, long);
                }
                Some(li_sizes[&ln])
            } else {
                None
            };
            let items = assemble_inst(&cx, &mn, &args, pc, li_long).map_err(err)?;
            for Item::Inst(c, rd, rs1, rs2, imm, imm2) in items {
                let w = if final_pass { encode(c, rd, rs1, rs2, imm, imm2).map_err(err)? } else { 0 };
                let t0 = bal_mod(w, 19683);
                let r = (w - t0) / 19683;
                let t1 = bal_mod(r, 19683);
                let t2 = (r - t1) / 19683;
                put(&mut mem, pc, t0).map_err(err)?;
                put(&mut mem, pc + 1, t1).map_err(err)?;
                put(&mut mem, pc + 2, t2).map_err(err)?;
                lines.push((pc, ln + 1));
                pc += 3;
            }
        }
        syms = new_syms;
        if final_pass {
            while mem.len() % 3 != 0 {
                mem.push(0)
            }
            let entry = syms.get("start").copied().unwrap_or(0);
            result = Some(Image { trytes: mem, entry, symbols: syms.clone(), lines });
        }
    }
    Ok(result.unwrap())
}
