# TRI-27 — ISA ternaire équilibrée (v0.1)

Tout est en **ternaire équilibré** : trit ∈ {−1, 0, +1} (notés `-`, `0`, `+`).
L'hôte stocke les valeurs en entiers binaires (i64) ; la **sémantique** est ternaire :
débordement modulo 3²⁷, décalages ×3ᵏ, logique trit-à-trit, comparaisons à 3 issues.

## 1. Données

| Unité | Trits | Plage | Rôle |
|---|---|---|---|
| tryte | 9 | ±9 841 | octet C (`char`), pixel, caractère |
| mot | 27 | ±3 812 798 742 493 | `int`, pointeur, instruction |

- Arithmétique **modulo 3²⁷**, résultat ramené dans la plage équilibrée.
- Mémoire **adressable au tryte**. Un mot à l'adresse `a` = trytes `a, a+1, a+2` (petit-boutiste : `a` = trits 0–8).
- **Adresses ≥ 0 : RAM.** **Adresses < 0 : périphériques (MMIO).**

## 2. Registres

27 registres, indice −13…+13 (champ de 3 trits).

| Indice | Nom | ABI |
|---|---|---|
| 0 | `zero` | toujours 0 |
| +1…+6 | `a0`…`a5` (`p1`…`p6`) | arguments / retour (`a0`) |
| +7…+13 | `t0`…`t6` (`p7`…`p13`) | temporaires |
| −1 | `sp` (`n1`) | pile (descend) |
| −2 | `ra` (`n2`) | adresse de retour |
| −3 | `fp` / `s0` (`n3`) | cadre |
| −4…−13 | `s1`…`s10` (`n4`…`n13`) | sauvegardés |

Pas de registre de flags. `pc` = adresse en trytes, multiple de 3.

## 3. Formats (1 instruction = 1 mot = 27 trits, trit 0 = poids faible)

| Format | trits 0–4 | 5–7 | 8–10 | 11–13 | reste |
|---|---|---|---|---|---|
| R | op | rd | rs1 | rs2 | 14–26 réservé (0) |
| I | op | rd | rs1 | imm16 (11–26) | |
| J | op | rd | imm19 (8–26) | | |
| B3 | op | rs | offn (8–16, 9 trits) | offp (17–25, 9 trits) | 26 réservé |

Encodage = Σ champ × 3^position (chaque champ en ternaire équilibré).
Décalages de saut (`imm` des branches, `JAL`, `offn/offp`) comptés **en instructions** (×3 trytes), relatifs à l'instruction elle-même.

## 4. Instructions

### R
| op | mnémo | effet |
|---|---|---|
| 1 | `ADD rd, rs1, rs2` | rd = rs1 + rs2 |
| 2 | `SUB` | rd = rs1 − rs2 |
| 3 | `MUL` | rd = rs1 × rs2 (mod 3²⁷) |
| 4 | `DIV` | quotient tronqué vers 0 (sémantique C) ; /0 → piège |
| 5 | `MOD` | reste de C (signe du dividende) ; /0 → piège |
| 6 | `NEG rd, rs1` | rd = −rs1 (= inversion de chaque trit) |
| 7 | `MIN` | ET ternaire, trit à trit |
| 8 | `MAX` | OU ternaire, trit à trit |
| 9 | `TMUL` | produit trit à trit (XNOR ternaire) |
| 10 | `CONS` | consensus : trit si égaux, sinon 0 |
| 11 | `ANY` | « accept-anything » : a si a=b, l'autre si l'un est 0, 0 si opposés |
| 12 | `CMP` | rd = signe(rs1 − rs2) ∈ {−1,0,+1} |
| 13 | `SHT` | rd = rs1 décalé de rs2 trits (>0 : ×3ᵏ ; <0 : ÷3ᵏ arrondi au plus proche = troncature équilibrée) |
| 14 | `SLT` | rd = (rs1 < rs2) ? 1 : 0 |
| 15 | `SEQ` | rd = (rs1 == rs2) ? 1 : 0 |
| 16 | `MULH` | rd = partie haute (trits 27–53) du produit |
| 50 | `HALT` | arrêt (noyau uniquement) |
| 51 | `ERET` | retour de piège (noyau uniquement) |

### I
| op | mnémo | effet |
|---|---|---|
| 20 | `ADDI rd, rs1, imm` | rd = rs1 + imm |
| 21 | `MULI` | rd = rs1 × imm |
| 22 | `SHTI` | rd = SHT(rs1, imm) |
| 23 | `LDT rd, imm(rs1)` | rd = tryte[rs1+imm] |
| 24 | `LDW rd, imm(rs1)` | rd = mot[rs1+imm] |
| 25 | `STT rd, imm(rs1)` | tryte[rs1+imm] = rd (ramené mod 3⁹) |
| 26 | `STW rd, imm(rs1)` | mot[rs1+imm] = rd |
| 27 | `BEQ rd, rs1, off` | si rd == rs1 : pc += off×3 |
| 28 | `BNE` | si ≠ |
| 29 | `BLT` | si rd < rs1 |
| 30 | `BGE` | si rd ≥ rs1 |
| 31 | `JALR rd, rs1, imm` | rd = pc+3 ; pc = rs1+imm |
| 32 | `ECALL imm` | appel système |
| 33 | `CSRR rd, csr` | rd = csr[imm] (noyau) |
| 34 | `CSRW rs1, csr` | csr[imm] = rs1 (noyau ; champ rs1) |
| 35 | `MINI` / 36 `MAXI` | MIN/MAX avec immédiat |
| 37 | `SLTI` | rd = (rs1 < imm) |

