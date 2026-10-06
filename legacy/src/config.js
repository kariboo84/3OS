const OPCODES = Object.freeze({
    NOP: 0,
    MOV_REG: 1,
    MOV_IMM: 2,
    LOAD: 3,
    STORE: 4,
    CMP: 5,
    JMP: 6,
    JZ: 7,
    JNZ: 8,
    JG: 9,
    JL: 10,
    JGE: 11,
    JLE: 12,
    PUSH: 13,
    POP: 14,
    CALL: 15,
    RET: 16,
    HALT: 17,
    ADD: 18,
    SUB: 19,
    MUL: 20,
    DIV: 21,
    MOD: 22,
    AND: 23,
    OR: 24,
    XOR: 25,
    NOT: 26,
    SHL: 27,
    SHR: 28,
    ADDI: 29,
    SUBI: 30,
    MULI: 31,
    DIVI: 32,
    MODI: 33,
    ANDI: 34,
    ORI: 35,
    XORI: 36,
    CMPI: 37,
    TEST: 38,
    TESTI: 39,
    NEG: 40,
    INC: 41,
    DEC: 42,
    LOADI: 43,
    STOREI: 44,
    LEA: 45,
    SYSCALL: 46,
    JMPR: 47,
    CALLR: 48,
});

const REGISTERS = Object.freeze({
    R0: 0, R1: 1, R2: 2, R3: 3,
    R4: 4, R5: 5, R6: 6, R7: 7,
    R8: 8, R9: 9, R10: 10, R11: 11,
    SP: 12, BP: 13, FLAGS: 14, TMP: 15,
});

const REGISTER_NAMES = Object.freeze(Object.fromEntries(
    Object.entries(REGISTERS).map(([name, index]) => [index, name])
));

const SCREEN = Object.freeze({
    WIDTH: 160,
    HEIGHT: 120,
});

const MMIO = Object.freeze({
    INPUT: 0x0000,
    INPUT_X: 0x0001,
    INPUT_Y: 0x0002,
    BOOT_FLAG: 0x0004,
    TICKS_LO: 0x0008,
    TICKS_HI: 0x0009,
    GPU_CMD: 0x000A,
    GPU_ARG0: 0x000B,
    GPU_ARG1: 0x000C,
    GPU_ARG2: 0x000D,
    GPU_ARG3: 0x000E,
    SYSCALL: 0x0010,
    SIN_TABLE: 0x0100,
    COS_TABLE: 0x0268,
    PROGRAM_BASE: 0x0800,
    DATA_BASE: 0x2000,
    HEAP_BASE: 0x4000,
    KEYBOARD: 0xFE00,
    MOUSE: 0xFE10,
    AUDIO_FREQ: 0xFE20,
    AUDIO_DUR: 0xFE21,
    AUDIO_CMD: 0xFE22,
    GPU_BASE: 0xFF00,
});

const GPU_COMMANDS = Object.freeze({
    NONE: 0,
    CLEAR: 1,
    FILL_RECT: 2,
});

const SYSCALLS = Object.freeze({
    NOP: 0,
    CLEAR_SCREEN: 1,
    SAVE_FRAME: 2,
    PLAY_BEEP: 3,
    HOST_IMPORT: 255,
});

const ABI = Object.freeze({
    ARG_REGS: [REGISTERS.R0, REGISTERS.R1, REGISTERS.R2, REGISTERS.R3],
    CALLER_SAVED: [REGISTERS.R0, REGISTERS.R1, REGISTERS.R2, REGISTERS.R3, REGISTERS.R4, REGISTERS.R5, REGISTERS.R6, REGISTERS.R7],
    CALLEE_SAVED: [REGISTERS.R8, REGISTERS.R9, REGISTERS.R10, REGISTERS.R11, REGISTERS.BP],
    RET_REG: REGISTERS.R0,
    STACK_START: 0xEFFF,
    STACK_ALIGN: 1,
});

function packIndexed(baseReg, offset = 0) {
    return ((offset & 0x00FFFFFF) << 8) | (baseReg & 0xFF);
}

function unpackIndexed(value) {
    const base = value & 0xFF;
    let offset = value >> 8;
    if (offset & 0x00800000) offset |= 0xFF000000;
    return { base, offset: offset | 0 };
}

function clamp8(v) {
    return Math.max(0, Math.min(255, v | 0));
}

function tryteToRGB(val) {
    const n = Number.isFinite(val) ? (val | 0) : 0;

    // ARGB / RGB direct path for OS desktop colors.
    if ((n >>> 24) !== 0 || n > 729) {
        return {
            r: (n >>> 16) & 0xFF,
            g: (n >>> 8) & 0xFF,
            b: n & 0xFF,
        };
    }

    if (n <= 0) {
        const g = clamp8(Math.abs(n));
        return { r: g, g, b: g };
    }

    if (n <= 728) {
        const g = clamp8(Math.round((n / 728) * 255));
        return { r: g, g, b: g };
    }

    const bounded = ((n % 729) + 729) % 729;
    const r9 = Math.floor(bounded / 81) % 9;
    const g9 = Math.floor(bounded / 9) % 9;
    const b9 = bounded % 9;
    return {
        r: clamp8(Math.round((r9 / 8) * 255)),
        g: clamp8(Math.round((g9 / 8) * 255)),
        b: clamp8(Math.round((b9 / 8) * 255)),
    };
}

module.exports = {
    ABI,
    GPU_COMMANDS,
    MMIO,
    OPCODES,
    REGISTERS,
    REGISTER_NAMES,
    SCREEN,
    SYSCALLS,
    clamp8,
    packIndexed,
    tryteToRGB,
    unpackIndexed,
};
