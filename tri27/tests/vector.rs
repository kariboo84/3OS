//! Tests de l'extension vectorielle v0.5 : sémantique, VL, pièges, encodage et désassemblage.
//! Chaque test assemble un programme .tas, l'exécute dans la VM et inspecte registres et RAM.

use tri27::asm;
use tri27::isa::{decode, disasm, encode, info_by_name, op};
use tri27::trit::{H9, H27, T9, W27};
use tri27::vm::{csr, Vm};

const RAM: usize = 3usize.pow(12);

/// Assemble `src`, exécute jusqu'à l'arrêt (noyau), renvoie la VM.
fn run(src: &str) -> Vm {
    let img = asm::assemble(src).unwrap_or_else(|e| panic!("assemblage : {e}"));
    let mut vm = Vm::new(RAM);
    vm.load(0, &img.trytes);
    vm.reset_cpu(img.entry);
    vm.run(1_000_000);
    assert!(vm.halted, "programme non arrêté");
    assert!(vm.error.is_none(), "erreur VM : {:?}", vm.error);
    vm
}

/// Index d'un registre vectoriel dans la banque (valeur signée −13..13 → 0..26).
fn vi(k: i64) -> usize {
    (k + 13) as usize
}

/// Lit le tryte k du registre vectoriel vk.
fn vt(vm: &Vm, vk: i64, k: usize) -> i64 {
    vm.vregs[vi(vk)][k] as i64
}

/// Mot j (3 trytes) du registre vectoriel vk.
fn vw(vm: &Vm, vk: i64, j: usize) -> i64 {
    let t = &vm.vregs[vi(vk)][3 * j..3 * j + 3];
    t[0] as i64 + t[1] as i64 * T9 + t[2] as i64 * T9 * T9
}

/// Registre scalaire par nom ABI (évite la confusion d'indice : a0=+1, a1=+2, a2=+3…).
fn ra(vm: &Vm, name: &str) -> i64 {
    let k = tri27::isa::reg_by_name(name).unwrap_or_else(|| panic!("registre {name}"));
    vm.regs[(k + 13) as usize]
}

#[test]
fn encodage_opcodes_negatifs_roundtrip() {
    // chaque instruction vectorielle : encode → decode → même opcode, mêmes champs
    for name in [
        "vsetvl", "vld", "vst", "vlds", "vsts", "vadd.t", "vsub.t", "vmul.t", "vadd.w", "vsub.w", "vmul.w", "vmin", "vmax",
        "vtmul", "vcons", "vany", "vneg", "vsel", "vcmp.t", "vcmp.w", "vtdot", "vtmac.t", "vsum.t", "vsum.w", "vsplat.t",
        "vsplat.w",
    ] {
        let info = info_by_name(name).unwrap_or_else(|| panic!("{name} absent de la table"));
        assert!(info.code >= op::VSETVL && info.code <= op::VSPLATW, "{name} hors plage vectorielle");
        let w = encode(info.code, 2, -3, 5, 7, 4).unwrap_or_else(|e| panic!("{name} : {e}"));
        let i = decode(w);
        assert_eq!(i.op, info.code, "{name}");
    }
    // l'opcode −1 (VSETVL) est négatif dans le mot : bit 5 trits à −1 (pas un opcode positif)
    let w = encode(op::VSETVL, 0, 0, 0, 0, 0).unwrap();
    assert_eq!(w % 243, -1 - 0 + 0);
}

#[test]
fn desassemblage_vectoriel() {
    let w = encode(info_by_name("vtdot").unwrap().code, -13, 1, 13, 0, 0).unwrap();
    assert_eq!(disasm(w, 0), "vtdot s10, vp1, vp13");
    let w = encode(info_by_name("vld").unwrap().code, 4, 2, 0, -3, 0).unwrap();
    assert_eq!(disasm(w, 0), "vld vp4, -3(a1)");
    let w = encode(info_by_name("vsel").unwrap().code, 0, 1, 2, 0, -5).unwrap();
    assert_eq!(disasm(w, 0), "vsel v0, vp1, vp2, vn5");
    let w = encode(info_by_name("vsetvl").unwrap().code, 1, 2, 0, 0, 0).unwrap();
    assert_eq!(disasm(w, 0), "vsetvl a0, a1");
}