### J / B3
| op | mnémo | effet |
|---|---|---|
| 40 | `LUI rd, imm19` | rd = imm19 × 3¹⁶ (puis `ADDI` pour les 16 trits bas) |
| 41 | `JAL rd, off19` | rd = pc+3 ; pc += off×3 |
| 45 | `BR3 rs, Lneg, Lpos` | branchement à 3 voies : rs<0 → Lneg, rs>0 → Lpos, 0 → suivante |

op 0 = instruction illégale (la mémoire vide piège).

## 5. Privilèges, pièges, CSR

Mode = 1 trit : **−1 noyau**, 0 pilote, +1 utilisateur. Démarrage en noyau.

| CSR | nom | |
|---|---|---|
| 0 | MODE | mode courant (lecture) |
| 1 | TVEC | adresse du gestionnaire de pièges (0 = pas de gestionnaire) |
| 2 | EPC | pc de l'instruction fautive / de l'ECALL |
| 3 | CAUSE | cause |
| 4 | TVAL | valeur associée (adresse fautive, n° ECALL…) |
| 5 | SCRATCH | libre pour le noyau |
| 6 | TIMECMP | interruption timer quand cycles ≥ TIMECMP (0 = off) |
| 7 | IE | interruptions autorisées (0/1) |
| 8 | PMODE | mode avant le piège |
| 9 | PIE | IE avant le piège |

Causes : 1 illégale, 2 privilège, 3 accès mémoire, 4 division par 0, 5 désalignement pc, 8 ECALL, 9 timer.
Piège : EPC=pc, CAUSE, TVAL, PMODE=mode, PIE=IE, mode=−1, IE=0, pc=TVEC. `ERET` : pc=EPC, mode=PMODE, IE=PIE.
Si TVEC=0 : ECALL est servi par l'hôte (0 exit(a0), 1 putc(a0), 2 print_int(a0), 3 print_trits(a0)) et les autres pièges arrêtent la VM.

## 6. MMIO (adresses négatives, accès LDT/LDW/STT/STW indifférent)

| Adresse | Nom | |
|---|---|---|
| −1 | CONSOLE_OUT | écriture : caractère (code Unicode ≤ 9841) |
| −2 | CONSOLE_IN | lecture : caractère suivant, −1 si vide |
| −3 | EXIT | écriture : arrêt avec code |
| −4 | CYCLES | lecture : compteur de cycles |
| −5 | FB_ADDR | écriture : adresse RAM du framebuffer (0 = désactivé) |
| −6 | FB_PRESENT | écriture : présenter l'image |
| −7 | KEY | lecture : événement clavier suivant (+code = appui, −code = relâche, 0 = rien) |
| −8 | TIME_MS | lecture : millisecondes depuis le démarrage |

Framebuffer : 320×200 trytes, ligne par ligne. Couleur **TRGB** : un tryte = 3 trits par canal
(B = trits 0–2, G = 3–5, R = 6–8), chaque canal −13…+13 → 0…255.

## 7. Assembleur (`.tas`)

```
; commentaire (ou #)
        .org 0              ; adresse en trytes
start:  addi  a0, zero, 42
        lui   t0, 1         ; t0 = 3^16
        jal   ra, func      ; étiquette → décalage calculé
        br3   a0, neg, pos
        ldw   t1, 3(sp)
        li    t2, 123456789 ; pseudo : LUI+ADDI (ou ADDI seul)
        la    t3, msg       ; pseudo : adresse d'étiquette
        mv    a1, a0        ; pseudo : ADDI a1, a0, 0
        j     start         ; pseudo : JAL zero
        call  func          ; pseudo : JAL ra
        ret                 ; pseudo : JALR zero, ra, 0
        nop                 ; pseudo : ADDI zero, zero, 0
msg:    .str  "salut\n"     ; un tryte par caractère, terminé par 0
        .tryte 1, -2, 'A'
        .word  12345, start
        .trits +0-+         ; mot littéral en trits (MSB d'abord)
        .space 30           ; 30 trytes à 0
        .align 3
```
Expressions : termes (`123`, `0x1F`, `0t+-0`, `'c'`, symbole) liés par `+` / `-` ; un littéral `0t` se termine par une espace.
`.equ NOM, expr` définit une constante ; les chaînes de `.equ` (B = A+1, C = B+1…) se résolvent dans l'ordre du source.
`.str` refuse les caractères > 9841 (hors d'un tryte).
`.word` et `.trits` alignent implicitement sur 3 ; `.wordu` émet les mêmes trois trytes sans alignement implicite (données C compactées et relocations de pointeurs).
Entrée = étiquette `start` si elle existe, sinon 0. Les instructions sont alignées sur 3 trytes.
Pile initiale : `sp` = fin de la RAM (alignée à 3).
