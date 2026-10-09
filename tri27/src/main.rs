use std::io::Write;
use std::time::Instant;
use tri27::{asm, isa, trit, vm::*};

const RAM: usize = 14_348_907; // 3^15 trytes

fn usage() -> ! {
    eprintln!(
        "tri27 — VM ternaire équilibrée\n\
         usage:\n  tri27 run <prog.tas> [--max N] [--ppm DIR] [--stats] [--trace FICHIER]\n  \
         tri27 asm <prog.tas>          listing désassemblé\n  \
         tri27 bench                   mesure instructions/s"
    );
    std::process::exit(2)
}

fn load(path: &str) -> asm::Image {
    let src = std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(1)
    });
    asm::assemble(&src).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(1)
    })
}

fn save_ppm(vm: &Vm, path: &std::path::Path) {
    // capture fiable : photographier le framebuffer tel qu'il était au moment du présent
    let (fb_w, fb_h, rgba) = if vm.present_rgba.is_empty() {
        let (w, h) = vm.fb_dims();
        let mut b = vec![0u8; w * h * 4];
        vm.render_rgba(&mut b);
        (w, h, b)
    } else {
        (vm.present_w, vm.present_h, vm.present_rgba.clone())
    };
    let mut f = std::fs::File::create(path).unwrap();
    write!(f, "P6\n{fb_w} {fb_h}\n255\n").unwrap();
    let rgb: Vec<u8> = rgba.chunks(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    f.write_all(&rgb).unwrap();
}

fn save_wav(path: &str, s: &[f32]) {
    let mut f = std::fs::File::create(path).unwrap();
    let n = s.len() as u32;
    let rate = tri27::sound::SR as u32;
    let mut h = Vec::new();
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + n * 2).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&rate.to_le_bytes());
    h.extend_from_slice(&(rate * 2).to_le_bytes());
    h.extend_from_slice(&2u16.to_le_bytes());
    h.extend_from_slice(&16u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&(n * 2).to_le_bytes());
    for x in s {
        h.extend_from_slice(&((x.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    f.write_all(&h).unwrap();
}

fn load_disk(path: &str) -> Vec<i16> {
    let b = std::fs::read(path).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(1)
    });
    b.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect()
}

fn save_disk(path: &str, d: &[i16]) {
    let b: Vec<u8> = d.iter().flat_map(|t| t.to_le_bytes()).collect();
    std::fs::write(path, b).unwrap();
}

/// Disque 3FS (SPEC §9) : secteur 0 = répertoire, fichiers contigus à partir du secteur 1.
/// Entrée (30 trytes) : nom 16, secteur 3, longueur 3, entrée 3 (−1 = donnée), capacité 3.
fn mkdisk(out: &str, items: &[String]) {
    const MAGIC: i64 = 27027;
    const ENT: usize = 30;
    let mut disk: Vec<i16> = vec![0; SECTOR];
    let put_word = |d: &mut Vec<i16>, a: usize, v: i64| {
        let t0 = trit::bal_mod(v, trit::T9);
        let r = (v - t0) / trit::T9;
        let t1 = trit::bal_mod(r, trit::T9);
        let t2 = (r - t1) / trit::T9;
        d[a] = t0 as i16;
        d[a + 1] = t1 as i16;
        d[a + 2] = t2 as i16;
    };
    put_word(&mut disk, 0, MAGIC);
    put_word(&mut disk, 3, items.len() as i64);
    for (n, it) in items.iter().enumerate() {
        let (name, spec) = it.split_once('=').unwrap_or_else(|| {
            eprintln!("mkdisk : attendu nom=fichier[:capacité], reçu {it}");
            std::process::exit(2)
        });
        // capacité réservée (trytes) pour les fichiers réinscriptibles : nom=fichier:2187
        let (path, cap_req) = match spec.rsplit_once(':') {
            Some((p, c)) if c.chars().all(|x| x.is_ascii_digit()) && !c.is_empty() => (p, c.parse::<usize>().unwrap()),
            _ => (spec, 0),
        };
        let (data, entry): (Vec<i16>, i64) = if path.ends_with(".tas") {
            let img = load(path);
            (img.trytes, img.entry)
        } else {
            let b = std::fs::read(path).unwrap();
            let txt = String::from_utf8_lossy(&b);
            (txt.chars().map(|c| (c as i64).min(trit::H9) as i16).collect(), -1)
        };
        let start = disk.len() / SECTOR;
        let base = 6 + n * ENT;
        if base + ENT > SECTOR || name.chars().count() > 15 {
            eprintln!("mkdisk : trop de fichiers ou nom trop long ({name})");
            std::process::exit(2);
        }
        for (k, c) in name.chars().enumerate() {
            disk[base + k] = c as i16;
        }
        put_word(&mut disk, base + 16, start as i64);
        put_word(&mut disk, base + 19, data.len() as i64);
        put_word(&mut disk, base + 22, entry);
        let cap = (data.len().max(cap_req).max(1) + SECTOR - 1) / SECTOR * SECTOR;
        put_word(&mut disk, base + 25, cap as i64);
        disk.extend_from_slice(&data);
        disk.resize(start * SECTOR + cap, 0);
        let pad = (SECTOR - disk.len() % SECTOR) % SECTOR;
        disk.extend(std::iter::repeat(0).take(pad));
        eprintln!("  {name:<15} secteur {start:>5}  {:>7} trytes  entrée {entry}", data.len());
    }
    save_disk(out, &disk);
    eprintln!("{out} : {} secteurs", disk.len() / SECTOR);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        usage()
    }
    match args[1].as_str() {
        "run" => {
            let path = args.get(2).unwrap_or_else(|| usage());
            let mut max = u64::MAX;
            let mut ppm: Option<String> = None;
            let mut mouse: Option<(i64, i64, i64)> = None;
            let mut stats = false;
            let mut input = String::new();
            let mut wav: Option<String> = None;
            let mut disk: Option<String> = None;
            let mut realtime = false;
            let mut trace: Option<String> = None;
            let mut audio: Vec<f32> = Vec::new();
            let mut i = 3;
            while i < args.len() {
                match args[i].as_str() {
                    "--max" => {
                        max = args[i + 1].parse().unwrap();
                        i += 1
                    }
                    "--ppm" => {
                        ppm = Some(args[i + 1].clone());
                        i += 1
                    }
                    "--stats" => stats = true,
                    "--mouse" => {
                        let v: Vec<i64> = args[i + 1].split(',').map(|x| x.trim().parse().unwrap()).collect();
                        mouse = Some((v[0], v[1], *v.get(2).unwrap_or(&0)));
                        i += 1;
                    }
                    "--realtime" => realtime = true,
                    "--trace" => {
                        trace = Some(args[i + 1].clone());
                        i += 1
                    }
                    "--disk" => {
                        disk = Some(args[i + 1].clone());
                        i += 1
                    }
                    "--wav" => {
                        wav = Some(args[i + 1].clone());
                        i += 1
                    }
                    "--input" => {
                        input = args[i + 1].replace("\\n", "\n");
                        i += 1
                    }
                    _ => usage(),
                }
                i += 1;
            }
            let img = load(path);
            let mut vm = Vm::new(RAM);
            vm.load(0, &img.trytes);
            vm.reset_cpu(img.entry);
            if let Some(d) = &disk {
                vm.disk = load_disk(d);
            }
            vm.input.extend(input.chars().map(|c| c as i64));
            vm.capture_present = ppm.is_some();
            let mut trace_out = trace.as_ref().map(|p| {
                vm.trace = Some(String::new());
                std::io::BufWriter::new(std::fs::File::create(p).unwrap_or_else(|e| panic!("--trace {p}: {e}")))
            });
            let chunk: u64 = if trace_out.is_some() { 1 << 14 } else { 1 << 20 };
            let t0 = Instant::now();
            let stdout = std::io::stdout();
            let mut done = 0u64;
            let mut skipped_ms = 0i64; // temps sauté pendant les WFI (sauf --realtime)
            while !vm.halted && done < max {
                vm.time_ms = t0.elapsed().as_millis() as i64 + skipped_ms;
                if let Some((x, y, b)) = mouse { vm.set_mouse(x, y, b); }
                done += vm.run((max - done).min(chunk));
                if let (Some(w), Some(t)) = (trace_out.as_mut(), vm.trace.as_mut()) {
                    w.write_all(t.as_bytes()).unwrap();
                    t.clear();
                }
                if vm.waiting {
                    if realtime {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    } else {
                        skipped_ms += 1;
                    }
                }
                if wav.is_some() {
                    let want = (vm.time_ms as f64 * tri27::sound::SR / 1000.0) as usize;
                    if want > audio.len() {
                        let n = audio.len();
                        audio.resize(want, 0.0);
                        vm.snd.render(&mut audio[n..]);
                    }
                }
                if !vm.out.is_empty() {
                    let mut o = stdout.lock();
                    o.write_all(vm.out.as_bytes()).unwrap();
                    o.flush().unwrap();
                    vm.out.clear();
                }
                if vm.frame_ready {
                    vm.frame_ready = false;
                    if let Some(d) = &ppm {
                        std::fs::create_dir_all(d).unwrap();
                        save_ppm(&vm, &std::path::Path::new(d).join(format!("frame_{:05}.ppm", vm.frames)));
                    }
                }
            }
            if let Some(w) = trace_out.as_mut() {
                w.flush().unwrap();
            }
            if let Some(d) = &disk {
                if vm.disk_dirty {
                    save_disk(d, &vm.disk);
                }
            }
            #[cfg(feature = "prof")]
            {
                let tot: u64 = vm.prof_op.iter().sum();
                let mut v: Vec<(usize, u64)> = vm.prof_op.iter().copied().enumerate().filter(|x| x.1 > 0).collect();
                v.sort_by(|a, b| b.1.cmp(&a.1));
                eprintln!("[prof] {} instr, mode utilisateur {:.1}%", tot, 100.0 * vm.prof_user as f64 / tot.max(1) as f64);
                for (o, n) in v.iter().take(22) {
                    let name = isa::OPS.iter().find(|x| x.code as usize == *o).map(|x| x.name).unwrap_or("?");
                    eprintln!("[prof] {:<6} {:>6.2}%", name, 100.0 * *n as f64 / tot as f64);
                }
                eprintln!("[prof] pièges par cause : {:?}", &vm.prof_traps[..12]);
                if let Ok(path) = std::env::var("TRI27_HOT") {
                    let mut h: Vec<(usize, u32)> = vm.prof_pc.iter().copied().enumerate().filter(|x| x.1 > 0).collect();
                    h.sort_by(|a, b| b.1.cmp(&a.1));
                    let s: String = h.iter().take(400).map(|(c, n)| format!("{} {}\n", c * 3, n)).collect();
                    std::fs::write(path, s).unwrap();
                }
            }
            let dt = t0.elapsed().as_secs_f64();
            if let Some(w) = &wav {
                save_wav(w, &audio);
                let peak = audio.iter().fold(0f32, |m, x| m.max(x.abs()));
                eprintln!("[tri27] son : {} échantillons ({:.2}s), crête {:.3} → {w}", audio.len(), audio.len() as f64 / tri27::sound::SR, peak);
            }
            if let Some(e) = &vm.error {
                eprintln!("\n[tri27] ERREUR: {e}");
                eprintln!("  {}", isa::disasm(vm.peek_word(vm.pc), vm.pc));
            }
            if stats {
                eprintln!(
                    "\n[tri27] {} instr en {:.3}s = {:.1} M instr/s, exit={}, frames={}",
                    vm.cycles,
                    dt,
                    vm.cycles as f64 / dt / 1e6,
                    vm.exit_code,
                    vm.frames
                );
            }
            std::process::exit(if vm.error.is_some() { 1 } else { (vm.exit_code as i32).clamp(0, 255) });
        }
        "asm" => {
            let img = load(args.get(2).unwrap_or_else(|| usage()));
            let mut addrs: Vec<i64> = img.lines.iter().map(|x| x.0).collect();
            addrs.dedup();
            let mut byaddr: Vec<(&String, &i64)> = img.symbols.iter().collect();
            byaddr.sort_by_key(|x| *x.1);
            for (a, ln) in &img.lines {
                for (n, v) in &byaddr {
                    if **v == *a {
                        println!("{n}:");
                    }
                }
                let u = *a as usize;
                let w = img.trytes[u] as i64 + img.trytes[u + 1] as i64 * trit::T9 + img.trytes[u + 2] as i64 * trit::T9 * trit::T9;
                println!("  {a:>7}  {}  {:<32} ; l.{ln}", trit::to_trit_string(w, 27), isa::disasm(w, *a));
            }
            eprintln!("{} trytes, entrée = {}", img.trytes.len(), img.entry);
        }
        "mkdisk" => {
            if args.len() < 4 {
                usage()
            }
            mkdisk(&args[2], &args[3..]);
        }
        "bench" => {
            let src = r#"
start:  li    t0, 50000000
        li    t1, 0
        li    t2, 7
loop:   add   t1, t1, t0
        tmul  t3, t1, t2
        max   t1, t1, t3
        shti  t3, t3, -2
        addi  t0, t0, -1
        bnez  t0, loop
        mv    a0, t1
        ecall 3
        li    a0, 10
        ecall 1
        halt
"#;
            let img = asm::assemble(src).unwrap();
            let mut vm = Vm::new(RAM);
            vm.load(0, &img.trytes);
            vm.reset_cpu(img.entry);
            let t0 = Instant::now();
            vm.run(u64::MAX);
            let dt = t0.elapsed().as_secs_f64();
            print!("{}", vm.out);
            println!(
                "bench mixte (add/tmul/max/shti/addi/bnez): {} instr en {:.3}s = {:.1} M instr/s",
                vm.cycles,
                dt,
                vm.cycles as f64 / dt / 1e6
            );
            let src2 = "start: li t0, 100000000\nloop: addi t1, t1, 3\n add t2, t2, t1\n addi t0, t0, -1\n bnez t0, loop\n halt\n";
            let img = asm::assemble(src2).unwrap();
            let mut vm = Vm::new(RAM);
            vm.load(0, &img.trytes);
            vm.reset_cpu(img.entry);
            let t0 = Instant::now();
            vm.run(u64::MAX);
            let dt = t0.elapsed().as_secs_f64();
            println!("bench arithmétique (addi/add/bnez): {} instr en {:.3}s = {:.1} M instr/s", vm.cycles, dt, vm.cycles as f64 / dt / 1e6);
        }
        _ => usage(),
    }
}
