"""Regression: exact 3FS filesize + single-buffer timage_load beyond old growth limit.
Run after bash os/build.sh. Tests real syscalls under the TRI-27 kernel.
"""
from pathlib import Path
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT/'cc/build/timage-io'
VM = ROOT/('tri27/target/release/tri27.exe' if os.name=='nt' else 'tri27/target/release/tri27')


def main():
    BUILD.mkdir(parents=True,exist_ok=True)
    # A valid 1x1 P6 file with a long legal comment, not a giant decoded bitmap.
    payload=b'P6\n#'+b'x'*700000+b'\n1 1\n255\n'+bytes((12,34,56))
    big=BUILD/'big.ppm';big.write_bytes(payload)
    huge=BUILD/'huge.bin';huge.write_bytes(bytes(1900001))
    empty=BUILD/'empty.bin';empty.write_bytes(b'')
    source=BUILD/'io.c'
    source.write_text(f'''#include <timage.h>
#include <3os.h>
#include <tri27io.h>
#include <stdio.h>
#include <string.h>
int main(void){{
  if(sys_filesize("big.ppm")!={len(payload)}L||sys_filesize("hello")<=0||sys_filesize("empty")!=0){{puts("FAIL filesize");return 1;}}
  puts("PASS filesize exact, empty and program");
  if(sys_filesize("absent")!=-1||sys_filesize((char *)3812798742493L)!=-1){{puts("FAIL filesize invalid");return 2;}}
  puts("PASS filesize missing and pointer bounds");
  TImage im={{0}};int e=timage_load(&im,"big.ppm");unsigned char expected[4]={{12,34,56,255}};
  if(e||im.width!=1||im.height!=1||memcmp(im.rgba,expected,4)){{printf("FAIL single read e=%d\\n",e);return 3;}}
  timage_free(&im);puts("PASS single allocation, source beyond 700000 bytes");
  if(timage_load(&im,"huge")!=TIMAGE_TOO_LARGE||im.rgba||im.width||im.height){{puts("FAIL huge");return 4;}}
  puts("PASS source limit before allocation");
  if(timage_load(&im,"empty")!=TIMAGE_BAD_DATA||timage_load(&im,"absent")!=TIMAGE_NOT_FOUND||im.rgba||im.width||im.height){{puts("FAIL empty/missing");return 5;}}
  puts("PASS empty and missing leave empty output");
  for(;;)wfi();
}}
''',encoding='utf-8')
    program=BUILD/'io.tas';disk=BUILD/'io.t3d'
    subprocess.run([sys.executable,str(ROOT/'cc/tri27cc.py'),str(source),str(ROOT/'cc/lib/timage.c'),str(ROOT/'cc/lib/timage_png.c'),str(ROOT/'cc/lib/timage_io.c'),str(ROOT/'cc/lib/sys.tas'),'-o',str(program)],cwd=ROOT,check=True)
    subprocess.run([str(VM),'mkdisk',str(disk),f'hello={program.as_posix()}',f'big.ppm=bytes:{big.as_posix()}',f'huge=bytes:{huge.as_posix()}',f'empty=bytes:{empty.as_posix()}'],cwd=ROOT,check=True)
    result=subprocess.run([str(VM),'run',str(ROOT/'os/kernel3.tas'),'--disk',str(disk),'--max','70000000'],cwd=ROOT,text=True,capture_output=True,timeout=30)
    print(result.stdout,end='');print(result.stderr,end='')
    passes=[line for line in result.stdout.splitlines() if line.startswith('PASS ')]
    assert result.returncode==0 and len(passes)==5 and 'FAIL ' not in result.stdout
    (BUILD/'report.json').write_text(json.dumps({'passed':passes,'checks':len(passes),'source_bytes':len(payload),'single_buffer':True},indent=2),encoding='utf-8')
    print('PASS native 3FS metadata / image IO 5/5')

if __name__=='__main__':
    main()