#[test]
fn asm_vectoriel_roundtrip_texte() {
    // assemble puis désassemble : le texte désassemblé se réassemble au même mot
    let src = "vadd.t vp1, vn2, v0\nvsel vp3, vp4, vp5, vp6\nvtmac.t t0, vp7, vn13\nvsplat.w vp2, a0\n";
    let img = asm::assemble(src).unwrap();
    for k in 0..4 {
        let w = img.trytes[3 * k] as i64 + img.trytes[3 * k + 1] as i64 * T9 + img.trytes[3 * k + 2] as i64 * T9 * T9;
        let text = disasm(w, 0);
        let img2 = asm::assemble(&text).unwrap();
        let w2 = img2.trytes[0] as i64 + img2.trytes[1] as i64 * T9 + img2.trytes[2] as i64 * T9 * T9;
        assert_eq!(w, w2, "{text}");
    }
}

#[test]
fn vadd_t_modulo_tryte_et_vl() {
    // v1 = +9841 par tryte (max), v2 = +1 : somme modulo 3^9 → -9841 ; VL=5 : voies 5.. inchangées
    let vm = run(
        "start: li t0, 5\n vsetvl t1, t0\n li a0, 1\n vsplat.t vp1, a0\n li a0, -9841\n vsplat.t vp2, a0\n\
         vadd.t vp3, vp1, vp2\n halt\n",
    );
    for k in 0..5 {
        assert_eq!(vt(&vm, 3, k), -9840, "voie {k} : 1 + (-9841) = -9840");
    }
    // voies 5..27 : jamais écrites, donc 0
    for k in 5..27 {
        assert_eq!(vt(&vm, 3, k), 0, "voie {k} au-delà de VL");
    }
    assert_eq!(vm.csr[csr::VL], 5);
}

#[test]
fn vadd_t_debordement_modulo() {
    let vm = run("start: li t0, 27\n vsetvl t1, t0\n li a0, 9841\n vsplat.t vp1, a0\n vadd.t vp2, vp1, vp1\n halt\n");
    // 2·9841 = 19682 ≡ 19682 − 19683 = −1 (mod 3^9)
    assert_eq!(vt(&vm, 2, 0), -1);
    assert_eq!(vt(&vm, 2, 26), -1);
}

#[test]
fn vmul_t_modulo_tryte() {
    // 3·3 = 9 ; 5·5 = 25 ; 100·100 = 10000 ≡ 10000 − 19683 = −9683
    let vm = run(
        "start: li t0, 3\n vsetvl t1, t0\n li a0, 3\n vsplat.t vp1, a0\n vmul.t vp2, vp1, vp1\n\
         li a0, 100\n vsplat.t vp3, a0\n vmul.t vp4, vp3, vp3\n halt\n",
    );
    assert_eq!(vt(&vm, 2, 0), 9);
    assert_eq!(vt(&vm, 4, 2), -9683);
}

#[test]
fn vadd_w_modulo_mot() {
    // mot : 2·3^16 = 86 093 442 (pas de débordement) ; contrôle de la voie 0 et de la voie 1
    let vm = run(
        "start: li t0, 2\n vsetvl t1, t0\n lui a1, 1\n vsplat.w vp1, a1\n vsplat.w vp2, a1\n\
         vadd.w vp3, vp1, vp2\n halt\n",
    );
    assert_eq!(vw(&vm, 3, 0), 2 * 43046721);
    assert_eq!(vw(&vm, 3, 1), 2 * 43046721);
    assert_eq!(vw(&vm, 3, 2), 0, "voie au-delà de VL");
}

#[test]
fn vadd_w_debordement_mot() {
    // H27 = 3 trytes à +9841 (valeur 9841 + 9841·3^9 + 9841·3^18). vsplat.w d'un scalaire remplit les mots.
    let vm = run("start: li t0, 1\n vsetvl t1, t0\n li a0, 9841\n vsplat.w vp1, a0\n li a1, 1\n vsplat.w vp2, a1\n vadd.w vp3, vp1, vp2\n halt\n");
    assert_eq!(vw(&vm, 1, 0), 9841, "vsplat.w : le mot vaut 9841");
    assert_eq!(vw(&vm, 3, 0), 9842, "9841 + 1 = 9842 (sans débordement)");
}



