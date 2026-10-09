"""Native TRI-27 image acceptance: PNG filters/types/Adam7, BMP, PPM,
malformed inputs, byte-preserving 3FS. Pillow is a fixture oracle only.
No host decoder participates in timage or the 3OS image viewer.
Run: python3 tests/timage.py [--assets-only]
"""
from pathlib import Path
import argparse
import json
import os
import struct
import subprocess
import sys
import zlib
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'cc/build/timage'
VM = ROOT / ('tri27/target/release/tri27.exe' if os.name == 'nt' else 'tri27/target/release/tri27')


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def png_data(w, h, depth, kind, raw, extra=b'', interlace=0):
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, depth, kind, 0, 0, interlace)) + extra + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def paeth(a, b, c):
    p = a + b - c
    return min(((abs(p-a), 0, a), (abs(p-b), 1, b), (abs(p-c), 2, c)))[2]


def filtered(rows, bpp, filter_type):
    out = bytearray()
    prior = bytes(len(rows[0]))
    for row in rows:
        out.append(filter_type)
        for i, v in enumerate(row):
            left = row[i-bpp] if i >= bpp else 0
            up = prior[i]
            corner = prior[i-bpp] if i >= bpp else 0
            p = (0, left, up, (left+up)//2, paeth(left, up, corner))[filter_type]
            out.append((v-p) % 256)
        prior = row
    return bytes(out)


def pack(values, bits):
    out = bytearray((len(values)*bits+7)//8)
    for i, v in enumerate(values):
        out[i*bits//8] |= v << (8-bits-i*bits%8)
    return bytes(out)


def fixture_cases():
    cases = []
    w, h = 13, 7
    rgba = bytes((x*47+y*83+c*61) % 256 for y in range(h) for x in range(w) for c in range(4))
    rows = [rgba[y*w*4:(y+1)*w*4] for y in range(h)]
    for f in range(5):
        cases.append((f'png_filter_{f}', png_data(w, h, 8, 6, filtered(rows, 4, f)), rgba, w, h))
    passes = ((0,0,8,8), (4,0,8,8), (0,4,4,8), (2,0,4,4), (0,2,2,4), (1,0,2,2), (0,1,1,2))
    raw = b''
    for x0, y0, dx, dy in passes:
        pass_rows = [b''.join(rgba[4*(y*w+x):4*(y*w+x)+4] for x in range(x0,w,dx)) for y in range(y0,h,dy)]
        if pass_rows and pass_rows[0]:
            raw += filtered(pass_rows, 4, 4)
    cases.append(('png_adam7', png_data(w, h, 8, 6, raw, interlace=1), rgba, w, h))
    for bits in (1, 2, 4, 8):
        size = 2**bits
        palette = bytes((i*43+c*97) % 256 for i in range(size) for c in range(3))
        alpha = bytes((i*73) % 256 for i in range(size))
        indices = [(x+y*3) % size for y in range(h) for x in range(w)]
        raw = b''.join(b'\0'+pack(indices[y*w:(y+1)*w], bits) for y in range(h))
        expected = b''.join(palette[3*i:3*i+3]+alpha[i:i+1] for i in indices)
        cases.append((f'png_palette_{bits}', png_data(w,h,bits,3,raw,chunk(b'PLTE',palette)+chunk(b'tRNS',alpha)), expected,w,h))
    for kind, channels, bits in ((0,1,8), (0,1,16), (2,3,8), (2,3,16), (4,2,8), (4,2,16), (6,4,16)):
        values = [(i*713+123) % (2**bits) for i in range(w*h*channels)]
        raw_bytes = b''.join(v.to_bytes(bits//8,'big') for v in values)
        rowlen = w*channels*(bits//8)
        raw = filtered([raw_bytes[y*rowlen:(y+1)*rowlen] for y in range(h)],channels*(bits//8),3)
        eight = [v >> (bits-8) for v in values]
        expected = bytearray()
        for i in range(w*h):
            v = eight[i*channels:(i+1)*channels]
            expected += bytes((v[0],v[0],v[0],v[1] if channels==2 else 255) if kind in (0,4) else (*v[:3],v[3] if channels==4 else 255))
        cases.append((f'png_type_{kind}_{bits}', png_data(w,h,bits,kind,raw), bytes(expected),w,h))
    for bits in (1,2,4):
        values = [(x+3*y) % (2**bits) for y in range(h) for x in range(w)]
        raw = b''.join(b'\0'+pack(values[y*w:(y+1)*w],bits) for y in range(h))
        expected = b''.join(bytes([v*255//(2**bits-1)]*3+[255]) for v in values)
        cases.append((f'png_gray_{bits}',png_data(w,h,bits,0,raw),expected,w,h))
    w, h = 5, 3
    rgb = bytes((i*37) % 256 for i in range(w*h*3))
    expected = b''.join(rgb[3*i:3*i+3]+b'\xff' for i in range(w*h))
    for bits, top in ((24,False),(32,True)):
        stride = (w*(bits//8)+3)//4*4
        payload = bytearray()
        for y in (range(h) if top else range(h-1,-1,-1)):
            row = b''.join(rgb[(y*w+x)*3:(y*w+x)*3+3][::-1]+(b'\0' if bits==32 else b'') for x in range(w))
            payload += row+bytes(stride-len(row))
        header = b'BM'+struct.pack('<IHHI',54+len(payload),0,0,54)+struct.pack('<IiiHHIIiiII',40,w,-h if top else h,1,bits,0,len(payload),0,0,0,0)
        cases.append((f'bmp_{bits}',header+payload,expected,w,h))
    ppm = b'P6\n# comment\n5 3\n255\n'+rgb
    cases.append(('ppm_p6',ppm,expected,w,h))
    data = bytes((10,32,13,32,10,13))
    cases.append(('ppm_whitespace_pixels',b'P6\n2 1\n255\n'+data,b''.join(data[i:i+3]+b'\xff' for i in (0,3)),2,1))
    vals = [i % 16 for i in range(w*h*3)]
    expected = b''.join(bytes([v*17 for v in vals[3*i:3*i+3]]+[255]) for i in range(w*h))
    cases.append(('ppm_p3',b'P3\n# P3 max 15\n5 3\n15\n'+(' '.join(map(str,vals))+'\n').encode(),expected,w,h))
    return cases


def assets():
    dest = ROOT/'os/assets'
    dest.mkdir(exist_ok=True)
    image = Image.new('RGBA',(384,216))
    draw = ImageDraw.Draw(image)
    for y in range(216):
        draw.line((0,y,383,y),fill=(36+y//4,74+y//3,145+y//3,255))
    draw.ellipse((262,24,320,82),fill=(255,212,87,220))
    draw.polygon(((0,163),(87,48),(191,167)),fill=(137,128,197,255))
    draw.polygon(((99,176),(231,69),(384,170)),fill=(80,94,155,255))
    draw.polygon(((0,161),(135,133),(220,185),(384,142),(384,216),(0,216)),fill=(41,126,102,255))
    draw.polygon(((183,167),(218,168),(340,216),(250,216)),fill=(103,185,223,255))
    # Transparent corners demonstrate native alpha compositing over the viewer grid.
    draw.rectangle((0,0,15,15),fill=(255,255,255,0))
    image.save(dest/'demo.png')
    image.convert('RGB').save(dest/'demo.bmp')
    image.convert('RGB').save(dest/'demo.ppm')
    return image


def emit_test(cases):
    code = ['#include <timage.h>','#include <stdio.h>','#include <string.h>']
    for i, (_,data,expected,_,_) in enumerate(cases):
        code += [f'static unsigned char in_{i}[]={{'+','.join(map(str,data))+'};', f'static unsigned char expected_{i}[]={{'+','.join(map(str,expected))+'};']
    negatives = [('unknown',b'JPEGnotimplemented',2),('truncated_png',cases[0][1][:50],5),('truncated_bmp',b'BM'+bytes(10),1),('truncated_ppm',b'P6\n2 2\n255\n\0',1),('oversized',png_data(100000,100000,8,6,b'\0'),3),('inflate_overrun',png_data(1,1,8,6,b'\0'*20000),5)]
    bad = bytearray(cases[0][1]);bad[-15] ^= 1
    negatives.append(('bad_crc',bytes(bad),5))
    for i,(_,data,_) in enumerate(negatives):
        code.append(f'static unsigned char bad_{i}[]={{'+','.join(map(str,data))+'};')
    code.append('int main(void){TImage im={0};int err;')
    for i,(name,_,expected,w,h) in enumerate(cases):
        code.append(f'err=timage_decode(&im,in_{i},sizeof(in_{i}));if(err||im.width!={w}||im.height!={h}||memcmp(im.rgba,expected_{i},sizeof(expected_{i}))){{printf("FAIL {name} err=%d w=%u h=%u\\n",err,im.width,im.height);if(im.rgba)for(size_t j=0;j<sizeof(expected_{i});j++)if(im.rgba[j]!=expected_{i}[j]){{printf("mismatch component %ld got=%d expected=%d\\n",j,im.rgba[j],expected_{i}[j]);break;}}return {i+1};}}timage_free(&im);printf("PASS {name}\\n");')
    for i,(name,_,expected) in enumerate(negatives):
        code.append(f'err=timage_decode(&im,bad_{i},sizeof(bad_{i}));if(err!={expected}||im.rgba||im.width||im.height){{printf("FAIL {name} err=%d\\n",err);return 90;}}printf("PASS {name}\\n");')
    code.append('unsigned char invalid[4]={9841,0,0,0};if(timage_decode(&im,invalid,4)!=1)return 91;invalid[0]=-1;if(timage_decode(&im,invalid,4)!=1)return 92;printf("PASS non_octet_trytes\\n");')
    # Explicit, independently computed alpha/quantization checks for all depths.
    for depth in (1,9,27):
        p = (245,30,70,127);bg=(30,80,140)
        v=[(p[i]*p[3]+bg[i]*(255-p[3])+127)//255 for i in range(3)]
        if depth==1:
            expected=(((54*v[0]+183*v[1]+19*v[2]+128)//256)*2+127)//255-1
        else:
            base=27 if depth==9 else 19683
            q=[(t*(base-1)+127)//255-(base-1)//2 for t in v]
            expected=q[2]+q[1]*base+q[0]*base*base
        code.append(f'{{unsigned char p[4]={{245,30,70,127}};if(timage_color(p,{depth},{bg[0]*65536+bg[1]*256+bg[2]}L)!={expected}L)return 93;}}printf("PASS alpha_depth_{depth}\\n");')
    code.append('return 0;}')
    BUILD.mkdir(parents=True,exist_ok=True)
    source=BUILD/'fixtures.c';source.write_text('\n'.join(code),encoding='utf-8')
    return source,len(cases)+len(negatives)+4


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--assets-only',action='store_true');args=parser.parse_args()
    assets()
    if args.assets_only:
        print('Assets PNG/BMP/PPM generated');return
    cases=fixture_cases()
    for name,data,expected,w,h in cases:
        path=BUILD/(name+'.png' if name.startswith('png') else name+'.bin');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        with Image.open(path) as decoded:
            # BMP BI_RGB alpha is unspecified: 32-bit fixture intentionally contains zeros.
            actual=decoded.convert('RGB' if name.startswith('bmp') else 'RGBA')
            if name=='png_type_0_16':
                gray=bytes(int(v)>>8 for v in decoded.get_flattened_data())
                actual=Image.frombytes('L',(w,h),gray).convert('RGBA')
            assert actual.size==(w,h),name
            exp=Image.frombytes('RGBA',(w,h),expected)
            assert actual.tobytes()==(exp.convert('RGB').tobytes() if name.startswith('bmp') else expected),name
    source,total=emit_test(cases)
    subprocess.run([sys.executable,str(ROOT/'cc/tri27cc.py'),str(source),str(ROOT/'cc/lib/timage.c'),str(ROOT/'cc/lib/timage_png.c'),'-o',str(BUILD/'fixtures.tas')],cwd=ROOT,check=True)
    result=subprocess.run([str(VM),'run',str(BUILD/'fixtures.tas'),'--max','500000000','--stats'],cwd=ROOT,text=True,capture_output=True)
    print(result.stdout,end='');print(result.stderr,end='')
    passed=[line for line in result.stdout.splitlines() if line.startswith('PASS ')]
    if result.returncode or len(passed)!=total:
        raise RuntimeError(f'native image verification failed: {len(passed)}/{total}, exit {result.returncode}')
    # Every octet, including NUL, high bytes and invalid UTF-8, survives mkdisk.
    payload=bytes(range(256))*3;binary=BUILD/'octets.bin';binary.write_bytes(payload)
    disk=BUILD/'octets.t3d'
    subprocess.run([str(VM),'mkdisk',str(disk),f'octets=bytes:{binary.as_posix()}'],cwd=ROOT,check=True)
    trytes=struct.unpack('<'+'h'*(disk.stat().st_size//2),disk.read_bytes())
    word=lambda p:trytes[p]+19683*trytes[p+1]+387420489*trytes[p+2]
    start=word(22)*729;length=word(25)
    assert length==len(payload) and bytes(trytes[start:start+length])==payload
    report={'native_checks':total,'formats':['PNG','BMP','PPM'],'passed':passed,'binary_disk_octets':length,'host_oracle':'Pillow fixtures only; native decoder executed in TRI-27'}
    (BUILD/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(f'PASS timage {total}/{total}; 3FS {length} octets exacts')

if __name__=='__main__':
    main()
