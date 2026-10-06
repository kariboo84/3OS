#!/usr/bin/env python3
"""Affiche les instructions les plus chaudes d'un programme, avec le source assembleur.
Usage : python cc/hot.py prog.tas [args run...]   (nécessite le build --features prof)"""
import os, re, subprocess, sys
from pathlib import Path
R = Path(__file__).resolve().parent.parent
PROF = R / 'tri27/target/prof/release/tri27'
VM = R / 'tri27/target/release/tri27'
tas = sys.argv[1]
hot = R / 'cc/build/hot.txt'
env = dict(os.environ, TRI27_HOT=str(hot))
subprocess.run([str(PROF), 'run', tas, '--max', '2000000000', *sys.argv[2:]], env=env, capture_output=True, timeout=300)
lst = subprocess.run([str(VM), 'asm', tas], capture_output=True, text=True).stdout.splitlines()
by_pc = {}
for l in lst:
    m = re.match(r'\s+(\d+)\s+[0+-]{27}\s+(.*?)\s*;\s*l\.(\d+)', l)
    if m: by_pc[int(m[1])] = (m[2], int(m[3]))
counts = {}
for l in hot.read_text().splitlines():
    pc, n = map(int, l.split()); counts[pc] = n
tot = sum(counts.values())
# blocs : suites d'adresses consécutives de même compte
seen = set(); blocks = []
for pc, n in sorted(counts.items(), key=lambda x: -x[1]):
    if pc in seen: continue
    a = pc
    while a - 3 in counts and counts[a - 3] == n: a -= 3
    b = pc
    while b + 3 in counts and counts[b + 3] == n: b += 3
    for x in range(a, b + 3, 3): seen.add(x)
    blocks.append((n * ((b - a) // 3 + 1), n, a, b))
blocks.sort(reverse=True)
src = Path(tas).read_text(encoding='utf-8').splitlines()
for w, n, a, b in blocks[:int(os.environ.get('NB', 6))]:
    print(f'--- bloc {a}..{b} : {n} passages, {100*w/max(tot,1):.1f}% des instr (top400)')
    for x in range(a, b + 3, 3):
        print(f'   {x:>7}  {by_pc.get(x, ("?",0))[0]}')
