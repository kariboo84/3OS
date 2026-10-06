const { OPCODES, packIndexed } = require('../config');

class Assembler {
    constructor(baseAddress = 0) {
        this.baseAddress = baseAddress | 0;
        this.code = [];
        this.labels = new Map();
        this.fixups = [];
    }

    currentAddress() {
        return (this.baseAddress + this.code.length) | 0;
    }

    emit(op, a = 0, b = 0) {
        this.code.push(op | 0, a | 0, b | 0);
        return this;
    }

    label(name) {
        this.labels.set(name, this.currentAddress());
        return this;
    }

    emitJump(op, target) {
        if (typeof target === 'string') {
            this.fixups.push({ index: this.code.length + 1, label: target });
            return this.emit(op, 0, 0);
        }
        return this.emit(op, target | 0, 0);
    }

    emitValueFixup(op, reg, target) {
        if (typeof target === 'string') {
            this.fixups.push({ index: this.code.length + 2, label: target });
            return this.emit(op, reg, 0);
        }
        return this.emit(op, reg, target | 0);
    }

    movI(reg, val) { return this.emit(OPCODES.MOV_IMM, reg, val); }
    movLabel(reg, label) { return this.emitValueFixup(OPCODES.MOV_IMM, reg, label); }
    movR(dest, src) { return this.emit(OPCODES.MOV_REG, dest, src); }
    load(dest, addrReg) { return this.emit(OPCODES.LOAD, dest, addrReg); }
    store(addrReg, srcReg) { return this.emit(OPCODES.STORE, addrReg, srcReg); }
    loadi(dest, baseReg, offset = 0) { return this.emit(OPCODES.LOADI, dest, packIndexed(baseReg, offset)); }
    storei(srcReg, baseReg, offset = 0) { return this.emit(OPCODES.STOREI, srcReg, packIndexed(baseReg, offset)); }
    lea(dest, baseReg, offset = 0) { return this.emit(OPCODES.LEA, dest, packIndexed(baseReg, offset)); }
    add(dest, src) { return this.emit(OPCODES.ADD, dest, src); }
    sub(dest, src) { return this.emit(OPCODES.SUB, dest, src); }
    mul(dest, src) { return this.emit(OPCODES.MUL, dest, src); }
    div(dest, src) { return this.emit(OPCODES.DIV, dest, src); }
    mod(dest, src) { return this.emit(OPCODES.MOD, dest, src); }
    and(dest, src) { return this.emit(OPCODES.AND, dest, src); }
    or(dest, src) { return this.emit(OPCODES.OR, dest, src); }
    xor(dest, src) { return this.emit(OPCODES.XOR, dest, src); }
    shl(dest, src) { return this.emit(OPCODES.SHL, dest, src); }
    shr(dest, src) { return this.emit(OPCODES.SHR, dest, src); }
    addi(reg, imm) { return this.emit(OPCODES.ADDI, reg, imm); }
    subi(reg, imm) { return this.emit(OPCODES.SUBI, reg, imm); }
    muli(reg, imm) { return this.emit(OPCODES.MULI, reg, imm); }
    divi(reg, imm) { return this.emit(OPCODES.DIVI, reg, imm); }
    modi(reg, imm) { return this.emit(OPCODES.MODI, reg, imm); }
    andi(reg, imm) { return this.emit(OPCODES.ANDI, reg, imm); }
    ori(reg, imm) { return this.emit(OPCODES.ORI, reg, imm); }
    xori(reg, imm) { return this.emit(OPCODES.XORI, reg, imm); }
    not(reg) { return this.emit(OPCODES.NOT, reg, 0); }
    neg(reg) { return this.emit(OPCODES.NEG, reg, 0); }
    inc(reg) { return this.emit(OPCODES.INC, reg, 0); }
    dec(reg) { return this.emit(OPCODES.DEC, reg, 0); }
    cmp(a, b) { return this.emit(OPCODES.CMP, a, b); }
    cmpi(reg, imm) { return this.emit(OPCODES.CMPI, reg, imm); }
    test(a, b) { return this.emit(OPCODES.TEST, a, b); }
    testi(reg, imm) { return this.emit(OPCODES.TESTI, reg, imm); }
    jmp(target) { return this.emitJump(OPCODES.JMP, target); }
    jz(target) { return this.emitJump(OPCODES.JZ, target); }
    jnz(target) { return this.emitJump(OPCODES.JNZ, target); }
    jg(target) { return this.emitJump(OPCODES.JG, target); }
    jl(target) { return this.emitJump(OPCODES.JL, target); }
    jge(target) { return this.emitJump(OPCODES.JGE, target); }
    jle(target) { return this.emitJump(OPCODES.JLE, target); }
    je(target) { return this.jz(target); }
    jne(target) { return this.jnz(target); }
    push(reg) { return this.emit(OPCODES.PUSH, reg, 0); }
    pop(reg) { return this.emit(OPCODES.POP, reg, 0); }
    call(target) { return this.emitJump(OPCODES.CALL, target); }
    callr(reg) { return this.emit(OPCODES.CALLR, reg, 0); }
    jmpr(reg) { return this.emit(OPCODES.JMPR, reg, 0); }
    ret() { return this.emit(OPCODES.RET, 0, 0); }
    syscall(code) { return this.emit(OPCODES.SYSCALL, code, 0); }
    halt() { return this.emit(OPCODES.HALT, 0, 0); }

    resolve() {
        for (const { index, label } of this.fixups) {
            if (!this.labels.has(label)) {
                throw new Error(`Label non défini: ${label}`);
            }
            this.code[index] = this.labels.get(label) | 0;
        }
        return this.code;
    }

    getProgram() {
        return this.resolve().slice();
    }
}

module.exports = Assembler;
