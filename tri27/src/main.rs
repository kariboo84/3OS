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
    let mut rgba = vec![0u8; FB_W * FB_H * 4];
    vm.render_rgba(&mut rgba);
    let mut f = std::fs::File::create(path).unwrap();
    write!(f, "P6\n{FB_W} {FB_H}\n255\n").unwrap();
    let rgb: Vec<u8> = rgba.chunks(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    f.write_all(&rgb).unwrap();
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
            let mut stats = false;
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
                    _ => usage(),
                }
                i += 1;
            }
            let img = load(path);
            let mut vm = Vm::new(RAM);
            vm.load(0, &img.trytes);
            vm.reset_cpu(img.entry);
            let t0 = Instant::now();
            let stdout = std::io::stdout();
            let mut done = 0u64;
            while !vm.halted && done < max {
                vm.time_ms = t0.elapsed().as_millis() as i64;
                done += vm.run((max - done).min(1 << 20));
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
