# Binary C compatibility without binary ISA operations

`lib/bits.c` uses three 16x16 nibble truth tables, ten low digits and one
signed two-bit top digit (42-bit two's complement). Variable shifts load
one of 42 powers of two; signed right shift uses floor division. Unsigned
right shift divides the ternary residue once, with a native signed division
fast path for the lower half. Invalid shift counts still abort.

The backend emits normalized remainders for contiguous low masks whose
modulus fits an immediate; handles AND zero; and normalizes OR/XOR zero to
the signed 42-bit payload. Both operand orders and side effects are preserved.
No ISA/VM changes.

## Compatibility traps

A ternary word is not a signed 42-bit integer: values outside +/-2^41 need
payload normalization for OR/XOR zero. The previous bit loop also maps the
minimum ternary word -3812798742493 to +3812798742493 through wraparound
in `(a-x)/2`. This historical edge case is intentionally preserved, both
in tables and inline masks/zero operations. Other negative nibble quotients
use `a/16-(a%16<0)` to avoid underflow near that minimum.
Unsigned values are residues modulo 3^27, not standard uint64_t. GCC
comparison is valid for the bounded bitbench, not arbitrary upper residues.

## Reproduce

```
python cc/perf.py
python cc/run_tests.py
python cc/tri27cc.py cc/examples/bitcheck.c -o cc/build/bitcheck.tas
tri27/target/release/tri27 run cc/build/bitcheck.tas --stats --max 2000000000
```

`bitcheck.c` compares helpers and emitted operators to the exact old bit loop
for boundary pairs, all shift counts 0..41 (including negative/upper unsigned
residues), low masks, zero operands, and side effects. It prints `bitcheck OK`.
Invalid shift aborts are unchanged in source; not separately exercised here.

## Measured instructions (same VM and peephole)

| Case | Before | After |
|---|---:|---:|
| bits | 5210228 | 368758 |
| sieve | 1767177 | 1767177 |
| bench | 1924137 | 1924137 |
| fb | 2306090 | 2306090 |
| tetris | 2181355 | 2181355 |
| total | 13388987 | 8547517 |

Bits: 14.13x fewer instructions, reduction 92.92%. Checksum `188466828`
was measured before backend/library edits and reproduced afterwards, also
by native Alpine GCC. Existing four programs' output lines are unchanged.
Tests: 34 PASS, 7 SKIP, 0 FAIL; bitcheck exit 0 (11944816 instructions).

Limits: 768 table trytes plus 42 power words; general binary operations still
use compatibility helpers; inline mask optimization requires an immediate
modulus; upper unsigned residues retain the existing division algorithm.
