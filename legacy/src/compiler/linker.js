const fs = require('fs');
const path = require('path');
const CCompiler = require('./c_transpiler');
const { MMIO, OPCODES, REGISTERS, SYSCALLS } = require('../config');


function buildHostTrampolineWords(importNames, textBase, startAddress) {
  const words = [];
  const trampolines = {};
  let addr = startAddress | 0;
  importNames.forEach((name, index) => {
    trampolines[name] = addr;
    const id = (index + 1) | 0;
    words.push(OPCODES.MOV_IMM, REGISTERS.TMP, id);
    words.push(OPCODES.SYSCALL, SYSCALLS.HOST_IMPORT, 0);
    words.push(OPCODES.RET, 0, 0);
    addr += 9;
  });
  return { words: Int32Array.from(words), trampolines };
}

const DEFAULT_MACROS = [
  ['WOLF', '1'],
  ['WOLFVER', 'WL6'],
  ['GOODTIMES', '1'],
  ['WL6', '1'],
  ['NULL', '0'],
];

class TNALinker {
  constructor(options = {}) {
    this.options = options;
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.predefinedMacros = options.predefinedMacros || DEFAULT_MACROS;
    this.allowImplicitExterns = options.allowImplicitExterns !== false;
  }

  makeCompiler(projectRoot = this.projectRoot) {
    return new CCompiler({
      projectRoot,
      allowImplicitExterns: this.allowImplicitExterns,
      predefinedMacros: this.predefinedMacros,
    });
  }

  collectMetadata(units, dataBase = MMIO.DATA_BASE) {
    const sharedGlobals = new Map();
    const metadata = [];
    let nextSharedAddress = dataBase | 0;

    for (const unit of units) {
      const compiler = this.makeCompiler(unit.projectRoot || this.projectRoot);
      const source = unit.source != null ? unit.source : fs.readFileSync(unit.file, 'utf8');
      const filename = unit.file || path.join(unit.projectRoot || this.projectRoot, unit.name || 'unit.c');
      const preprocessed = compiler.preprocess(source, filename);
      const ast = compiler.parse(preprocessed, filename);
      const defs = [];
      for (const g of ast.globals) {
        const resolvedArraySize = compiler.resolveArraySize(g.baseType, g.arraySize, g.init);
        const size = compiler.symbolSize(g.baseType, resolvedArraySize, g.init);
        defs.push({
          name: g.name,
          size,
          type: g.baseType,
          arraySize: resolvedArraySize,
          storage: g.storage || null,
        });
        if (g.storage === 'static' || g.storage === 'extern') continue;
        if (!sharedGlobals.has(g.name)) {
          sharedGlobals.set(g.name, {
            address: nextSharedAddress,
            size,
            type: g.baseType,
            arraySize: resolvedArraySize,
            extern: false,
            definedIn: filename,
          });
          nextSharedAddress += size;
        }
      }
      metadata.push({
        ...unit,
        filename,
        source,
        globals: defs,
        functions: ast.functions.map((fn) => fn.name),
      });
    }

    return { metadata, sharedGlobals, nextSharedAddress };
  }

