#!/usr/bin/env python3
"""Compile chibicc C units and link namespaced .tas fragments. Python stdlib only."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
BUILD = ROOT / 'build'


def host_command(args):
    if os.name != 'nt':
        return [str(ROOT / 'chibicc/chibicc'), *map(str, args)]
    # The normal WSL Ubuntu route. Explicit isolated Alpine fallback for this host.
    if (ROOT / '.host-root/usr/bin/gcc').exists():
        prefix = '/mnt/host/' + REPO.drive[0].lower() + REPO.as_posix()[2:]
        def translate(s):
            s = str(s).replace('\\', '/')
            repo = REPO.as_posix()
            if s.startswith('-I'):
                return '-I' + translate(s[2:])
            return '/work' + s[len(repo):] if s.lower().startswith(repo.lower()) else s
        return ['wsl', '-d', 'docker-desktop', '-e', '/bin/sh', prefix+'/cc/linux-host.sh', '/work/cc/chibicc/chibicc', *[translate(a) for a in args]]
    def translate(s):
        s = str(s).replace('\\', '/')
        return re.sub(r'([A-Za-z]):/', lambda m: '/mnt/'+m[1].lower()+'/', s)
    return ['wsl', '-e', translate(ROOT/'chibicc/chibicc'), *[translate(a) for a in args]]


def build():
    BUILD.mkdir(exist_ok=True)
    sources = list((ROOT/'chibicc').glob('*.c'))
    exe = ROOT/'chibicc/chibicc'
    if exe.exists() and exe.stat().st_mtime >= max(p.stat().st_mtime for p in [*sources, ROOT/'chibicc/chibicc.h']):
        return
    if os.name == 'nt':
        cmd = host_command([])
        cmd = cmd[:-1] + ['/usr/bin/gcc', '-std=c11', '-O2', '-static', '-o', '/work/cc/chibicc/chibicc', *['/work/cc/chibicc/'+p.name for p in sources]] if any('linux-host.sh' in a for a in cmd) else ['wsl','-e','bash','-lc',f'cd /mnt/{REPO.drive[0].lower()}{REPO.as_posix()[2:]}/cc/chibicc && gcc -std=c11 -O2 -o chibicc *.c']
    else:
        cmd = ['gcc','-std=c11','-O2','-o',str(exe),*map(str,sources)]
    subprocess.run(cmd,check=True)


def compile_unit(source, output, flags=()):
    subprocess.run(host_command([*flags, '-I'+str(ROOT/'include'), str(Path(source).resolve()), '-o',str(Path(output).resolve())]),check=True)



# ---------------------------------------------------------------------------
# Peephole TRI-27 (conservatif, par fenêtres, jamais à travers une étiquette,
# un saut ou un appel). Désactivable : TRI27_NOPEEP=1.
_REG = r'(?:a[0-5]|t[0-6]|s10|s[0-9]|sp|fp|ra|zero)'
_WRITES_FIRST = {'add','sub','mul','div','mod','neg','min','max','tmul','cons','any','cmp','sht','slt','seq',
                 'mulh','addi','muli','shti','ldt','ldw','mini','maxi','slti','lui','li','la','mv','not','csrr','sxt'}
_SAFE = _WRITES_FIRST | {'stt','stw','nop'}

def _parse(line):
    t = line.strip()
    if not t or t.startswith(';') or t.endswith(':') or t.startswith('.'):
        return None
    m = re.match(r'([a-z0-9]+)\s*(.*)$', t)
    if not m:
        return None
    ops = [o.strip() for o in m[2].split(',')] if m[2] else []
    return m[1], ops

def _regs(text):
    return set(re.findall(r'(?<![\w.])' + _REG + r'(?![\w.])', text))

def _rw(ins):
    """(lus, écrits) ou None si l'instruction n'est pas « sûre » (barrière)."""
    if ins is None or ins[0] not in _SAFE:
        return None
    op, ops = ins
    if op in ('stt', 'stw'):
        return _regs(','.join(ops)), set()
    if op in ('li', 'la', 'lui'):
        return set(), {ops[0]}
    return _regs(','.join(ops[1:])), {ops[0]}

def peephole(lines):
    changed = True
    while changed:
        changed = False
        out = []
        i = 0
        n = len(lines)
        regvars = set()
        while i < n:
            l0 = lines[i]
            if l0.startswith('; REGVARS'):
                regvars = set(l0.split()[2:])
            elif re.match(r'^[\w.]+:$', l0) and not l0.startswith('__tu') and not l0.startswith('.L'):
                pass
            p0 = _parse(l0)
            p1 = _parse(lines[i+1]) if i+1 < n else None
            p2 = _parse(lines[i+2]) if i+2 < n else None
            # A : mv sN,a0 ; X ; mv a1,sN  →  mv a1,a0 ; X
            if p0 and p0[0] == 'mv' and p0[1][1:] == ['a0'] and re.fullmatch(r's\d+', p0[1][0]) and p0[1][0] not in regvars and p2 and p2[0] == 'mv' \
                    and p2[1] == ['a1', p0[1][0]]:
                rw = _rw(p1)
                if rw and not ({p0[1][0], 'a1'} & (rw[0] | rw[1])):
                    out += ['  mv a1, a0', lines[i+1]]; i += 3; changed = True; continue
            # B : (ldw|ldt|li|addi) a0,... ; mv a1,a0 ; X (écrit a0, ne lit ni a0 ni a1) → (…) a1,... ; X
            if p0 and p0[0] in ('ldw', 'ldt', 'li', 'addi', 'la') and p0[1][0] == 'a0' and p1 and p1 == ('mv', ['a1', 'a0']):
                rw0 = _rw(p0); rw2 = _rw(p2)
                if rw0 and 'a1' not in rw0[0] and rw2 and 'a0' in rw2[1] and not ({'a0', 'a1'} & rw2[0]) and 'a1' not in rw2[1]:
                    out += ['  ' + p0[0] + ' a1, ' + ', '.join(p0[1][1:]), lines[i+2]]; i += 3; changed = True; continue
            # C : stw a0,M ; ldw a0,M  →  stw a0,M
            if p0 and p1 and p0[0] == 'stw' and p1[0] == 'ldw' and p0[1] == p1[1] and p0[1][0] == 'a0' and 'a0' not in p0[1][1]:
                out.append(l0); i += 2; changed = True; continue
            # D : addi a0,fp,K ; ldw|ldt a0,0(a0)  →  ldw a0,K(fp)
            if p0 and p1 and p0[0] == 'addi' and p0[1][:2] == ['a0', 'fp'] and p1[0] in ('ldw', 'ldt') and p1[1] == ['a0', '0(a0)']:
                out.append(f'  {p1[0]} a0, {p0[1][2]}(fp)'); i += 2; changed = True; continue
            # E : li a0,0 ; stw a0,M ; X (écrit a0 sans le lire)  →  stw zero,M ; X
            if p0 == ('li', ['a0', '0']) and p1 and p1[0] in ('stw', 'stt') and p1[1][0] == 'a0' and 'a0' not in p1[1][1]:
                rw2 = _rw(p2)
                if rw2 and 'a0' in rw2[1] and 'a0' not in rw2[0]:
                    out.append(f'  {p1[0]} zero, {p1[1][1]}'); i += 2; changed = True; continue
            # I : post-incrément  ldw a0,M ; addi a0,a0,K ; stw a0,M ; addi a0,a0,-K
            #     →  ldw a0,M ; addi t5,a0,K ; stw t5,M   (t5 n'est jamais utilisé par codegen)
            p3 = _parse(lines[i+3]) if i+3 < n else None
            if p0 and p1 and p2 and p3 and p0[0] in ('ldw', 'ldt') and p0[1][0] == 'a0' and 'a0' not in p0[1][1] \
                    and p1[0] == 'addi' and p1[1][:2] == ['a0', 'a0'] and p2 and p2[0] == ('stw' if p0[0] == 'ldw' else 'stt') \
                    and p2[1] == p0[1] and p3[0] == 'addi' and p3[1][:2] == ['a0', 'a0'] \
                    and re.fullmatch(r'-?\d+', p1[1][2]) and re.fullmatch(r'-?\d+', p3[1][2]) and int(p1[1][2]) == -int(p3[1][2]):
                out += [l0, f'  addi t5, a0, {p1[1][2]}', f'  {p2[0]} t5, {p0[1][1]}']; i += 4; changed = True; continue
            # J : addi a0,R,K ; ldw|ldt a0,0(a0)  →  ldw a0,K(R)
            if p0 and p1 and p0[0] == 'addi' and p0[1][0] == 'a0' and len(p0[1]) == 3 and re.fullmatch(r'-?[\w.]+', p0[1][2]) \
                    and p1[0] in ('ldw', 'ldt') and p1[1] == ['a0', '0(a0)']:
                out.append(f'  {p1[0]} a0, {p0[1][2]}({p0[1][1]})'); i += 2; changed = True; continue
            # M : addi a0,zero,X ; add a0,a0,R  →  addi a0,R,X   (X constante ou symbole)
            if p0 and p1 and p0[0] == 'addi' and p0[1][:2] == ['a0', 'zero'] and len(p0[1]) == 3 \
                    and p1[0] == 'add' and p1[1][:2] == ['a0', 'a0'] and p1[1][2] not in ('a0',):
                out.append(f'  addi a0, {p1[1][2]}, {p0[1][2]}'); i += 2; changed = True; continue
            # K : li R,K ; sxt R,R  avec K déjà sur une tryte → li seul
            if p0 and p1 and p0[0] == 'li' and p1[0] == 'sxt' and p1[1] == [p0[1][0], p0[1][0]] \
                    and re.fullmatch(r'-?\d+', p0[1][1]) and abs(int(p0[1][1])) <= 9841:
                out.append(l0); i += 2; changed = True; continue
            # H : opérations neutres  addi r,r,0 / muli r,r,1 / mv r,r
            if p0 and ((p0[0] == 'addi' and len(p0[1]) == 3 and p0[1][0] == p0[1][1] and p0[1][2] == '0')
                       or (p0[0] == 'muli' and len(p0[1]) == 3 and p0[1][0] == p0[1][1] and p0[1][2] == '1')
                       or (p0[0] == 'mv' and len(p0[1]) == 2 and p0[1][0] == p0[1][1])):
                i += 1; changed = True; continue
            # F : doublon exact consécutif de « stw zero,M »
            if p0 and p1 and p0[0] in ('stw', 'stt') and p0[1][0] == 'zero' and p0 == p1:
                i += 1; changed = True; continue
            # G : mv a1,sN ; OP a0,a0,a1 (a1 mort ensuite) → OP a0,a0,sN
            if p0 and p0[0] == 'mv' and p0[1][0] == 'a1' and re.fullmatch(r's\d+', p0[1][1]) and p1 \
                    and p1[0] in ('add', 'sub', 'mul', 'div', 'mod', 'slt', 'seq', 'min', 'max', 'tmul') and 'a1' in p1[1][1:] and p1[1][0] == 'a0':
                nxt = lines[i+2] if i+2 < n else ''
                pn = _parse(nxt); rwn = _rw(pn)
                okb = pn is not None and pn[0] in ('beqz','bnez','bltz','bgez','bgtz','blez','beq','bne','blt','bge','j') and 'a1' not in ' '.join(pn[1])
                if (rwn is not None and 'a1' not in rwn[0]) or okb:
                    ops = [p0[1][1] if o == 'a1' else o for o in p1[1]]
                    out.append(f'  {p1[0]} ' + ', '.join(ops)); i += 2; changed = True; continue
            out.append(l0); i += 1
        lines = out
    return lines


def link(fragments, output, runtime=True, kernel=False):
    parts = []
    if runtime and not kernel:
        parts.append((ROOT/'lib/crt0.tas').read_text())
    common = {}
    for i, text in enumerate(fragments):
        text = re.sub(r'(?<![\w.])\.L[\w.]*', lambda m: f'__tu{i}'+m[0], text)
        for name, size, align in re.findall(r'^; COMMON (\S+) (\d+) (\d+)$',text,re.M):
            old=common.get(name,(0,1))
            common[name]=(max(old[0],int(size)),max(old[1],int(align)))
        parts.append(text)
    defined=set(re.findall(r'^([\w.]+):', '\n'.join(parts), re.M))
    for name,(size,align) in sorted(common.items()):
        if name not in defined:
            parts.append(f'.align {align}\n{name}:\n.space {size}\n')
    parts.append('.align 3\n__tri_heap_start:\n.tryte 0\n')
    text='\n'.join(parts)
    if not os.environ.get('TRI27_NOPEEP'):
        text='\n'.join(peephole(text.split('\n')))
    labels=re.findall(r'^([\w.]+):',text,re.M)
    seen=set()
    for label in labels:
        if label in seen:
            raise ValueError('duplicate global definition: '+label)
        seen.add(label)
    Path(output).write_text(text,encoding='utf-8')


def runtime_fragments(kernel=False):
    result=[(ROOT/('lib/khost.tas' if kernel else 'lib/host.tas')).read_text()]
    for name in ('bits','libc'):
        source=ROOT/f'lib/{name}.c'
        output=BUILD/f'{name}.tas'
        deps=[source,ROOT/'chibicc/chibicc',*list((ROOT/'include').glob('*.h'))]
        if not output.exists() or output.stat().st_mtime < max(p.stat().st_mtime for p in deps):
            compile_unit(source,output)
        result.append(output.read_text())
    return result


def compile_link(inputs, output, flags=(), runtime=True, kernel=False):
    build()
    fragments=[]
    for i, source in enumerate(inputs):
        source=Path(source)
        if source.suffix=='.tas':
            fragments.append(source.read_text())
        else:
            obj=BUILD/f'unit{i}.tas'
            compile_unit(source,obj,flags)
            fragments.append(obj.read_text())
    if runtime:
        fragments+=runtime_fragments(kernel)
    link(fragments,output,runtime,kernel)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('inputs',nargs='+')
    p.add_argument('-o',default='a.tas')
    p.add_argument('-S',action='store_true')
    p.add_argument('-E',action='store_true')
    p.add_argument('-I',action='append',default=[])
    p.add_argument('-D',action='append',default=[])
    p.add_argument('--no-runtime',action='store_true')
    p.add_argument('--kernel',action='store_true',help='noyau : pas de crt0, services matériels directs (khost)')
    a=p.parse_args()
    flags=['-I'+str(Path(v).resolve()) for v in a.I]+['-D'+v for v in a.D]
    build()
    if a.S or a.E:
        if len(a.inputs)!=1:
            p.error('-S/-E require one input')
        compile_unit(a.inputs[0],a.o,flags+(['-E'] if a.E else []))
    else:
        compile_link(a.inputs,a.o,flags,not a.no_runtime,a.kernel)

if __name__=='__main__':
    try:
        main()
    except (subprocess.CalledProcessError, ValueError) as e:
        print(e,file=sys.stderr)
        sys.exit(1)
