const { ABI, MMIO, OPCODES, REGISTERS, SYSCALLS, unpackIndexed } = require('../config');

class TNA_CPU {
    constructor() {
        this.PC = 0;
        this.SP = ABI.STACK_START;
        this.REG = new Int32Array(16);
        this.REG[REGISTERS.SP] = this.SP;
        this.REG[REGISTERS.BP] = this.SP;
        this.FLAGS = { Z: false, N: false, G: false, L: false };
        this.bus = null;
        this.halted = false;
    }

    connectBus(bus) {
        this.bus = bus;
    }

    memRead(addr) {
        return this.bus.read(addr | 0) | 0;
    }

    memWrite(addr, val) {
        this.bus.write(addr | 0, val | 0);
    }

    setPC(value) {
        this.PC = value | 0;
    }

    reset(startPC = 0) {
        this.PC = startPC | 0;
        this.SP = ABI.STACK_START;
        this.REG.fill(0);
        this.REG[REGISTERS.SP] = this.SP;
        this.REG[REGISTERS.BP] = this.SP;
        this.halted = false;
        this.updateFlags(0);
    }

    step() {
        if (this.halted) return;
        const op = this.memRead(this.PC++);
        const a = this.memRead(this.PC++);
        const b = this.memRead(this.PC++);
        this.execute(op, a, b);
    }

    execute(op, a, b) {
        const getR = (i) => this.REG[i] | 0;
        const setR = (i, v, updateFlags = true) => {
            this.REG[i] = v | 0;
            if (i === REGISTERS.SP) this.SP = this.REG[i] | 0;
            if (updateFlags) this.updateFlags(this.REG[i] | 0);
        };
        const withImm = (fn) => fn(a | 0, b | 0);
        const jump = (condition) => {
            if (condition) this.PC = a | 0;
        };
        const push = (value) => {
            this.memWrite(this.SP, value | 0);
            this.SP = (this.SP - 1) | 0;
            this.REG[REGISTERS.SP] = this.SP;
        };
        const pop = () => {
            this.SP = (this.SP + 1) | 0;
            this.REG[REGISTERS.SP] = this.SP;
            return this.memRead(this.SP);
        };
        const indexedAddress = () => {
            const { base, offset } = unpackIndexed(b);
            return (getR(base) + offset) | 0;
        };

        switch (op) {
            case OPCODES.NOP: break;
            case OPCODES.MOV_REG: setR(a, getR(b)); break;
            case OPCODES.MOV_IMM: setR(a, b); break;
            case OPCODES.LOAD: setR(a, this.memRead(getR(b))); break;
            case OPCODES.STORE: this.memWrite(getR(a), getR(b)); break;
            case OPCODES.LOADI: setR(a, this.memRead(indexedAddress())); break;
            case OPCODES.STOREI: this.memWrite(indexedAddress(), getR(a)); break;
            case OPCODES.LEA: setR(a, indexedAddress(), false); break;
            case OPCODES.ADD: setR(a, getR(a) + getR(b)); break;
            case OPCODES.SUB: setR(a, getR(a) - getR(b)); break;
            case OPCODES.MUL: setR(a, Math.imul(getR(a), getR(b))); break;
            case OPCODES.DIV: {
                const divisor = getR(b);
                setR(a, divisor === 0 ? 0 : Math.trunc(getR(a) / divisor));
                break;
            }
            case OPCODES.MOD: {
                const divisor = getR(b);
                setR(a, divisor === 0 ? 0 : (getR(a) % divisor));
                break;
            }
            case OPCODES.AND: setR(a, getR(a) & getR(b)); break;
            case OPCODES.OR: setR(a, getR(a) | getR(b)); break;
            case OPCODES.XOR: setR(a, getR(a) ^ getR(b)); break;
            case OPCODES.NOT: setR(a, ~getR(a)); break;
            case OPCODES.SHL: setR(a, getR(a) << (getR(b) & 31)); break;
            case OPCODES.SHR: setR(a, getR(a) >> (getR(b) & 31)); break;
            case OPCODES.ADDI: withImm((r, imm) => setR(r, getR(r) + imm)); break;
            case OPCODES.SUBI: withImm((r, imm) => setR(r, getR(r) - imm)); break;
            case OPCODES.MULI: withImm((r, imm) => setR(r, Math.imul(getR(r), imm))); break;
            case OPCODES.DIVI: withImm((r, imm) => setR(r, imm === 0 ? 0 : Math.trunc(getR(r) / imm))); break;
            case OPCODES.MODI: withImm((r, imm) => setR(r, imm === 0 ? 0 : (getR(r) % imm))); break;
            case OPCODES.ANDI: withImm((r, imm) => setR(r, getR(r) & imm)); break;
            case OPCODES.ORI: withImm((r, imm) => setR(r, getR(r) | imm)); break;
            case OPCODES.XORI: withImm((r, imm) => setR(r, getR(r) ^ imm)); break;
            case OPCODES.NEG: setR(a, -getR(a)); break;
            case OPCODES.INC: setR(a, getR(a) + 1); break;
            case OPCODES.DEC: setR(a, getR(a) - 1); break;
            case OPCODES.CMP: this.compare(getR(a), getR(b)); break;
            case OPCODES.CMPI: this.compare(getR(a), b | 0); break;
            case OPCODES.TEST: this.test(getR(a) & getR(b)); break;
            case OPCODES.TESTI: this.test(getR(a) & (b | 0)); break;
            case OPCODES.JMP: this.PC = a | 0; break;
            case OPCODES.JZ: jump(this.FLAGS.Z); break;
            case OPCODES.JNZ: jump(!this.FLAGS.Z); break;
            case OPCODES.JG: jump(this.FLAGS.G); break;
            case OPCODES.JL: jump(this.FLAGS.L); break;
            case OPCODES.JGE: jump(this.FLAGS.G || this.FLAGS.Z); break;
            case OPCODES.JLE: jump(this.FLAGS.L || this.FLAGS.Z); break;
            case OPCODES.PUSH: push(getR(a)); break;
            case OPCODES.POP: setR(a, pop()); break;
            case OPCODES.CALL: push(this.PC); this.PC = a | 0; break;
            case OPCODES.JMPR: this.PC = getR(a); break;
            case OPCODES.CALLR: push(this.PC); this.PC = getR(a); break;
            case OPCODES.RET: this.PC = pop(); break;
            case OPCODES.SYSCALL: this.handleSyscall(a | 0, getR, setR); break;
            case OPCODES.HALT: this.halted = true; break;
            default:
                console.error(`[CPU] Opcode inconnu: ${op} @PC=${this.PC - 3}`);
                this.halted = true;
        }
    }

