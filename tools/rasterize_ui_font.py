"""IBM Plex Sans/Mono OFL : couverture 27 niveaux et métriques proportionnelles.
Usage : python3 tools/rasterize_ui_font.py sans.ttf mono.ttf ui_font.h
Trois couvertures de 3 trits sont empaquetées dans chaque tryte équilibré.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

CELL = 20
SIZES = (9, 14, 16)

def generate(paths, out):
    faces, advances, edge_values = [], [], set()
    for path in paths:
        face, adv = [], []
        for size in SIZES:
            font = ImageFont.truetype(str(path), size * 4)
            try:
                font.set_variation_by_axes([400, 100])
            except OSError:
                pass  # Mono est une fonte statique.
            glyphs, widths = [], []
            for c in range(32, 127):
                im = Image.new('L', (CELL * 4, CELL * 4))
                ImageDraw.Draw(im).text((4, -size // 2), chr(c), font=font, fill=255)
                im = im.resize((CELL, CELL), Image.Resampling.LANCZOS)
                alpha = [(v * 26 + 127) // 255 for v in im.getdata()]
                edge_values.update(alpha)
                width = max(1, round(font.getlength(chr(c)) / 4) + 1)
                box = im.getbbox()
                if box:
                    width = max(width, box[2])
                assert width <= CELL, (c, size, width)
                widths.append(width)
                packed = []
                for x in range(CELL):
                    for y in range(0, CELL, 3):
                        values = [alpha[(y + i) * CELL + x] if y + i < CELL else 0 for i in range(3)]
                        value = sum((v - 13) * 27 ** i for i, v in enumerate(values))
                        assert -9841 <= value <= 9841
                        for i, v in enumerate(values):
                            assert (value + 9841) // (27 ** i) % 27 == v
                        packed.append(value)
                glyphs.append(packed)
            if len(faces) == 1:
                widths = [max(widths)] * len(widths)
            face.append(glyphs)
            adv.append(widths)
        faces.append(face)
        advances.append(adv)
    assert len(edge_values) == 27, edge_values
    def array(v):
        if not isinstance(v[0], list):
            return '{' + ','.join(map(str, v)) + '}'
        return '{\n' + ',\n'.join(array(x) for x in v) + '\n}'
    text = '/* IBM Plex Sans/Mono, SIL OFL : ui_sans_OFL.txt + ui_font_OFL.txt.\n * 27 couvertures par pixel, 3 pixels par tryte ; ne pas seuiller. */\n'
    text += '#ifndef UI_FONT_H\n#define UI_FONT_H\n#define UI_CELL 20\n'
    text += 'static const char UI_ADV[2][3][95] = ' + array(advances) + ';\n'
    text += 'static const char UI_ALPHA[2][3][95][140] = ' + array(faces) + ';\n#endif\n'
    Path(out).write_text(text, encoding='utf-8', newline='\n')
    print('2 familles, 3 tailles, 95 glyphes chacune ; 27 couvertures ; empaquetage verifie')

if __name__ == '__main__':
    generate(sys.argv[1:3], sys.argv[3])