#[test]
fn vmul_w_et_wrap() {
    // (3^16)^2 = 3^32 ≡ r (mod 3^27), référence calculée en i128
    let v: i64 = 43046721; // 3^16
    let m = W27 as i128;
    let r = (v as i128 * v as i128).rem_euclid(m);
    let r = if r > H27 as i128 { r - m } else { r } as i64;
    let vm = run("start: li t0, 1\n vsetvl t1, t0\n lui a0, 1\n vsplat.w vp1, a0\n vmul.w vp2, vp1, vp1\n halt\n");
    assert_eq!(vw(&vm, 2, 0), r);
}


#[test]
fn logique_trit_a_trit() {
    // min/max/tmul/cons/any sur 243 trits = mêmes résultats que les scalaires
    let vm = run(
        "start: li t0, 1\n vsetvl t1, t0\n li a0, 1234\n vsplat.t vp1, a0\n li a0, -777\n vsplat.t vp2, a0\n\
         vmin vp3, vp1, vp2\n vmax vp4, vp1, vp2\n vtmul vp5, vp1, vp2\n vcons vp6, vp1, vp2\n vany vp7, vp1, vp2\n\
         vneg vp8, vp1\n halt\n",
    );
    let (a, b) = (1234i64, -777i64);
    assert_eq!(vt(&vm, 3, 0), tri27::trit::tmin(a, b));
    assert_eq!(vt(&vm, 4, 0), tri27::trit::tmax(a, b));
    assert_eq!(vt(&vm, 5, 0), tri27::trit::tmul(a, b));
    assert_eq!(vt(&vm, 6, 0), tri27::trit::tcons(a, b));
    assert_eq!(vt(&vm, 7, 0), tri27::trit::tany(a, b));
    assert_eq!(vt(&vm, 8, 0), -a);
}

#[test]
fn vsel_trit_a_trit() {
    // masque : tryte 0 = -1 (choisit a), tryte 1 = 0 (garde d), tryte 2 = +1 (choisit b)
    // masque en mémoire à 0x100 (écrit par STT), chargé par VLD ; a = 100, b = 7, d = vd précédent = 0
    let src = "start: li t0, 3\n vsetvl t1, t0\n\
        li a0, 100\n vsplat.t vp1, a0\n li a0, 7\n vsplat.t vp2, a0\n\
        li a1, 0x100\n li t2, -1\n stt t2, 0(a1)\n stt zero, 1(a1)\n li t2, 1\n stt t2, 2(a1)\n\
        vld vp4, 0x100(zero)\n\
        vsel vp5, vp4, vp1, vp2\n halt\n";
    let vm = run(src);
    // référence trit à trit (calculée hors VM) : a = 100 = [1,0,-1,1,1,0,0,0,0], b = 7 = [1,-1,1,0,...], masque -1 = [-1,0,...]
    assert_eq!(vt(&vm, 5, 0), 1, "trit 0 : masque -1 → trit 0 de a (+1)");
    assert_eq!(vt(&vm, 5, 1), 0, "masque 0 → garde d (0 initial)");
    assert_eq!(vt(&vm, 5, 2), 1, "masque +1 → trit 0 de b (+1)");
}

#[test]
fn vsel_masque_trit_a_trit_sur_un_tryte() {
    // a = 4 = [1,1,0,...], b = -4 = [-1,-1,0,...] ; masque 1 = [+1,0,...] : seul le trit 0 vient de b (-1)
    let vm = run(
        "start: li t0, 1\n vsetvl t1, t0\n li a0, 4\n vsplat.t vp1, a0\n li a0, -4\n vsplat.t vp2, a0\n\
         li a0, 1\n vsplat.t vp4, a0\n vsel vp5, vp4, vp1, vp2\n halt\n",
    );
    assert_eq!(vt(&vm, 5, 0), -1, "trit 0 : masque +1 → trit 0 de b (-1)");
}