    compare(lhs, rhs) {
        const result = (lhs - rhs) | 0;
        this.updateFlags(result);
        this.FLAGS.G = lhs > rhs;
        this.FLAGS.L = lhs < rhs;
    }

    test(value) {
        this.FLAGS.Z = ((value | 0) === 0);
        this.FLAGS.N = ((value | 0) < 0);
        this.FLAGS.G = false;
        this.FLAGS.L = false;
    }

    updateFlags(val) {
        const v = val | 0;
        this.FLAGS.Z = (v === 0);
        this.FLAGS.N = (v < 0);
        if (v === 0) {
            this.FLAGS.G = false;
            this.FLAGS.L = false;
        }
    }

    handleSyscall(code, getR) {
        switch (code) {
            case SYSCALLS.NOP:
                break;
            case SYSCALLS.CLEAR_SCREEN:
                this.memWrite(MMIO.GPU_CMD, 1);
                this.memWrite(MMIO.GPU_ARG0, getR(REGISTERS.R0));
                break;
            case SYSCALLS.SAVE_FRAME:
                this.memWrite(MMIO.GPU_CMD, 3);
                break;
            case SYSCALLS.PLAY_BEEP:
                this.memWrite(MMIO.AUDIO_FREQ, getR(REGISTERS.R0));
                this.memWrite(MMIO.AUDIO_DUR, getR(REGISTERS.R1));
                this.memWrite(MMIO.AUDIO_CMD, 1);
                break;
            case SYSCALLS.HOST_IMPORT: {
                const result = this.bus && typeof this.bus.invokeHostImport === 'function'
                    ? this.bus.invokeHostImport(getR(REGISTERS.TMP), this)
                    : 0;
                this.REG[REGISTERS.R0] = result | 0;
                this.updateFlags(result | 0);
                break;
            }
            default:
                this.memWrite(MMIO.SYSCALL, code | 0);
                break;
        }
    }
}

module.exports = TNA_CPU;
