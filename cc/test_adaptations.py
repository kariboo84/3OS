"""Reviewed TRI-27 test adaptations. Original upstream files stay unchanged.
Line numbers refer to pinned UPSTREAM; expected values are architecture facts,
never discovered by running the compiler being tested. Omitted ranges are explicit.
"""
import re

EXPECTED = {
 'alloca':{14:18,15:3,16:18},
 'vla':{4:15,5:288,7:3,8:360,9:36,10:3,12:45,13:9,15:45,16:15},
 'alignof':{12:3,13:3,14:3,15:3,17:3,19:3,22:3,34:3,36:3},
 'arith':{34:1073741824,71:3,72:3,115:3,116:3},
 'attribute':{5:4,9:4,13:7,14:7},
 'decl':{5:3,6:3,7:3,8:3,9:3,11:3,18:1},
 'enum':{13:3,14:3},
 'typedef':{11:3,13:12},
 'typeof':{6:3,7:3,9:9},
 'usualconv':{21:4294967296},
 'struct':{20:3,21:6,22:6,23:9,24:12,25:18,28:6,29:6,31:6,32:6,49:6,50:6,52:6,53:6,55:3,56:3,58:3},
 'variable':{17:3,18:3,19:3,20:12,21:36,22:12,23:3,24:4,25:4,26:3,27:3,37:3,38:12,51:5,54:3,55:3,57:9,58:3},
 'union':{4:6,5:515,6:0,7:0},
 'initializer':{68:12},
 'offsetof':{13:3,14:6,15:9},
 'function':{232:261,233:261,254:1,255:515,256:131077,267:2043,268:2097144,269:2043,270:2097144},
 'constexpr':{9:6,37:6,38:13,39:4},
 'cast':{4:8590066177,5:8590066177,9:1,14:255,15:255,17:65535,19:4294967295,41:65535},
}
# unsigned is modulo 3^27; chars use balanced residues modulo 3^9.
M=3**27

def balanced(x,m=3**9):
    return (x+m//2)%m-m//2

EXPECTED['cast'].update({6:balanced(8590066177),28:(M-1)//2,30:(M-100)//2,31:(M-100)//2,32:(M-1)//100,34:(M-100)%7,35:(M-100)%9})

def trytes(x):
    out=[]
    for _ in range(3):
        r=balanced(x);out.append(r);x=(x-r)//19683
    return out

for line,val in zip((13,14,15),trytes(0xdeadbeef)):
    EXPECTED['union'][line]=val%19683
for line,val in zip((98,99),trytes(0x01020304)):
    EXPECTED['initializer'][line]=val
for line,val in zip((122,123),trytes(0x01020304)):
    EXPECTED['initializer'][line]=val
for line,val in zip((124,125),trytes(0x05060708)):
    EXPECTED['initializer'][line]=val
EXPECTED['initializer'].update({101:4+3*19683+2*19683**2,252:255*19683,254:18*19683**2})

# Every range: start/end inclusive + reason. Full test suites have separate SKIPs.
OMIT = {
 'alignof':[(39,40,'64-bit shifts'),(42,45,'x86 array alignment guarantee')],
 'arith':[(129,131,'64-bit fabricated pointer values'),(137,140,'floating point')],
 'control':[(71,84,'floating point')],
 'macro':[(386,386,'floating point token-paste arithmetic')],
 'varargs':[(16,29,'floating point helper'),(44,46,'floating point varargs')],
 'string':[(44,68,'wide strings')],
 'sizeof':[(85,99,'64-bit shifts and floating point')],
 'cast':[(44,55,'floating point casts')],
 'literal':[(33,59,'64-bit literals/shifts outside target range'),(81,92,'floating point literals')],
 'constexpr':[(3,4,'floating point globals'),(34,36,'x86 narrowing used as array bounds'),(42,46,'binary narrowing and 64-bit shifts'),(50,51,'floating point checks')],
 'function':[(81,88,'replace x86 va_list with TRI-27 stdarg'),(100,109,'floating point functions'),(126,127,'floating point prototypes'),(133,142,'floating point many-args'),(145,145,'floating point aggregate'),(149,149,'floating point aggregate'),(163,169,'floating point aggregate'),(175,175,'floating point aggregate'),(184,186,'floating point aggregate'),(204,210,'floating point conversions'),(272,280,'floating point calls'),(297,300,'floating point calls'),(303,304,'floating point calls'),(311,313,'floating point aggregate'),(328,330,'floating point aggregate'),(337,339,'floating point aggregate'),(360,362,'floating point aggregate'),(382,391,'floating point conversions')],
}
REPLACE = {
 'vla':{18:('sizeof(x)/4','sizeof(x)/3'),19:('sizeof(x)/4','sizeof(x)/3'),20:('sizeof(x)/4','sizeof(x)/3')},
 'alignof':{30:('% 4','% 3'),31:('% 8','% 3')},
 'control':{66:('0xffffffff','-1')},
 'function':{2:('', '#include <stdarg.h>'),96:('*ap = *(__va_elem *)__va_area__;','va_start(ap, fmt);')},
 'offsetof':{8:('double','long')},
 'macro':{340:('strcmp(main_filename1, "test/macro.c")','strcmp(main_filename1+strlen(main_filename1)-7, "macro.c")'),343:('strcmp(include1_filename, "test/include1.h")','strcmp(include1_filename+strlen(include1_filename)-10, "include1.h")'),397:('"test/macro.c"','main_filename1')},
 'union':{8:('} x;', '} x={0};'),16:('} x;', '} x={0};')},
}

def adapt(name,text):
    lines=text.splitlines()
    notes=[]
    expected=dict(EXPECTED.get(name,{}))
    if name=='sizeof':
        # Scalars/pointers are three trytes. Aggregate cases explicitly below.
        for n,line in enumerate(lines,1):
            if re.match(r'\s*ASSERT\((2|4|8), sizeof',line): expected[n]=3
        expected.update({17:12,18:12,19:36,20:6})
    if name=='literal':
        for n,line in enumerate(lines,1):
            if re.match(r'\s*ASSERT\((4|8), sizeof',line):expected[n]=3
        expected[6]=128
        expected.update({76:1,77:1,78:1,79:1,98:3})
    for start,end,reason in OMIT.get(name,[]):
        notes.append(f'lines {start}-{end}: SKIP {reason}')
        for n in range(start,end+1): lines[n-1]=''
    for n,value in expected.items():
        if not lines[n-1]:continue
        new,count=re.subn(r'ASSERT\([^,]+,',f'ASSERT({value},',lines[n-1],count=1)
        if count!=1:raise ValueError(f'{name}:{n}: adaptation no longer matches')
        lines[n-1]=new
    if expected: notes.append('expected sizes/ranges adapted to TRI-27; see EXPECTED')
    for n,(old,new) in REPLACE.get(name,{}).items():
        if old and old not in lines[n-1]:raise ValueError(f'{name}:{n}: replacement no longer matches')
        lines[n-1]=lines[n-1].replace(old,new) if old else new
        notes.append(f'line {n}: {old!r} -> {new!r}')
    if name in ('generic','builtin'):
        lines=[line.replace('100.0','100L').replace('100f','(short)100').replace('double','long').replace('float','short') for line in lines]
        notes.append('type selection: double -> long, float -> short; no arithmetic float claim')
    if name=='union':
        # The fourth tryte is outside the three-tryte word, so initialize it.
        expected[16]=0
        lines[15]=re.sub(r'ASSERT\([^,]+,','ASSERT(0,',lines[15],count=1)
    return '\n'.join(lines)+'\n',notes