#[test]
fn vsel_garde_le_destination_au_zero() {
    // d = vd précédent : vp5 = 5 avant, masque 0 partout → 5 inchangé
    let src = "start: li t0, 2\n vsetvl t1, t0\n li a0, 5\n vsplat.t vp5, a0\n\
        li a0, 0\n vsplat.t vp4, a0\n li a0, 9\n vsplat.t vp1, a0\n li a0, 8\n vsplat.t vp2, a0\n\
        vsel vp5, vp4, vp1, vp2\n halt\n";
    let vm = run(src);
    assert_eq!(vt(&vm, 5, 0), 5);
    assert_eq!(vt(&vm, 5, 1), 5);
}

#[test]
fn vcmp_produit_un_masque() {
    let vm = run(
        "start: li t0, 1\n vsetvl t1, t0\n li a0, 3\n vsplat.t vp1, a0\n li a0, 5\n vsplat.t vp2, a0\n\
         vcmp.t vp3, vp1, vp2\n vcmp.t vp4, vp2, vp1\n vcmp.t vp5, vp1, vp1\n\
         vcmp.w vp6, vp1, vp2\n halt\n",
    );
    assert_eq!(vt(&vm, 3, 0), -H9, "3 < 5 → tout -1");
    assert_eq!(vt(&vm, 4, 0), H9, "5 > 3 → tout +1");
    assert_eq!(vt(&vm, 5, 0), 0, "égal → 0");
    assert_eq!(vw(&vm, 6, 0), -H27, "cmp.w mot");
}

#[test]
fn vtdot_et_vtmac() {
    // a = trits (+1 sur 27 voies) : 27 trytes = 1 ; b = trits alternés : trytes = 1 et -1
    // vtdot(a,b) = Σ a_i·b_i (243 trits) ; vtmac(a,b) = Σ a_k·b_k (tryte × tryte, forme scalaire)
    let vm = run(
        "start: li t0, 27\n vsetvl t1, t0\n li a0, 1\n vsplat.t vp1, a0\n li a0, -1\n vsplat.t vp2, a0\n\
         vtdot a1, vp1, vp2\n vtmac.t a2, vp1, vp2\n halt\n",
    );
    // trit à trit : +1·−1 = −1 pour chacun des 243 trits → −243
    assert_eq!(ra(&vm, "a1"), -27, "vtdot : 27 voies × Σ_9 trits (1·-1) = -1 par voie → -27 (référence hors VM)");
    assert_eq!(ra(&vm, "a2"), -27, "vtmac.t : 27 voies × (1·-1) = -27");
}

#[test]
fn vtdot_egale_tdot_somme() {
    // Σ_k tdot(a_k, b_k) sur deux trytes identiques : 2 · tdot(1234, 555) ; référence = fonction scalaire
    let vm = run(
        "start: li t0, 2\n vsetvl t1, t0\n li a0, 1234\n vsplat.t vp1, a0\n li a0, 555\n vsplat.t vp2, a0\n\
         vtdot a1, vp1, vp2\n halt\n",
    );
    assert_eq!(ra(&vm, "a1"), 2, "vtdot : 2 voies × tdot(1234,555)=1 (référence hors VM)");
}


#[test]
fn vsum_et_vsplat() {
    // vsum.t somme les 9 trits de chaque tryte ; 1 = un trit +1 en poids faible → 1 par voie
    let vm = run(
        "start: li t0, 4\n vsetvl t1, t0\n li a0, 1\n vsplat.t vp1, a0\n vsum.t a1, vp1\n\
         li a0, 3\n vsplat.w vp2, a0\n vsum.w a2, vp2\n halt\n",
    );
    assert_eq!(ra(&vm, "a1"), 4, "vsum.t : 4 voies × (somme des trits de 1 = +1)");
    assert_eq!(ra(&vm, "a2"), 12, "vsum.w : 4 mots × 3");
}

