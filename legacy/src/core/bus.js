const { SIN_TABLE, COS_TABLE } = require('./math_rom');

class TNA_Bus {
  constructor(memorySize = 65536) {
    this.ram = new Int32Array(memorySize | 0);
    this.devices = [];
    this.hostApi = null;
  }

  attachDevice(device) {
    this.devices.push(device);
  }

  setHostApi(hostApi) {
    this.hostApi = hostApi || null;
  }

  invokeHostImport(id, cpu) {
    if (!this.hostApi || typeof this.hostApi.invokeImport !== 'function') return 0;
    return this.hostApi.invokeImport(id | 0, cpu, this) | 0;
  }

  read(address) {
    const addr = address | 0;
    if (addr >= 0x0100 && addr < 0x0268) return SIN_TABLE[addr - 0x0100] | 0;
    if (addr >= 0x0268 && addr < 0x03D0) return COS_TABLE[addr - 0x0268] | 0;

    for (const dev of this.devices) {
      if (dev.handles(addr)) return dev.read(addr) | 0;
    }
    return this.ram[addr] | 0;
  }

  write(address, value) {
    const addr = address | 0;
    for (const dev of this.devices) {
      if (dev.handles(addr)) {
        dev.write(addr, value | 0);
        return;
      }
    }
    this.ram[addr] = value | 0;
  }
}

module.exports = TNA_Bus;
