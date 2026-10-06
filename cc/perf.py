#!/usr/bin/env python3
"""Banc d'instructions du compilateur : nombre d'instructions TRI-27 exécutées
(déterministe) pour des programmes C de référence. Usage : python cc/perf.py [--nopeep]"""
import os, re, subprocess, sys
from pathlib import Path
R = Path(__file__).resolve().parent.parent
VM = R / 'tri27/target/release/tri27'
B = R / 'cc/build/perf'; B.mkdir(parents=True, exist_ok=True)
CASES = [  # (nom, sources, args run, motif de sortie attendu)
    ('bits', ['examples/bitbench.c'], [], r'bits checksum: 188466828'),
    ('sieve',  ['examples/sieve.c'], [], r'9592'),
    ('bench',  ['examples/bench.c'], [], r'.'),
    ('fb',     ['examples/framebuffer.c'], [], r'.'),
    ('tetris', ['examples/tetris.c'], ['--input', 'dd   aa  q'], r'tetris: score'),
]
env = dict(os.environ)
if '--nopeep' in sys.argv: env['TRI27_NOPEEP'] = '1'
tot = 0
for name, srcs, args, pat in CASES:
    out = B / f'{name}.tas'
    subprocess.run([sys.executable, str(R/'cc/tri27cc.py'), *[str(R/'cc'/s) for s in srcs], '-o', str(out)], check=True, env=env, capture_output=True)
    p = subprocess.run([str(VM), 'run', str(out), '--stats', '--max', '2000000000', *args], capture_output=True, text=True, timeout=300)
    txt = p.stdout + p.stderr
    m = re.search(r'\[tri27\] (\d+) instr', txt)
    n = int(m[1]) if m else -1
    ok = bool(re.search(pat, txt))
    extra = ''
    mm = re.search(r'(\d+) instr/image en moyenne', txt)
    if mm: extra = f'  ({mm[1]} instr/image)'
    first = p.stdout.strip().split('\n')[0][:48] if p.stdout.strip() else ''
    print(f'{name:<8} {n:>12} instr  {"OK" if ok else "SORTIE INATTENDUE"}{extra}  | {first}')
    tot += n
print(f'{"total":<8} {tot:>12}')