  linkUnits(units, options = {}) {
    const entryFunction = options.entryFunction || 'main';
    const bootstrapWords = 6;
    const textBase = (options.textBase != null ? options.textBase : MMIO.PROGRAM_BASE) | 0;
    const dataBase = (options.dataBase != null ? options.dataBase : 0x40000) | 0;

    const hostOverrides = new Set([...(this.options.hostOverrides || []), ...(options.hostOverrides || [])]);
    const { metadata, sharedGlobals, nextSharedAddress } = this.collectMetadata(units, dataBase);
    let currentTextBase = (textBase + bootstrapWords) | 0;
    let currentStaticData = nextSharedAddress | 0;
    const objects = [];
    const exports = new Map();

    for (const unit of metadata) {
      const compiler = this.makeCompiler(unit.projectRoot || this.projectRoot);
      const object = compiler.compileTranslationUnit(unit.source, unit.filename, {
        allowImplicitExterns: true,
        baseAddress: currentTextBase,
        dataBase,
        nextDataAddressStart: currentStaticData,
        sharedGlobals,
      });
      const unitDataEnd = (dataBase + object.dataImage.length) | 0;
      objects.push({
        ...unit,
        object,
        textStart: currentTextBase,
        textEnd: currentTextBase + object.text.length,
        staticDataStart: currentStaticData,
        dataEnd: unitDataEnd,
      });
      for (const [name, address] of Object.entries(object.exports.functions || {})) exports.set(name, address | 0);
      currentTextBase = (currentTextBase + object.text.length) | 0;
      currentStaticData = Math.max(currentStaticData, unitDataEnd) | 0;
    }

    const finalTextLength = currentTextBase - textBase;
    let finalText = new Int32Array(finalTextLength);
    // Bootstrap
    finalText[0] = OPCODES.CALL;
    finalText[1] = exports.get(entryFunction) || 0;
    finalText[2] = 0;
    finalText[3] = OPCODES.HALT;
    finalText[4] = 0;
    finalText[5] = 0;

    for (const unit of objects) {
      finalText.set(unit.object.text, unit.textStart - textBase);
    }

    const finalData = new Int32Array(Math.max(0, currentStaticData - dataBase));
    for (const unit of objects) {
      const words = unit.object.dataImage;
      const copyWord = (address) => {
        const src = address - dataBase;
        const dst = src;
        if (src < 0 || src >= words.length || dst < 0 || dst >= finalData.length) return;
        finalData[dst] = words[src] | 0;
      };
      for (const g of unit.globals) {
        if (g.storage === 'static' || g.storage === 'extern') continue;
        const sym = unit.object.globals[g.name];
        if (!sym) continue;
        for (let i = 0; i < sym.size; i++) copyWord((sym.address + i) | 0);
      }
      for (let address = unit.staticDataStart; address < unit.dataEnd; address++) copyWord(address);
    }

    const resolvedInternalImports = [];
    const unresolvedImports = [];
    const hostImports = new Set();

    for (const name of hostOverrides) hostImports.add(name);

    for (const unit of objects) {
      const stubs = unit.object.imports.functionStubs || {};
      for (const [name, addressRaw] of Object.entries(stubs)) {
        const address = addressRaw | 0;
        const index = address - textBase;
        if (exports.has(name) && !hostOverrides.has(name)) {
          finalText[index] = OPCODES.JMP;
          finalText[index + 1] = exports.get(name) | 0;
          finalText[index + 2] = 0;
          resolvedInternalImports.push({ from: unit.filename, name, stubAddress: address, target: exports.get(name) | 0 });
        } else {
          unresolvedImports.push({ from: unit.filename, name, stubAddress: address });
          hostImports.add(name);
        }
      }
    }

    const hostImportNames = [...hostImports].sort();
    const trampBase = (textBase + finalText.length) | 0;
    const { words: hostWords, trampolines: hostImportTrampolines } = buildHostTrampolineWords(hostImportNames, textBase, trampBase);
    if (hostWords.length) {
      const expanded = new Int32Array(finalText.length + hostWords.length);
      expanded.set(finalText, 0);
      expanded.set(hostWords, finalText.length);
      finalText = expanded;
      for (const imp of unresolvedImports) {
        const index = (imp.stubAddress | 0) - textBase;
        finalText[index] = OPCODES.JMP;
        finalText[index + 1] = hostImportTrampolines[imp.name] | 0;
        finalText[index + 2] = 0;
      }
      for (const name of hostOverrides) {
        if (!exports.has(name) || !hostImportTrampolines[name]) continue;
        const index = (exports.get(name) | 0) - textBase;
        if (index < 0 || index + 2 >= finalText.length) continue;
        finalText[index] = OPCODES.JMP;
        finalText[index + 1] = hostImportTrampolines[name] | 0;
        finalText[index + 2] = 0;
      }
    }

    if (options.dataBase == null && !options._autoDataBase) {
      const finalTextEnd = (textBase + finalText.length) | 0;
      if ((dataBase | 0) <= finalTextEnd) {
        const safeDataBase = (((finalTextEnd + 0x1fff) >> 12) << 12) | 0;
        return this.linkUnits(units, { ...options, dataBase: safeDataBase, _autoDataBase: true });
      }
    }


    const linkMeta = {
      entryFunction,
      objects: objects.map((unit) => ({
        file: unit.filename,
        functions: unit.functions,
        textStart: unit.textStart,
        textWords: unit.object.text.length,
        staticDataStart: unit.staticDataStart,
        dataWords: unit.object.dataImage.length,
        imports: unit.object.imports,
      })),
      exportedFunctions: Object.fromEntries([...exports.entries()]),
      resolvedInternalImports,
      unresolvedFunctionImports: hostImportNames,
      unresolvedImportSites: unresolvedImports,
      hostImportTrampolines,
      hostOverrides: [...hostOverrides],
      globals: Object.fromEntries([...sharedGlobals.entries()].map(([name, sym]) => [name, { address: sym.address, size: sym.size }])),
    };

    const executable = {
      kind: 'tna-executable',
      abi: 'tna-cdecl-v1',
      entry: textBase,
      textBase,
      text: finalText,
      dataBase,
      dataImage: finalData,
      globals: Object.fromEntries([...sharedGlobals.entries()].map(([name, sym]) => [name, { address: sym.address, size: sym.size }])),
      link: linkMeta,
      meta: { link: linkMeta, globals: linkMeta.globals },
    };

    return executable;
  }
}

module.exports = TNALinker;
