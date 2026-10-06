#!/usr/bin/env python3
"""Run every upstream test on the real TRI-27 VM; retain full logs and JSON."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import sys
import tri27cc as cc
from test_adaptations import adapt

SKIP = {

    'atomic': 'atomics/threads not implemented',
    'tls': 'thread-local storage not implemented',
    'float': 'floating point not implemented',
    'bitfield': 'binary bitfield layout not implemented',
    'asm': 'upstream inline assembly is x86-64',
    'stdhdr': 'hosted Linux headers/functions not provided',
    'unicode': 'wide strings/Unicode source encodings not implemented',
}


def prepare_common():
    source=cc.ROOT/'chibicc/test/common'
    lines=source.read_text().splitlines()
    # Remove ONLY floating-point helper functions and Ty5, retaining integer helpers.
    omitted=set(range(44,51))|set(range(56,63))|{65}|set(range(78,85))|set(range(102,105))
    text='\n'.join(line if i not in omitted else '' for i,line in enumerate(lines,1))+'\n'
    dest=cc.BUILD/'common.c'
    dest.write_text(text)
    obj=cc.BUILD/'common.tas'
    cc.compile_unit(dest,obj)
    return obj.read_text()


def main():
    p=argparse.ArgumentParser()
    p.add_argument('names',nargs='*')
    args=p.parse_args()
    cc.build()
    runtime=cc.runtime_fragments()
    common=prepare_common()
    tests=sorted((cc.ROOT/'chibicc/test').glob('*.c'))
    if args.names: tests=[f for f in tests if f.stem in args.names]
    results=[]
    vm=Path(os.environ.get('TRI27_VM',str(cc.REPO/'tri27/target/release/tri27.exe')))
    logs=cc.BUILD/'logs'; logs.mkdir(exist_ok=True)
    for source in tests:
        name=source.stem
        row={'test':name,'status':'FAIL','reason':'','adapted':False}
        if name in SKIP:
            row.update(status='SKIP',reason=SKIP[name])
        else:
            obj=cc.BUILD/f'{name}.unit.tas'
            text,notes=adapt(name,source.read_text())
            row['adapted']=bool(notes)
            row['adaptations']=notes
            if notes:
                adapted=cc.BUILD/'adapted'; adapted.mkdir(exist_ok=True)
                source=adapted/source.name
                source.write_text(text)
            flags=['-I'+str(cc.ROOT/'include'),'-I'+str(cc.ROOT/'chibicc/test'),'-I'+str(cc.ROOT/'chibicc')]
            proc=subprocess.run(cc.host_command([*flags,str(source),'-o',str(obj)]),capture_output=True,text=True,encoding='utf-8',errors='replace')
            log=proc.stdout+proc.stderr
            if proc.returncode:
                row['reason']='compile error'
                if 'floating point is not supported' in log:
                    row.update(status='SKIP',reason='contains floating point (not implemented)')
                if 'bitfields are not supported' in log:
                    row.update(status='SKIP',reason='contains bitfields (not implemented)')
                if 'wide strings are not supported' in log:
                    row.update(status='SKIP',reason='contains wide strings (not implemented)')
            else:
                linked=cc.BUILD/f'{name}.tas'
                try:
                    cc.link([obj.read_text(),common,*runtime],linked)
                    proc=subprocess.run([str(vm),'run',str(linked),'--stats','--max','100000000'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=45)
                    log+=proc.stdout+proc.stderr
                    row['exit_code']=proc.returncode
                    row['assertions_passed']=sum(' => ' in l and 'expected but got' not in l for l in proc.stdout.splitlines())
                    if proc.returncode==0 and 'OK' in proc.stdout and 'exit=0' in proc.stderr:
                        row.update(status='PASS',reason='')
                    else:
                        failures=[l for l in log.splitlines() if 'expected but got' in l or 'Erreur' in l or 'error' in l.lower() or 'piège' in l]
                        row['reason']=failures[-1] if failures else 'VM did not finish successfully'
                except (ValueError,subprocess.TimeoutExpired) as e:
                    log+=str(e);row['reason']=str(e)
            (logs/f'{name}.log').write_text(log,encoding='utf-8')
        results.append(row)
        print(f"{row['status']:4} {name:14} {row['reason']}",flush=True)
        (cc.BUILD/'test-results.json').write_text(json.dumps(results,indent=2))
    counts=Counter(r['status'] for r in results)
    print(dict(counts),'TOTAL',len(results))
    if not args.names and len(results)!=len(list((cc.ROOT/'chibicc/test').glob('*.c'))):
        raise RuntimeError('test inventory mismatch')
    return 1 if counts['FAIL'] else 0

if __name__=='__main__':
    sys.exit(main())
