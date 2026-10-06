use std::io::Write;
use std::time::Instant;
use tri27::{asm, isa, trit, vm::*};

const RAM: usize = 14_348_907; // 3^15 trytes

fn usage() -> ! {
    eprintln!(
        "tri27 — VM ternaire équilibrée\n\
         usage:\n  tri27 run <prog.tas> [--max N] [--ppm DIR] [--stats]\n  \
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
            vm.input.extend(input.chars().map(|c| c as i64));
            let t0 = Instant::now();
            let stdout = std::io::stdout();
            let mut done = 0u64;
            while !vm.halted && done < max {
                vm.time_ms = t0.elapsed().as_millis() as i64;
                if let Some((x, y, b)) = mouse { vm.set_mouse(x, y, b); }
                done += vm.run((max - done).min(1 << 20));
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
