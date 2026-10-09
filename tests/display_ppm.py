"""Captures CLI réelles : profondeur figée au PRESENT, PPM 8/16 bits."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
build = root / "cc/build/display_ppm"
build.mkdir(parents=True, exist_ok=True)
vm = root / "tri27/target/release/tri27.exe"
for depth in (1, 9, 27):
    dest = build / str(depth)
    dest.mkdir(exist_ok=True)
    for old in dest.glob("frame_*.ppm"):
        old.unlink()
    src = build / f"depth_{depth}.tas"
    src.write_text(f"""li t0,3
stw t0,-9(zero)
li t0,16
stw t0,-14(zero)
stw t0,-15(zero)
li t0,{depth}
stw t0,-16(zero)
li t0,1000
stw t0,-5(zero)
li t1,9841
stt t1,0(t0)
stt t1,1(t0)
stt t1,2(t0)
stw zero,-6(zero)
li t1,{9 if depth == 27 else 27}
stw t1,-16(zero)
halt
""", encoding="utf-8")
    subprocess.run([str(vm), "run", str(src), "--ppm", str(dest)], check=True, capture_output=True)
    files = sorted(dest.glob("frame_*.ppm"))
    assert files, depth
    for p in files:
        magic, dims, maxval, data = p.read_bytes().split(b"\n", 3)
        assert magic == b"P6" and dims == b"16 16"
        expected = 65535 if depth == 27 else 255
        assert int(maxval) == expected, (depth, p, maxval)
        assert len(data) == 16 * 16 * 3 * (2 if depth == 27 else 1)
        assert data[:6 if depth == 27 else 3] == b"\xff" * (6 if depth == 27 else 3)
    print(f"PASS PPM profondeur {depth} : {expected}, image figée")
