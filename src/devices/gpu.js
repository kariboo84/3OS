const fs = require('fs');
const { tryteToRGB } = require('../config');

class TNA_GPU {
    constructor(startAddr = 0xFF00, width = 160, height = 120) {
        this.startAddr = startAddr;
        this.width = width;
        this.height = height;
        this.frameBuffer = new Int32Array(width * height);
        this.endAddr = startAddr + (width * height);
    }

    handles(address) {
        return address >= this.startAddr && address < this.endAddr;
    }

    write(address, value) {
        const idx = address - this.startAddr;
        if (idx >= 0 && idx < this.frameBuffer.length) {
            this.frameBuffer[idx] = value | 0;
        }
    }

    read(address) {
        const idx = address - this.startAddr;
        if (idx >= 0 && idx < this.frameBuffer.length) {
            return this.frameBuffer[idx] | 0;
        }
        return 0;
    }

    clear(value = 0) {
        this.frameBuffer.fill(value | 0);
    }

    saveImage(filename = 'doom_render.ppm') {
        let header = `P3\n${this.width} ${this.height}\n255\n`;
        let body = '';

        for (let y = 0; y < this.height; y++) {
            let row = '';
            for (let x = 0; x < this.width; x++) {
                const val = this.frameBuffer[y * this.width + x];
                const rgb = tryteToRGB(val);
                row += `${rgb.r} ${rgb.g} ${rgb.b}  `;
            }
            body += row.trim() + '\n';
        }

        fs.writeFileSync(filename, header + body);
        console.log(`Image générée : ${filename}`);
    }
}
module.exports = TNA_GPU;
