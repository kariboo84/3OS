#!/usr/bin/env node
/**
 * patch_linker_stubs.js
 *
 * Corrige le bug de linker : les 44 fonctions déjà compilées en TNA
 * mais dont les stubs JMP pointent encore vers les trampolines HOST_IMPORT.
 *
 * Pour chaque stub dans unresolvedImportSites où la fonction est aussi
 * dans exportedFunctions, on remplace le JMP destination :
 *   JMP <trampoline_addr>  ->  JMP <tna_export_addr>
 *
 * Usage:
 *   node tools/patch_linker_stubs.js [input.tna] [output.tna]
 *   node tools/patch_linker_stubs.js   # defaults: build/wolf3d_historical_official.tna -> build/wolf3d_patched.tna
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Host overrides: functions compiled in TNA but whose TNA implementation
// ── relies on DOS far-pointer memory model — must stay as HOST bridges.
// ── The host_runtime.js implementations handle these correctly.
const HOST_OVERRIDES = new Set([
  // Memory manager — uses DOS heap/far-ptr model internally (MM_GetPtr has goto/retry)
  'MM_Startup', 'MM_Shutdown', 'MM_GetPtr', 'MM_FreePtr', 'MM_SetPurge',
  'MM_SetLock', 'MM_SortMem', 'MM_UnusedMemory', 'MM_TotalFree', 'MM_BombOnError',
  'MML_UseSpace',
  // Page manager — calls MM_GetPtr 100x in a loop + XMS/EMS stubs that hang
  'PM_Startup', 'PM_Shutdown', 'PM_GetPage', 'PM_GetPageAddress',
  'PM_Preload', 'PM_Reset', 'PM_SetPageLock', 'PM_NextFrame', 'PM_CheckMainMem',
  // VGA planar / far-pointer pixel routines — use DOS seg:off addressing internally
  // These loop over 320×200 pixel buffers via far pointers → infinite in TNA flat memory
  // host_runtime.js has MMIO framebuffer implementations for all of these
  'VL_MemToScreen', 'VL_MaskedToScreen', 'VL_LatchToScreen', 'VL_MemToLatch',
  'VL_DePlaneVGA',
]);
const [,, inArg, outArg] = process.argv;
const ROOT    = path.resolve(__dirname, '..');
const inFile  = inArg  ? path.resolve(inArg)  : path.join(ROOT, 'build', 'wolf3d_historical_official.tna');
const outFile = outArg ? path.resolve(outArg) : path.join(ROOT, 'build', 'wolf3d_patched.tna');

console.log('Input :', inFile);
console.log('Output:', outFile);

// ── Read TNA0 binary ──────────────────────────────────────────────────────────
const buf = Buffer.from(fs.readFileSync(inFile)); // mutable copy

const magic = buf.slice(0, 4).toString();
if (magic !== 'TNA0') throw new Error(`Not a TNA0 file (got "${magic}")`);

const version   = buf.readInt32LE(4);
const entry     = buf.readInt32LE(8);
const textBase  = buf.readInt32LE(12);
const textWords = buf.readInt32LE(16);
const dataBase  = buf.readInt32LE(20);
const dataWords = buf.readInt32LE(24);

const META_LEN_OFFSET = 28;
const abiLen  = buf.readInt32LE(META_LEN_OFFSET);
const metaLen = buf.readInt32LE(META_LEN_OFFSET + 4);
const headerEnd = META_LEN_OFFSET + 8 + abiLen + metaLen;

const abiStr  = buf.slice(META_LEN_OFFSET + 8, META_LEN_OFFSET + 8 + abiLen).toString('utf8');
const metaStr = buf.slice(META_LEN_OFFSET + 8 + abiLen, headerEnd).toString('utf8');
const meta    = JSON.parse(metaStr);

console.log(`\nTNA0 v${version}  ABI=${abiStr}  entry=0x${entry.toString(16)}`);
console.log(`text: base=0x${textBase.toString(16)} words=${textWords}`);
console.log(`data: base=0x${dataBase.toString(16)} words=${dataWords}`);

// ── Locate .text in file ──────────────────────────────────────────────────────
const TEXT_FILE_OFFSET = headerEnd; // .text starts right after JSON meta

function readWord(addr) {
  const idx     = addr - textBase;
  const fileOff = TEXT_FILE_OFFSET + idx * 4;
  return buf.readInt32LE(fileOff);
}
function writeWord(addr, value) {
  const idx     = addr - textBase;
  const fileOff = TEXT_FILE_OFFSET + idx * 4;
  buf.writeInt32LE(value, fileOff);
}

// ── Identify fixable functions ────────────────────────────────────────────────
const exported   = meta.link.exportedFunctions;            // name -> TNA addr
const unresolved = new Set(meta.link.unresolvedFunctionImports);

const fixable = Object.keys(exported)
  .filter(n => unresolved.has(n) && !HOST_OVERRIDES.has(n))
  .sort();

const keptHost = Object.keys(exported)
  .filter(n => unresolved.has(n) && HOST_OVERRIDES.has(n))
  .sort();

console.log(`\nFixable (exported → redirect to TNA): ${fixable.length}`);
fixable.forEach(n => {
  const tramp = meta.link.hostImportTrampolines[n];
  const tna   = exported[n];
  console.log(`  ${n.padEnd(28)} trampoline=0x${tramp.toString(16).padStart(6,'0')}  tna=0x${tna.toString(16).padStart(6,'0')}`);
});

console.log(`\nKept as HOST (DOS memory model — not safe in TNA flat memory): ${keptHost.length}`);
keptHost.forEach(n => console.log(`  ${n}`));

// ── Patch stubs ───────────────────────────────────────────────────────────────
const fixableSet = new Set(fixable);
let patched = 0;
let skipped = 0;
let errors  = 0;

const JMP_OPCODE = 6; // from config.js OPCODES.JMP

for (const site of meta.link.unresolvedImportSites) {
  if (!fixableSet.has(site.name)) continue;

  const stubAddr  = site.stubAddress;
  const trampAddr = meta.link.hostImportTrampolines[site.name];
  const tnaAddr   = exported[site.name];

  // Verify current state: word[0]=JMP, word[1]=trampoline
  const w0 = readWord(stubAddr);
  const w1 = readWord(stubAddr + 1);

  if (w0 !== JMP_OPCODE) {
    console.warn(`  SKIP ${site.name} @0x${stubAddr.toString(16)}: opcode=${w0} (expected JMP=${JMP_OPCODE})`);
    skipped++;
    continue;
  }
  if (w1 !== trampAddr) {
    console.warn(`  SKIP ${site.name} @0x${stubAddr.toString(16)}: target=0x${w1.toString(16)} (expected tramp=0x${trampAddr.toString(16)})`);
    skipped++;
    continue;
  }

  // Repatch: JMP trampoline -> JMP tnaAddr
  writeWord(stubAddr + 1, tnaAddr);
  patched++;
}

// ── Direct no-op stubs: exported TNA functions called directly (not via stubs)
// ── that spin forever due to DOS far-pointer pixel/memory operations.
// ── We overwrite their first 12 words with: PUSH BP / MOV_REG BP,SP / POP BP / RET
// ── This makes them return 0 immediately, matching the host_runtime.js no-op.
const { OPCODES, REGISTERS } = require('../src/config');

const NOOP_BODY = Int32Array.from([
  OPCODES.PUSH,    REGISTERS.BP, 0,   // PUSH BP   (save frame pointer)
  OPCODES.MOV_REG, REGISTERS.BP, REGISTERS.SP,  // MOV_REG BP, SP
  OPCODES.POP,     REGISTERS.BP, 0,   // POP BP    (restore — no locals)
  OPCODES.RET,     0,            0,   // RET       (return R0=0)
]);

// Functions that are exported (called via CALL, not stubs) but crash/loop in TNA
// because they contain inline x86 ASM, DOS far-pointer pixel loops, or VGA planar ops.
// Strategy: fill the ENTIRE function body with RET (not just 12 words at entry),
// so any jump into the middle of the function also terminates cleanly.
const DIRECT_NOOPS = [
  // ── VH/VL planar pixel routines with far-ptr arithmetic ──────────────────────
  'VL_MungePic',         // width*height far-ptr loop + MM_GetPtr
  'VL_DrawTile8String',  // far pointer loop
  'VL_DrawLatch8String', // far pointer loop
  'VL_SizeTile8String',  // far pointer measurement loop
  'VL_Bar',              // far ptr VGA write loop
  'VL_Hlin',             // horizontal line — VGA far ptr
  'VL_Vlin',             // vertical line — VGA far ptr
  'VL_Plot',             // single pixel — VGA far ptr
  // ── WL_DRAW render pipeline — x86 inline ASM throughout ─────────────────────
  'ThreeDRefresh',       // master 3D render (spotvis clear, bufferofs, full pipeline)
  'WallRefresh',         // calls ScalePost in inner loop
  'DrawScaleds',         // calls ScaleShape (ASM sprites)
  'DrawPlayerWeapon',    // calls ScaleShape (ASM)
  'VGAClearScreen',      // pure ASM VGA memset
  'ScalePost',           // pure x86 ASM — VGA planar column renderer
  'FarScalePost',        // wrapper → ScalePost
  // ── WL_SCALE / CONTIGSC / OLDSCALE — compiled scale routines (x86 ASM) ──────
  'BadScale',
  'SetupScaling',        // writes x86 machine code into RAM
  'BuildCompScale',      // builds compiled scale spans (self-modifying x86)
  'ScaleLine',           // pure ASM column renderer
  'ScaleShape',          // ASM sprite scaler
  'SimpleScaleShape',    // ASM sprite scaler
  // ── WOLFHACK.C — floor/ceiling renderer, far-ptr planeylookup[] ─────────────
  'DrawPlanes',          // entire body loops via far-ptr lookup → null call at +4620
  'DrawSpans',           // dereferences far ptr toprow
  'SetPlaneViewSize',    // initialises far-ptr planeylookup[] with VGA addresses
  // ── VW screen update — double-buffer block copy ──────────────────────────────
  'VW_UpdateScreen',
];

// Build sorted export table once (for function-length calculation)
const sortedExports = Object.entries(exported).sort(([,a],[,b]) => a - b);
const textEnd = textBase + textWords;

function getFunctionLength(name) {
  const addr = exported[name];
  if (addr == null) return 0;
  const idx = sortedExports.findIndex(([n]) => n === name);
  const nextAddr = idx + 1 < sortedExports.length ? sortedExports[idx + 1][1] : textEnd;
  return nextAddr - addr;
}

// A full-body noop: prologue + enough RET words to cover the entire function.
// We write: PUSH BP / MOV_REG BP,SP / POP BP / RET  then fill rest with RET 0 0.
const RET_WORD = [OPCODES.RET, 0, 0];

let noopPatched = 0;
for (const name of DIRECT_NOOPS) {
  const addr = exported[name];
  if (addr == null) { console.warn(`  DIRECT_NOOP skip: ${name} — not exported`); continue; }
  const firstWord = readWord(addr);
  if (firstWord !== OPCODES.PUSH && firstWord !== OPCODES.MOV_IMM && firstWord !== OPCODES.MOV_REG) {
    console.warn(`  DIRECT_NOOP skip: ${name} @ 0x${addr.toString(16)} unexpected prologue opcode ${firstWord}`);
    continue;
  }
  const len = getFunctionLength(name);
  // Write the 12-word clean-return stub at entry
  const stub = [
    OPCODES.PUSH,    REGISTERS.BP, 0,
    OPCODES.MOV_REG, REGISTERS.BP, REGISTERS.SP,
    OPCODES.POP,     REGISTERS.BP, 0,
    OPCODES.RET,     0,            0,
  ];
  for (let i = 0; i < stub.length; i++) writeWord(addr + i, stub[i]);
  // Fill rest of function body with RET 0 0 so mid-function jumps also exit cleanly
  for (let i = stub.length; i + 2 < len; i += 3) {
    writeWord(addr + i,     OPCODES.RET);
    writeWord(addr + i + 1, 0);
    writeWord(addr + i + 2, 0);
  }
  console.log(`  NOOP-stub: ${name.padEnd(28)} @ 0x${addr.toString(16)} (${len} words filled)`);
  noopPatched++;
}
console.log(`\nDirect noop stubs written: ${noopPatched}`);

// ── Update metadata in the JSON ───────────────────────────────────────────────
// Move fixed imports from unresolvedFunctionImports to resolvedInternalImports
const newUnresolved = meta.link.unresolvedFunctionImports.filter(n => !fixableSet.has(n));
const newResolved   = [
  ...meta.link.resolvedInternalImports,
  ...fixable.map(n => ({
    name:        n,
    target:      exported[n],
    patchedFrom: 'patch_linker_stubs',
  })),
];

const newUnresolvedSites = meta.link.unresolvedImportSites.filter(s => !fixableSet.has(s.name));

meta.link.unresolvedFunctionImports = newUnresolved;
meta.link.resolvedInternalImports   = newResolved;
meta.link.unresolvedImportSites     = newUnresolvedSites;
meta.link.patchedAt                 = new Date().toISOString();
meta.link.patchedStubs              = patched;

console.log(`\nRemaining unresolved imports: ${newUnresolved.length}`);

// ── Rebuild the binary ────────────────────────────────────────────────────────
const newMetaStr  = JSON.stringify(meta);
const newMetaBuf  = Buffer.from(newMetaStr, 'utf8');
const newMetaLen  = newMetaBuf.length;

// New header length
const newHeaderEnd = META_LEN_OFFSET + 8 + abiLen + newMetaLen;

// Build new file
const textBuf = buf.slice(TEXT_FILE_OFFSET, TEXT_FILE_OFFSET + textWords * 4);
const dataBuf = buf.slice(TEXT_FILE_OFFSET + textWords * 4);

const newHeader = Buffer.allocUnsafe(newHeaderEnd);
// magic + version
buf.copy(newHeader, 0, 0, 8);
// entry, textBase, textWords, dataBase, dataWords
buf.copy(newHeader, 8, 8, META_LEN_OFFSET);
// abiLen, newMetaLen
newHeader.writeInt32LE(abiLen,      META_LEN_OFFSET);
newHeader.writeInt32LE(newMetaLen,  META_LEN_OFFSET + 4);
// abi string
buf.copy(newHeader, META_LEN_OFFSET + 8, META_LEN_OFFSET + 8, META_LEN_OFFSET + 8 + abiLen);
// new meta JSON
newMetaBuf.copy(newHeader, META_LEN_OFFSET + 8 + abiLen);

const outBuf = Buffer.concat([newHeader, textBuf, dataBuf]);
fs.writeFileSync(outFile, outBuf);

const savedKB = ((buf.length - outBuf.length) / 1024).toFixed(1);
console.log(`\nWrote ${outFile} (${(outBuf.length/1024).toFixed(0)} KB, ${savedKB>0?'saved':'added'} ${Math.abs(savedKB)} KB vs input)`);
console.log('Done. ✓');