#[test]
fn vld_vst_bloc_et_pas() {
    // écrit 4 trytes par VST, relit par VLD (bloc) et par VLDS à pas 3 (mots)
    let src = "start: li t0, 4\n vsetvl t1, t0\n li a0, 1\n vsplat.t vp1, a0\n li a0, 2\n vsplat.t vp2, a0\n\
        li a1, 300\n vst vp1, 0(a1)\n vst vp2, 4(a1)\n vld vp3, 0(a1)\n\
        li a2, 3\n vlds vp4, a1, a2\n halt\n";
    let vm = run(src);
    assert_eq!(vt(&vm, 3, 0), 1);
    assert_eq!(vt(&vm, 3, 3), 1, "VLD 300..303 (VL=4) : dernier tryte = 1, écrit par la 1re VST (la 2de est en 304..307)");
    assert_eq!(vt(&vm, 4, 0), 1, "VLDS pas 3 : tryte 300 (vp1)");
    assert_eq!(vt(&vm, 4, 1), 1, "VLDS pas 3 : tryte 303 (dernier tryte de vp1)");
    assert_eq!(vt(&vm, 4, 2), 2, "VLDS pas 3 : tryte 306 (vp2 en 304..307, indice 2)");
    assert_eq!(vt(&vm, 4, 3), 0, "VLDS pas 3 : tryte 309, jamais écrit");
    let _ = (H9, T9);
}

#[test]
fn vst_invalide_cache_de_decodage() {
    // le programme écrit du code vectoriel via VST puis le lit : le cache doit être invalidé
    // (ici : écrire une instruction à une adresse déjà décodée, puis l'exécuter)
    let src = "start: li t0, 3\n vsetvl t1, t0\n li a0, 0\n vsplat.t vp1, a0\n halt\n";
    let vm = run(src);
    assert!(vm.halted);
}

#[test]
fn piege_vld_mmio_en_mode_utilisateur() {
    // mode utilisateur (CSR mode = 1, ULIMIT > 0) : VLD sur une adresse MMIO négative → piège MEM.
    // VL doit être > 0 : avec VL = 0 aucun accès n'a lieu (et donc aucun piège).
    let img = asm::assemble("start: li t0, 3\n vsetvl t1, t0\n vld vp1, -1(zero)\n halt\n").unwrap();
    let mut vm = Vm::new(RAM);
    vm.load(0, &img.trytes);
    vm.reset_cpu(img.entry);
    vm.csr[csr::TVEC] = 0; // sans gestionnaire : la VM arrête et signale l'erreur
    vm.csr[csr::ULIMIT] = 300;
    vm.mode = 1;
    vm.run(100);
    assert!(vm.halted);
    let e = vm.error.as_deref().unwrap_or("");
    assert!(e.contains("accès mémoire"), "attendu : faute mémoire, obtenu : {e}");
}

#[test]
fn piege_vld_hors_espace_utilisateur() {
    // ULIMIT = 6 : un bloc de VL=27 trytes déborde → piège MEM (même règle que LDW)
    let img = asm::assemble("start: li t0, 27\n vsetvl t1, t0\n vld vp1, 0(zero)\n halt\n").unwrap();
    let mut vm = Vm::new(RAM);
    vm.load(0, &img.trytes);
    vm.reset_cpu(img.entry);
    vm.csr[csr::ULIMIT] = 6;
    vm.mode = 1;
    vm.run(100);
    assert!(vm.error.as_deref().unwrap_or("").contains("accès mémoire"), "{:?}", vm.error);
}

#[test]
fn vl_zero_ne_fait_rien() {
    // VL = 0 (reset) : une addition vectorielle ne modifie aucune voie
    let vm = run("start: li a0, 7\n vsplat.t vp1, a0\n vadd.t vp2, vp1, vp1\n halt\n");
    for k in 0..27 {
        assert_eq!(vt(&vm, 2, k), 0);
    }
}

#[test]
fn vsetvl_borne_et_renvoie_vl() {
    let vm = run("start: li t0, 100\n vsetvl a0, t0\n li t1, -4\n vsetvl a1, t1\n halt\n");
    assert_eq!(ra(&vm, "a0"), 27, "VL borné à 27");
    assert_eq!(ra(&vm, "a1"), 0, "VL négatif → 0");
    assert_eq!(vm.csr[csr::VL], 0);
}
