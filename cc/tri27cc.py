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


def link(fragments, output, runtime=True):
    parts = []
    if runtime:
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
    labels=re.findall(r'^([\w.]+):',text,re.M)
    seen=set()
    for label in labels:
        if label in seen:
            raise ValueError('duplicate global definition: '+label)
        seen.add(label)
    Path(output).write_text(text,encoding='utf-8')


def runtime_fragments():
    result=[(ROOT/'lib/host.tas').read_text()]
    for name in ('bits','libc'):
        source=ROOT/f'lib/{name}.c'
        output=BUILD/f'{name}.tas'
        deps=[source,ROOT/'chibicc/chibicc',*list((ROOT/'include').glob('*.h'))]
        if not output.exists() or output.stat().st_mtime < max(p.stat().st_mtime for p in deps):
            compile_unit(source,output)
        result.append(output.read_text())
    return result


def compile_link(inputs, output, flags=(), runtime=True):
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
        fragments+=runtime_fragments()
    link(fragments,output,runtime)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('inputs',nargs='+')
    p.add_argument('-o',default='a.tas')
    p.add_argument('-S',action='store_true')
    p.add_argument('-E',action='store_true')
    p.add_argument('-I',action='append',default=[])
    p.add_argument('-D',action='append',default=[])
    p.add_argument('--no-runtime',action='store_true')
    a=p.parse_args()
    flags=['-I'+str(Path(v).resolve()) for v in a.I]+['-D'+v for v in a.D]
    build()
    if a.S or a.E:
        if len(a.inputs)!=1:
            p.error('-S/-E require one input')
        compile_unit(a.inputs[0],a.o,flags+(['-E'] if a.E else []))
    else:
        compile_link(a.inputs,a.o,flags,not a.no_runtime)

if __name__=='__main__':
    try:
        main()
    except (subprocess.CalledProcessError, ValueError) as e:
        print(e,file=sys.stderr)
        sys.exit(1)
