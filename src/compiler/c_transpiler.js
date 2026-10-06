const fs = require('fs');
const path = require('path');
const Assembler = require('./assembler');
const { ABI, MMIO, REGISTERS } = require('../config');

const SCRATCH_REGS = [
  REGISTERS.R10, REGISTERS.R9, REGISTERS.R8, REGISTERS.R7, REGISTERS.R6,
  REGISTERS.R5, REGISTERS.R4, REGISTERS.R3, REGISTERS.R2, REGISTERS.R1, REGISTERS.R0,
];

const STORAGE_CLASS = new Set(['typedef', 'extern', 'static', 'register', 'auto']);
const TYPE_QUALIFIERS = new Set(['const', 'volatile', 'signed', 'unsigned', 'short', 'long']);
const BORLAND_QUALIFIERS = new Set(['near', 'far', 'huge', 'pascal', 'interrupt', '_seg']);
const BUILTIN_TYPES = new Set(['int', 'void', 'char', 'float', 'double']);
const ASM_KEYWORDS = new Set(['asm', '__asm']);
const PRIMITIVE_OR_QUAL = new Set([...BUILTIN_TYPES, ...TYPE_QUALIFIERS, ...BORLAND_QUALIFIERS]);

function cloneType(type) {
  return {
    kind: type.kind,
    name: type.name || null,
    pointerDepth: type.pointerDepth | 0,
    sizeWords: type.sizeWords | 0,
    fields: type.fields ? new Map([...type.fields.entries()].map(([k, v]) => [k, { ...v, type: cloneType(v.type) }])) : null,
    functionPointer: !!type.functionPointer,
    fnParams: type.fnParams ? type.fnParams.map((p) => ({ ...p, type: cloneType(p.type) })) : null,
    returnType: type.returnType ? cloneType(type.returnType) : null,
  };
}

function primitiveType(name = 'int', pointerDepth = 0) {
  return { kind: name === 'void' && pointerDepth === 0 ? 'void' : 'int', name: null, pointerDepth, sizeWords: 1, fields: null };
}

class TokenStream {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }
  peek(offset = 0) {
    return this.tokens[this.index + offset] || { type: 'eof', value: '<eof>' };
  }
  next() {
    return this.tokens[this.index++] || { type: 'eof', value: '<eof>' };
  }
  match(value) {
    if (this.peek().value === value) {
      this.index++;
      return true;
    }
    return false;
  }
  formatToken(token) {
    const where = token && token.line != null ? ` @${token.line}:${token.col}` : '';
    return `${token.type}:${token.value}${where}`;
  }
  expect(value) {
    const token = this.next();
    if (token.value !== value) throw new Error(`Attendu '${value}', reçu '${token.value}'${token.line != null ? ` @${token.line}:${token.col}` : ''}`);
    return token;
  }
  expectType(type) {
    const token = this.next();
    if (token.type !== type) throw new Error(`Attendu ${type}, reçu ${token.type}:${token.value}${token.line != null ? ` @${token.line}:${token.col}` : ''}`);
    return token;
  }
}

class C_Compiler {
  constructor(options = {}) {
    this.options = options;
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.reset();
  }

  reset() {
    this.baseAddress = MMIO.PROGRAM_BASE;
    this.dataBase = MMIO.DATA_BASE;
    this.nextDataFloor = MMIO.DATA_BASE;
    this.asm = null;
    this.pool = [];
    this.globals = new Map();
    this.functions = new Map();
    this.functionPrototypes = new Map();
    this.dataImage = [];
    this.labelCounter = 0;
    this.currentFunction = null;
    this.breakStack = [];
    this.continueStack = [];
    this.importedFunctions = new Set();
    this.importedGlobals = new Map();
    this.exportedFunctions = new Map();
    this.importStubAddresses = new Map();
    this.typeAliases = new Map([
      ['int', primitiveType('int')],
      ['char', primitiveType('int')],
      ['void', primitiveType('void')],
    ]);
    this.structTypes = new Map();
    this.constants = new Map();
  }

  compile(source, baseAddress = MMIO.PROGRAM_BASE, filename = path.join(this.projectRoot, 'games', 'wolf3d.c')) {
    this.reset();
    this.baseAddress = baseAddress | 0;
    this.dataBase = MMIO.DATA_BASE;
    this.nextDataFloor = this.dataBase;
    this.asm = new Assembler(this.baseAddress);
    this.pool = SCRATCH_REGS.slice();

    const ast = this.parse(source, filename);
    for (const fn of ast.functions) {
      this.functions.set(fn.name, fn);
      this.functionPrototypes.set(fn.name, fn);
    }
    this.allocateGlobals(ast.globals);

    this.asm.call('__tna_entry_main');
    this.asm.halt();

    for (const fn of ast.functions) this.compileFunction(fn);
    this.emitImportedFunctionStubs();

    return {
      kind: 'tna-executable',
      abi: 'tna-cdecl-v1',
      entry: this.baseAddress,
      textBase: this.baseAddress,
      text: Int32Array.from(this.asm.getProgram()),
      dataBase: this.dataBase,
      dataImage: Int32Array.from(this.dataImage),
      globals: Object.fromEntries([...this.globals.entries()].map(([name, sym]) => [name, { address: sym.address, size: sym.size, extern: !!sym.extern }])),
      exports: {
        functions: Object.fromEntries([...this.exportedFunctions.entries()]),
      },
      imports: {
        functions: [...this.importedFunctions.values()],
        globals: [...this.importedGlobals.keys()],
        functionStubs: Object.fromEntries([...this.importStubAddresses.entries()]),
      },
    };
  }

  compileTranslationUnit(source, filename, options = {}) {
    this.reset();
    this.baseAddress = (options.baseAddress != null ? options.baseAddress : MMIO.PROGRAM_BASE) | 0;
    this.dataBase = (options.dataBase != null ? options.dataBase : MMIO.DATA_BASE) | 0;
    this.nextDataFloor = (options.nextDataAddressStart != null ? options.nextDataAddressStart : this.dataBase) | 0;
    this.asm = new Assembler(this.baseAddress);
    this.pool = SCRATCH_REGS.slice();
    if (options.sharedGlobals) {
      const entries = options.sharedGlobals instanceof Map ? options.sharedGlobals.entries() : Object.entries(options.sharedGlobals);
      for (const [name, sym] of entries) {
        this.globals.set(name, {
          kind: 'global',
          name,
          address: sym.address | 0,
          size: sym.size | 0,
          type: cloneType(sym.type || primitiveType('int')),
          arraySize: sym.arraySize != null ? sym.arraySize : null,
          extern: !!sym.extern,
        });
      }
    }

    const preprocessed = options.preprocessed ? source : this.preprocess(source, filename);
    const ast = this.parse(preprocessed, filename);
    for (const fn of ast.functions) {
      this.functions.set(fn.name, fn);
      this.functionPrototypes.set(fn.name, fn);
    }
    this.allocateGlobals(ast.globals);
    const previousImplicit = !!this.options.allowImplicitExterns;
    if (options.allowImplicitExterns != null) this.options.allowImplicitExterns = !!options.allowImplicitExterns;
    for (const fn of ast.functions) this.compileFunction(fn);
    this.options.allowImplicitExterns = previousImplicit;
    this.emitImportedFunctionStubs();
    return {
      kind: 'tna-object',
      abi: 'tna-cdecl-v1',
      file: filename,
      textBase: this.baseAddress,
      text: Int32Array.from(this.asm.getProgram()),
      dataBase: this.dataBase,
      dataImage: Int32Array.from(this.dataImage),
      globals: Object.fromEntries([...this.globals.entries()].map(([name, sym]) => [name, { address: sym.address, size: sym.size, extern: !!sym.extern }])),
      functions: ast.functions.map((fn) => fn.name),
      exports: {
        functions: Object.fromEntries([...this.exportedFunctions.entries()]),
      },
      imports: {
        functions: [...this.importedFunctions.values()],
        globals: [...this.importedGlobals.keys()],
        functionStubs: Object.fromEntries([...this.importStubAddresses.entries()]),
      },
    };
  }

  // ---------- Preprocessor ----------

  normalizeIncludeSpec(spec) {
    return String(spec || '').replace(/[\\/]+/g, path.sep);
  }

  resolveCaseInsensitive(fullPath) {
    if (fs.existsSync(fullPath)) return fullPath;
    const parts = path.resolve(fullPath).split(path.sep);
    let current = parts[0] === '' ? path.sep : parts[0];
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) return null;
      const entries = fs.readdirSync(current);
      const match = entries.find((entry) => entry.toLowerCase() == part.toLowerCase());
      if (!match) return null;
      current = path.join(current, match);
    }
    return fs.existsSync(current) ? current : null;
  }

  resolveInclude(spec, fromFile) {
    const normalizedSpec = this.normalizeIncludeSpec(spec);
    const search = [
      fromFile ? path.dirname(fromFile) : null,
      process.cwd(),
      this.projectRoot,
      path.join(this.projectRoot, 'games'),
      path.join(this.projectRoot, 'src'),
      path.join(this.projectRoot, 'WOLFSRC'),
      path.join(this.projectRoot, 'include'),
      path.join(this.projectRoot, 'compat'),
      path.join(this.projectRoot, 'compat', 'include'),
      path.join(this.projectRoot, 'historical'),
      path.join(this.projectRoot, 'historical', 'include'),
      path.join(this.projectRoot, 'historical', 'wolf3d_compat'),
      path.join(this.projectRoot, 'historical', 'wolf3d_compat', 'include'),
    ].filter(Boolean);
    for (const dir of search) {
      const full = path.resolve(dir, normalizedSpec);
      const found = this.resolveCaseInsensitive(full);
      if (found) return found;
    }
    return null;
  }

  evalPreprocessorExpr(expr, defines) {
    const replacedDefined = expr.replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, name) => (defines.has(name) ? '1' : '0'));
    const substituted = replacedDefined.replace(/\b([A-Za-z_]\w*)\b/g, (token) => {
      if (['and', 'or', 'not'].includes(token)) return token;
      if (defines.has(token)) return `(${defines.get(token)})`;
      return '0';
    });
    if (!/^[\d\s()+\-*/%<>=!&|^~?:.]+$/.test(substituted)) return 0;
    try {
      // eslint-disable-next-line no-new-func
      return Function(`return ((${substituted})|0);`)() ? 1 : 0;
    } catch {
      return 0;
    }
  }

  expandMacros(text, defines) {
    let out = String(text);
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      let result = '';
      let i = 0;
      let inString = false;
      let quote = '';
      while (i < out.length) {
        const ch = out[i];
        const prev = i > 0 ? out[i - 1] : '';
        if (inString) {
          result += ch;
          if (ch === quote && prev !== '\\') inString = false;
          i += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inString = true;
          quote = ch;
          result += ch;
          i += 1;
          continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
          let j = i + 1;
          while (j < out.length && /[A-Za-z0-9_]/.test(out[j])) j += 1;
          const token = out.slice(i, j);
          if (defines.has(token)) {
            result += defines.get(token);
            changed = true;
          } else {
            result += token;
          }
          i = j;
          continue;
        }
        result += ch;
        i += 1;
      }
      out = result;
      if (!changed) break;
    }
    return out;
  }

  parseFunctionMacro(value) {
    const match = String(value).match(/^__FUNC_MACRO__([A-Za-z_]\w*)\((.*?)\)=>([\s\S]*)$/);
    if (!match) return null;
    const [, name, paramsRaw, body] = match;
    const rawParams = paramsRaw ? paramsRaw.split(',').map((v) => v.trim()).filter(Boolean) : [];
    let variadic = false;
    const params = [];
    for (const param of rawParams) {
      if (param === '...') {
        variadic = true;
        continue;
      }
      params.push(param);
    }
    return {
      name,
      params,
      variadic,
      body: body || '',
    };
  }

  stringifyMacroValue(text) {
    const raw = String(text ?? '').trim();
    const escaped = raw
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }

  escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  applyFunctionMacro(macro, args) {
    let body = macro.body;
    const variadicArgs = macro.variadic ? args.slice(macro.params.length).join(', ') : '';

    const pasteRe = /([A-Za-z_]\w*|__VA_ARGS__)\s*##\s*([A-Za-z_]\w*|__VA_ARGS__)/;
    while (pasteRe.test(body)) {
      body = body.replace(pasteRe, (_m, lhs, rhs) => {
        const left = lhs === '__VA_ARGS__' ? variadicArgs : (macro.params.includes(lhs) ? (args[macro.params.indexOf(lhs)] ?? '') : lhs);
        const right = rhs === '__VA_ARGS__' ? variadicArgs : (macro.params.includes(rhs) ? (args[macro.params.indexOf(rhs)] ?? '') : rhs);
        return `${left}${right}`;
      });
    }

    const stringTargets = macro.params.concat(macro.variadic ? ['__VA_ARGS__'] : []);
    for (const param of stringTargets) {
      const value = param === '__VA_ARGS__' ? variadicArgs : (args[macro.params.indexOf(param)] ?? '');
      body = body.replace(new RegExp(`(^|[^#])#\\s*${this.escapeRegExp(param)}\\b`, 'g'), (_m, prefix) => `${prefix}${this.stringifyMacroValue(value)}`);
    }

    macro.params.forEach((param, index) => {
      const replacement = args[index] != null ? args[index] : '';
      body = body.replace(new RegExp(`\\b${this.escapeRegExp(param)}\\b`, 'g'), replacement);
    });
    if (macro.variadic) body = body.replace(/\b__VA_ARGS__\b/g, variadicArgs);
    return body;
  }

  findMatchingParen(text, openIndex) {
    let depth = 0;
    let inString = false;
    let quote = '';
    for (let i = openIndex; i < text.length; i++) {
      const ch = text[i];
      const prev = i > 0 ? text[i - 1] : '';
      if (inString) {
        if (ch === quote && prev !== '\\') inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  splitMacroArgs(text) {
    const args = [];
    let depth = 0;
    let current = '';
    let inString = false;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const prev = i > 0 ? text[i - 1] : '';
      if (inString) {
        current += ch;
        if (ch === quote && prev !== '\\') inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === '(') { depth += 1; current += ch; continue; }
      if (ch === ')') { depth -= 1; current += ch; continue; }
      if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim().length || text.trim().length === 0) args.push(current.trim());
    return args;
  }

  expandFunctionMacros(text, defines) {
    let out = text;
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const [name, value] of defines.entries()) {
        const macro = this.parseFunctionMacro(value);
        if (!macro) continue;
        const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
        let rebuilt = '';
        let cursor = 0;
        let localChange = false;
        let match;
        while ((match = pattern.exec(out)) !== null) {
          const openIndex = out.indexOf('(', match.index);
          const closeIndex = this.findMatchingParen(out, openIndex);
          if (closeIndex < 0) break;
          const rawArgs = out.slice(openIndex + 1, closeIndex);
          const args = this.splitMacroArgs(rawArgs);
          const body = this.applyFunctionMacro(macro, args);
          rebuilt += out.slice(cursor, match.index) + body;
          cursor = closeIndex + 1;
          pattern.lastIndex = cursor;
          localChange = true;
        }
        if (localChange) {
          rebuilt += out.slice(cursor);
          out = rebuilt;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return out;
  }

  preprocess(source, filename = path.join(this.projectRoot, 'games', 'wolf3d.c'), inheritedDefines = null, includeGuard = new Set()) {
    const defines = inheritedDefines || new Map(this.options.predefinedMacros || []);
    const normalized = source.replace(/\u001a/g, '').replace(/\r/g, '').replace(/\\\n/g, '');
    const lines = normalized.split('\n');
    const out = [];
    const condStack = [];
    let active = true;

    const recomputeActive = () => {
      active = condStack.every((frame) => frame.parentActive && frame.thisActive);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const directive = line.match(/^\s*#\s*(\w+)\b(.*)$/);
      if (directive) {
        const [, keyword, restRaw] = directive;
        const rest = restRaw.trim();
        if (keyword === 'include') {
          if (!active) continue;
          const match = rest.match(/^[<"]([^>"]+)[>"]/);
          if (!match) throw new Error(`Include invalide: ${line}`);
          const resolved = this.resolveInclude(match[1], filename);
          if (!resolved) throw new Error(`Include introuvable: ${match[1]}`);
          if (includeGuard.has(resolved)) continue;
          const included = fs.readFileSync(resolved, 'utf8');
          includeGuard.add(resolved);
          out.push(this.preprocess(included, resolved, defines, includeGuard));
          continue;
        }
        if (keyword === 'define') {
          if (!active) continue;
          const match = rest.match(/^([A-Za-z_]\w*)(\((.*?)\))?\s*(.*)$/);
          if (!match) throw new Error(`Define invalide: ${line}`);
          const [, name, fnSig, paramsRaw, valueRaw] = match;
          const cleanValue = String(valueRaw || '1')
            .replace(/\/\/.*$/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .trim() || '1';
          if (fnSig) {
            const params = paramsRaw.split(',').map((v) => v.trim()).filter(Boolean);
            defines.set(name, `__FUNC_MACRO__${name}(${params.join(',')})=>${cleanValue}`);
          } else {
            const normalized = cleanValue.replace(/\b0x([0-9a-fA-F]+)\b/g, (_, hex) => parseInt(hex, 16).toString());
            defines.set(name, normalized || '1');
          }
          continue;
        }
        if (keyword === 'undef') {
          if (active) defines.delete(rest);
          continue;
        }
        if (keyword === 'ifdef' || keyword === 'ifndef' || keyword === 'if') {
          const parentActive = condStack.length === 0 ? true : condStack.every((frame) => frame.parentActive && frame.thisActive);
          let result = false;
          if (keyword === 'ifdef') result = defines.has(rest);
          else if (keyword === 'ifndef') result = !defines.has(rest);
          else result = !!this.evalPreprocessorExpr(this.expandMacros(rest, defines), defines);
          condStack.push({ parentActive, satisfied: result, thisActive: parentActive && result, sawElse: false });
          recomputeActive();
          continue;
        }
        if (keyword === 'elif') {
          const frame = condStack[condStack.length - 1];
          if (!frame) throw new Error('#elif sans #if');
          if (frame.sawElse) throw new Error('#elif après #else');
          const result = !frame.satisfied && !!this.evalPreprocessorExpr(this.expandMacros(rest, defines), defines);
          frame.thisActive = frame.parentActive && result;
          frame.satisfied = frame.satisfied || result;
          recomputeActive();
          continue;
        }
        if (keyword === 'else') {
          const frame = condStack[condStack.length - 1];
          if (!frame) throw new Error('#else sans #if');
          if (frame.sawElse) throw new Error('Double #else');
          frame.sawElse = true;
          frame.thisActive = frame.parentActive && !frame.satisfied;
          frame.satisfied = true;
          recomputeActive();
          continue;
        }
        if (keyword === 'endif') {
          if (!condStack.length) throw new Error('#endif sans #if');
          condStack.pop();
          recomputeActive();
          continue;
        }
        if (['pragma', 'error', 'line'].includes(keyword)) continue;
      }
      if (!active) continue;
      out.push(line);
    }

    if (condStack.length) throw new Error('Bloc préprocesseur non refermé');

    let text = out.join('\n');
    text = text.replace(/\/\*([\s\S]*?)\*\//g, '');
    text = text.replace(/\/\/.*$/gm, '');

    const objectDefines = new Map([...defines.entries()].filter(([, value]) => !String(value).startsWith('__FUNC_MACRO__')));
    for (let pass = 0; pass < 8; pass++) {
      const before = text;
      text = this.expandFunctionMacros(text, defines);
      text = this.expandMacros(text, objectDefines);
      if (text === before) break;
    }
    return text;
  }

  // ---------- Tokenizer ----------

  tokenize(source) {
    const tokens = [];
    let i = 0;
    let line = 1;
    let col = 1;
    const keywords = new Set([
      'int', 'void', 'char', 'while', 'for', 'if', 'else', 'return', 'break', 'continue',
      'typedef', 'struct', 'union', 'enum', 'extern', 'static', 'const', 'volatile', 'unsigned', 'signed',
      'short', 'long', 'register', 'auto', 'sizeof', 'do', 'switch', 'case', 'default', 'goto',
      'near', 'far', 'huge', 'pascal', 'interrupt', '_seg', 'asm', '__asm'
    ]);
    const threeCharOps = new Set(['<<=', '>>=', '...']);
    const twoCharOps = new Set(['<=', '>=', '==', '!=', '&&', '||', '++', '--', '<<', '>>', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']);

    const advanceChar = (ch = source[i]) => {
      i += 1;
      if (ch === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
    };

    const pushToken = (type, value, startLine, startCol) => {
      tokens.push({ type, value, line: startLine, col: startCol });
    };

    const readCharLiteral = () => {
      const startLine = line;
      const startCol = col;
      advanceChar("'");
      let value = 0;
      if (source[i] === '\\') {
        advanceChar('\\');
        const escaped = source[i];
        const escapes = { n: 10, r: 13, t: 9, '\\': 92, "'": 39, '0': 0 };
        value = escapes[escaped] ?? source.charCodeAt(i);
        advanceChar();
      } else {
        value = source.charCodeAt(i);
        advanceChar();
      }
      if (source[i] !== "'") throw new Error('Littéral caractère invalide');
      advanceChar("'");
      pushToken('num', value | 0, startLine, startCol);
    };

    const readStringLiteral = () => {
      const startLine = line;
      const startCol = col;
      advanceChar('"');
      let out = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          advanceChar('\\');
          const escaped = source[i];
          const escapes = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '0': '\0' };
          out += escapes[escaped] ?? escaped;
          advanceChar();
        } else {
          out += source[i];
          advanceChar();
        }
      }
      if (source[i] !== '"') throw new Error('Chaîne non terminée');
      advanceChar('"');
      pushToken('string', out, startLine, startCol);
    };

    while (i < source.length) {
      const ch = source[i];
      if (/\s/.test(ch)) { advanceChar(); continue; }
      const startLine = line;
      const startCol = col;
      const three = source.slice(i, i + 3);
      if (threeCharOps.has(three)) {
        pushToken('op', three, startLine, startCol);
        advanceChar(three[0]);
        advanceChar(three[1]);
        advanceChar(three[2]);
        continue;
      }
      const two = source.slice(i, i + 2);
      if (twoCharOps.has(two)) {
        pushToken('op', two, startLine, startCol);
        advanceChar(two[0]);
        advanceChar(two[1]);
        continue;
      }
      if (ch === "'") { readCharLiteral(); continue; }
      if (ch === '"') { readStringLiteral(); continue; }
      if (/[0-9]/.test(ch)) {
        let j = i;
        if (source[j] === '0' && (source[j + 1] === 'x' || source[j + 1] === 'X')) {
          j += 2;
          while (/[0-9a-fA-F]/.test(source[j])) j++;
          while (/[uUlL]/.test(source[j])) j++;
          pushToken('num', parseInt(source.slice(i, j).replace(/[uUlL]+$/g, ''), 16) | 0, startLine, startCol);
          while (i < j) advanceChar();
          continue;
        }
        while (/[0-9]/.test(source[j])) j++;
        let isFloat = false;
        if (source[j] === '.' && /[0-9]/.test(source[j + 1])) {
          isFloat = true;
          j++;
          while (/[0-9]/.test(source[j])) j++;
        }
        if (/[eE]/.test(source[j]) && /[+\-0-9]/.test(source[j + 1] || '')) {
          isFloat = true;
          j++;
          if (/[+\-]/.test(source[j])) j++;
          while (/[0-9]/.test(source[j])) j++;
        }
        while (/[uUlLfF]/.test(source[j])) j++;
        const raw = source.slice(i, j).replace(/[uUlLfF]+$/g, '');
        const value = isFloat ? Math.trunc(parseFloat(raw) || 0) : (parseInt(raw, 10) | 0);
        pushToken('num', value | 0, startLine, startCol);
        while (i < j) advanceChar();
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (/[A-Za-z0-9_]/.test(source[j])) j++;
        const value = source.slice(i, j);
        pushToken(keywords.has(value) ? 'kw' : 'id', value, startLine, startCol);
        while (i < j) advanceChar();
        continue;
      }
      if ('{}()[];,+-*/%<>=!&|^~,.?:'.includes(ch)) {
        pushToken('op', ch, startLine, startCol);
        advanceChar();
        continue;
      }
      throw new Error(`Caractère inattendu: ${ch}`);
    }

    pushToken('eof', '<eof>', line, col);
    return tokens;
  }
  // ---------- Parsing ----------

  parse(source, filename) {
    const ts = new TokenStream(this.tokenize(this.preprocess(source, filename)));
    const globals = [];
    const functions = [];

    while (ts.peek().type !== 'eof') {
      const external = this.parseExternal(ts);
      if (!external) continue;
      if (external.kind === 'function') functions.push(external.value);
      else if (external.kind === 'global') globals.push(...external.values);
    }

    return { globals, functions };
  }

  parseExternal(ts) {
    const storage = this.parseStorageClass(ts);
    const baseType = this.parseType(ts, { allowVoid: true, allowAnonymousDefinition: true });

    if (ts.match(';')) return null;

    const items = [];
    do {
      const declarator = this.parseDeclarator(ts, baseType);
      if (declarator.kind === 'function') {
        const fn = {
          type: 'Function',
          returnType: declarator.type,
          name: declarator.name,
          params: declarator.params,
          prototype: true,
          body: null,
        };
        if (ts.peek().value === '{') {
          fn.prototype = false;
          fn.body = this.parseBlock(ts);
          return { kind: 'function', value: fn };
        }
        this.functionPrototypes.set(fn.name, fn);
        continue;
      }

      let init = null;
      if (ts.match('=')) {
        init = this.parseInitializer(ts, declarator.type);
      }

      if (storage === 'typedef') {
        this.typeAliases.set(declarator.name, cloneType(declarator.type));
      } else {
        items.push({
          type: 'Global',
          baseType: declarator.type,
          name: declarator.name,
          arraySize: declarator.arraySize,
          init,
          storage,
        });
      }
    } while (ts.match(','));
    ts.expect(';');
    return items.length ? { kind: 'global', values: items } : null;
  }

  parseStorageClass(ts) {
    let storage = null;
    while (STORAGE_CLASS.has(ts.peek().value)) {
      const current = ts.next().value;
      if (current === 'typedef' || current === 'extern' || current === 'static') storage = current;
    }
    return storage;
  }

  parseType(ts, options = {}) {
    let base = null;
    const consumed = [];

    while (TYPE_QUALIFIERS.has(ts.peek().value)) consumed.push(ts.next().value);

    while (BORLAND_QUALIFIERS.has(ts.peek().value)) consumed.push(ts.next().value);

    if (ts.peek().value === 'struct') {
      base = this.parseStructSpecifier(ts);
    } else if (ts.peek().value === 'union') {
      base = this.parseUnionSpecifier(ts);
    } else if (ts.peek().value === 'enum') {
      base = this.parseEnumSpecifier(ts);
    } else {
      while (PRIMITIVE_OR_QUAL.has(ts.peek().value)) consumed.push(ts.next().value);
      const typeName = consumed.find((v) => BUILTIN_TYPES.has(v)) || null;
      if (typeName) {
        base = primitiveType(typeName === 'void' ? 'void' : 'int');
      } else if (this.typeAliases.has(ts.peek().value)) {
        base = cloneType(this.typeAliases.get(ts.next().value));
      } else if (consumed.length) {
        base = primitiveType('int');
      }
    }

    if (!base) {
      if (options.allowAnonymousDefinition && ts.peek().value === ';') return null;
      throw new Error(`Type inattendu: ${ts.peek().value}`);
    }
    return base;
  }

  parseAggregateSpecifier(ts, aggregateKind = 'struct') {
    ts.expect(aggregateKind);
    const name = ts.peek().type === 'id' ? ts.next().value : null;
    if (!ts.match('{')) {
      if (!name || !this.structTypes.has(name)) {
        return { kind: aggregateKind, name, pointerDepth: 0, sizeWords: 1, fields: new Map() };
      }
      return cloneType(this.structTypes.get(name));
    }

    const fields = new Map();
    let offset = 0;
    let maxFieldSize = 1;
    while (!ts.match('}')) {
      const fieldBase = this.parseType(ts, { allowVoid: false });
      do {
        const fieldDecl = this.parseDeclarator(ts, fieldBase, { allowFunction: false });
        const fieldSize = this.symbolSize(fieldDecl.type, fieldDecl.arraySize);
        const fieldOffset = aggregateKind === 'union' ? 0 : offset;
        fields.set(fieldDecl.name, {
          name: fieldDecl.name,
          offset: fieldOffset,
          size: fieldSize,
          type: fieldDecl.arraySize ? { ...cloneType(fieldDecl.type), sizeWords: this.typeSize(fieldDecl.type) } : cloneType(fieldDecl.type),
          arrayLength: fieldDecl.arraySize,
        });
        if (aggregateKind === 'union') maxFieldSize = Math.max(maxFieldSize, fieldSize);
        else offset += fieldSize;
      } while (ts.match(','));
      ts.expect(';');
    }

    const sizeWords = aggregateKind === 'union' ? Math.max(1, maxFieldSize) : Math.max(1, offset);
    const type = { kind: aggregateKind, name, pointerDepth: 0, sizeWords, fields };
    if (name) this.structTypes.set(name, cloneType(type));
    return type;
  }

  parseStructSpecifier(ts) {
    return this.parseAggregateSpecifier(ts, 'struct');
  }

  parseUnionSpecifier(ts) {
    return this.parseAggregateSpecifier(ts, 'union');
  }


  parseEnumSpecifier(ts) {
    ts.expect('enum');
    const name = ts.peek().type === 'id' ? ts.next().value : null;
    if (ts.match('{')) {
      let current = -1;
      while (true) {
        if (ts.peek().value === '}') { ts.next(); break; }
        const enumName = ts.expectType('id').value;
        if (ts.match('=')) current = this.parseConstantExpression(ts);
        else current += 1;
        this.constants.set(enumName, current | 0);
        if (!ts.match(',')) {
          ts.expect('}');
          break;
        }
      }
    } else if (!name) {
      throw new Error('enum anonyme invalide');
    }
    return primitiveType('int');
  }

  parseDeclarator(ts, baseType, options = {}) {
    let pointerDepth = 0;
    while (BORLAND_QUALIFIERS.has(ts.peek().value)) ts.next();
    while (ts.match('*')) {
      pointerDepth++;
      while (BORLAND_QUALIFIERS.has(ts.peek().value)) ts.next();
    }

    let name;
    let groupedInner = null;
    if (ts.match('(')) {
      groupedInner = this.parseDeclarator(ts, baseType, options);
      while (BORLAND_QUALIFIERS.has(ts.peek().value)) ts.next();
      ts.expect(')');
      name = groupedInner.name;
      pointerDepth += groupedInner.type.pointerDepth | 0;
    } else if (BORLAND_QUALIFIERS.has(ts.peek().value)) {
      while (BORLAND_QUALIFIERS.has(ts.peek().value)) ts.next();
      if (ts.match('(')) {
        groupedInner = this.parseDeclarator(ts, baseType, options);
        while (BORLAND_QUALIFIERS.has(ts.peek().value)) ts.next();
        ts.expect(')');
        name = groupedInner.name;
        pointerDepth += groupedInner.type.pointerDepth | 0;
      } else if (ts.peek().type === 'id') {
        name = ts.next().value;
      } else {
        if (options.allowAnonymousName) name = this.newLabel('__anon_param');
        else throw new Error(`Nom de déclarateur attendu, reçu ${ts.peek().value}`);
      }
    } else if (ts.peek().type === 'id') {
      name = ts.next().value;
    } else {
      if (options.allowAnonymousName) {
        name = this.newLabel('__anon_param');
      } else {
        throw new Error(`Nom de déclarateur attendu, reçu ${ts.peek().value}`);
      }
    }

    const type = cloneType(baseType || primitiveType('int'));
    type.pointerDepth = (type.pointerDepth | 0) + pointerDepth;
    if (type.pointerDepth > 0) {
      type.sizeWords = 1;
      if (!(type.kind === 'struct' || type.kind === 'union' || type.fields)) {
        type.kind = 'int';
        type.fields = null;
      }
    }

    let arraySize = null;
    while (ts.match('[')) {
      if (!ts.match(']')) {
        arraySize = this.parseConstantExpression(ts);
        ts.expect(']');
      } else {
        arraySize = 0;
      }
    }

    const groupedWasPointer = !!(groupedInner && groupedInner.kind === 'object' && ((groupedInner.type.pointerDepth | 0) > 0 || groupedInner.type.functionPointer));
    while (BORLAND_QUALIFIERS.has(ts.peek().value)) ts.next();
    if ((options.allowFunction !== false || groupedWasPointer) && ts.match('(')) {
      const params = [];
      let variadic = false;
      if (!ts.match(')')) {
        let explicitVoidOnly = false;
        do {
          if (ts.peek().value === 'void' && ts.peek(1).value === ')') {
            ts.next();
            explicitVoidOnly = true;
            break;
          }
          if (ts.peek().value === '...') {
            ts.next();
            variadic = true;
            break;
          }
          const paramType = this.parseType(ts, { allowVoid: true });
          const paramDecl = this.parseDeclarator(ts, paramType, { allowAnonymousName: true, allowFunction: false });
          params.push({ type: paramDecl.type, name: paramDecl.name, arraySize: paramDecl.arraySize });
        } while (ts.match(','));
        if (explicitVoidOnly || !variadic || ts.peek().value === ')') ts.expect(')');
      }
      if (groupedWasPointer) {
        type.functionPointer = true;
        type.fnParams = params;
        type.returnType = cloneType(baseType || primitiveType('int'));
        type.variadic = variadic;
        return { kind: 'object', name, type, arraySize };
      }
      return { kind: 'function', name, type, params, variadic };
    }

    return { kind: 'object', name, type, arraySize };
  }

  parseInitializer(ts, type) {
    if (ts.match('{')) {
      const values = [];
      if (!ts.match('}')) {
        while (true) {
          if (ts.peek().value === '}') break;
          if (ts.peek().value === '{') values.push(this.parseInitializer(ts, type));
          else if (ts.peek().type === 'string') values.push(this.parseInitializer(ts, type));
          else values.push(this.parseAssignment(ts));
          if (!ts.match(',')) break;
        }
        ts.expect('}');
      }
      return values;
    }
    if (ts.peek().type === 'string') {
      let text = '';
      while (ts.peek().type === 'string') text += ts.next().value;
      return [...text].map((ch) => ch.charCodeAt(0)).concat(0);
    }
    return this.parseAssignment(ts);
  }

  parseBlock(ts) {
    ts.expect('{');
    const statements = [];
    while (!ts.match('}')) statements.push(this.parseStatement(ts));
    return { type: 'Block', statements };
  }

  isTypeStart(ts) {
    const v = ts.peek().value;
    if (STORAGE_CLASS.has(v) || TYPE_QUALIFIERS.has(v) || BORLAND_QUALIFIERS.has(v) || BUILTIN_TYPES.has(v) || v === 'struct' || v === 'union' || v === 'enum') return true;
    if (!this.typeAliases.has(v)) return false;
    const next = ts.peek(1).value;
    if (next === '[' || next === '=' || next === '++' || next === '--' || next === '.' || next === '->') return false;
    return true;
  }

  parseStatement(ts) {
    const token = ts.peek();
    if (token.value === '{') return this.parseBlock(ts);
    if (ASM_KEYWORDS.has(token.value)) return this.parseAsmStatement(ts);
    if (token.type === 'id' && ts.peek(1).value === ':') {
      const name = ts.next().value;
      ts.expect(':');
      return { type: 'Label', name, statement: this.parseStatement(ts) };
    }
    if (this.isTypeStart(ts)) return this.parseDeclarationStatement(ts);
    if (token.value === 'while') return this.parseWhile(ts);
    if (token.value === 'do') return this.parseDoWhile(ts);
    if (token.value === 'for') return this.parseFor(ts);
    if (token.value === 'if') return this.parseIf(ts);
    if (token.value === 'switch') return this.parseSwitch(ts);
    if (token.value === 'return') return this.parseReturn(ts);
    if (token.value === 'break') return this.parseBreak(ts);
    if (token.value === 'continue') return this.parseContinue(ts);
    if (token.value === 'goto') return this.parseGoto(ts);
    if (token.value === ';') { ts.next(); return { type: 'Empty' }; }
    const expr = this.parseExpression(ts);
    ts.expect(';');
    return { type: 'ExprStmt', expr };
  }

  parseDeclarationStatement(ts) {
    const storage = this.parseStorageClass(ts);
    const baseType = this.parseType(ts, { allowVoid: false, allowAnonymousDefinition: true });
    if (ts.match(';')) return { type: 'Empty' };
    const declarations = [];
    do {
      const decl = this.parseDeclarator(ts, baseType, { allowFunction: true });
      if (decl.kind === 'function') {
        this.functionPrototypes.set(decl.name, {
          type: 'Function',
          returnType: decl.type,
          name: decl.name,
          params: decl.params,
          variadic: !!decl.variadic,
          prototype: true,
          body: null,
          localOnly: true,
        });
        continue;
      }
      let init = null;
      if (ts.match('=')) init = this.parseInitializer(ts, decl.type);
      if (storage === 'typedef') {
        this.typeAliases.set(decl.name, cloneType(decl.type));
        continue;
      }
      declarations.push({ name: decl.name, type: decl.type, arraySize: decl.arraySize, init });
    } while (ts.match(','));
    ts.expect(';');
    return declarations.length ? { type: 'DeclStmt', declarations } : { type: 'Empty' };
  }

  parseWhile(ts) {
    ts.expect('while');
    ts.expect('(');
    const condition = this.parseExpression(ts);
    ts.expect(')');
    return { type: 'While', condition, body: this.parseStatement(ts) };
  }

  parseDoWhile(ts) {
    ts.expect('do');
    const body = this.parseStatement(ts);
    ts.expect('while');
    ts.expect('(');
    const condition = this.parseExpression(ts);
    ts.expect(')');
    ts.expect(';');
    return { type: 'DoWhile', condition, body };
  }

  parseFor(ts) {
    ts.expect('for');
    ts.expect('(');
    let init = null;
    if (!ts.match(';')) {
      if (this.isTypeStart(ts)) init = this.parseDeclarationStatement(ts);
      else {
        init = this.parseExpression(ts);
        ts.expect(';');
      }
    }
    let condition = null;
    if (!ts.match(';')) {
      condition = this.parseExpression(ts);
      ts.expect(';');
    }
    let post = null;
    if (!ts.match(')')) {
      post = this.parseExpression(ts);
      ts.expect(')');
    }
    return { type: 'For', init, condition, post, body: this.parseStatement(ts) };
  }

  parseSwitch(ts) {
    ts.expect('switch');
    ts.expect('(');
    const discriminant = this.parseExpression(ts);
    ts.expect(')');
    ts.expect('{');
    const cases = [];
    let current = null;
    while (!ts.match('}')) {
      if (ts.match('case')) {
        current = { value: this.parseConstantExpression(ts), statements: [] };
        ts.expect(':');
        cases.push(current);
        continue;
      }
      if (ts.match('default')) {
        current = { value: null, statements: [] };
        ts.expect(':');
        cases.push(current);
        continue;
      }
      if (!current) throw new Error('Instruction dans switch hors case/default');
      current.statements.push(this.parseStatement(ts));
    }
    return { type: 'Switch', discriminant, cases };
  }

  parseIf(ts) {
    ts.expect('if');
    ts.expect('(');
    const condition = this.parseExpression(ts);
    ts.expect(')');
    const thenBranch = this.parseStatement(ts);
    const elseBranch = ts.match('else') ? this.parseStatement(ts) : null;
    return { type: 'If', condition, thenBranch, elseBranch };
  }

  parseReturn(ts) {
    ts.expect('return');
    if (ts.match(';')) return { type: 'Return', expr: null };
    const expr = this.parseExpression(ts);
    ts.expect(';');
    return { type: 'Return', expr };
  }

  parseBreak(ts) { ts.expect('break'); ts.expect(';'); return { type: 'Break' }; }
  parseContinue(ts) { ts.expect('continue'); ts.expect(';'); return { type: 'Continue' }; }
  parseGoto(ts) { ts.expect('goto'); const label = ts.expectType('id').value; ts.expect(';'); return { type: 'Goto', label }; }

  parseAsmStatement(ts) {
    const keyword = ts.next().value;
    if (!ASM_KEYWORDS.has(keyword)) throw new Error(`Attendu asm/__asm, reçu ${keyword}`);
    if (ts.match('{')) {
      let depth = 1;
      while (depth > 0) {
        const token = ts.next();
        if (token.type === 'eof') throw new Error('Bloc asm non refermé');
        if (token.value === '{') depth += 1;
        else if (token.value === '}') depth -= 1;
      }
      ts.match(';');
      return { type: 'AsmStmt' };
    }
    if (ts.match('(')) {
      let depth = 1;
      while (depth > 0) {
        const token = ts.next();
        if (token.type === 'eof') throw new Error('Appel asm non refermé');
        if (token.value === '(') depth += 1;
        else if (token.value === ')') depth -= 1;
      }
      ts.expect(';');
      return { type: 'AsmStmt' };
    }
    const startLine = ts.peek().line;
    while (true) {
      if (ts.peek().type === 'eof') throw new Error('Instruction asm non terminée');
      if (ts.peek().value === ';') { ts.next(); break; }
      if (ts.peek().line != null && ts.peek().line !== startLine) break;
      ts.next();
    }
    return { type: 'AsmStmt' };
  }

  parseConstantExpression(ts) {
    return this.evaluateConst(this.parseAssignment(ts));
  }

  parseExpression(ts) { return this.parseComma(ts); }

  parseComma(ts) {
    let node = this.parseAssignment(ts);
    while (ts.match(',')) node = { type: 'Comma', left: node, right: this.parseAssignment(ts) };
    return node;
  }

  parseAssignment(ts) {
    const left = this.parseConditional(ts);
    const assignOps = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
    if (assignOps.has(ts.peek().value)) {
      const op = ts.next().value;
      return { type: op === '=' ? 'Assign' : 'CompoundAssign', op, left, right: this.parseAssignment(ts) };
    }
    return left;
  }

  parseConditional(ts) {
    const cond = this.parseLogicalOr(ts);
    if (!ts.match('?')) return cond;
    const thenExpr = this.parseExpression(ts);
    ts.expect(':');
    const elseExpr = this.parseConditional(ts);
    return { type: 'Conditional', condition: cond, thenExpr, elseExpr };
  }

  parseLogicalOr(ts) {
    let node = this.parseLogicalAnd(ts);
    while (ts.match('||')) node = { type: 'Binary', op: '||', left: node, right: this.parseLogicalAnd(ts) };
    return node;
  }

  parseLogicalAnd(ts) {
    let node = this.parseBitwiseOr(ts);
    while (ts.match('&&')) node = { type: 'Binary', op: '&&', left: node, right: this.parseBitwiseOr(ts) };
    return node;
  }

  parseBitwiseOr(ts) {
    let node = this.parseBitwiseXor(ts);
    while (ts.match('|')) node = { type: 'Binary', op: '|', left: node, right: this.parseBitwiseXor(ts) };
    return node;
  }

  parseBitwiseXor(ts) {
    let node = this.parseBitwiseAnd(ts);
    while (ts.match('^')) node = { type: 'Binary', op: '^', left: node, right: this.parseBitwiseAnd(ts) };
    return node;
  }

  parseBitwiseAnd(ts) {
    let node = this.parseEquality(ts);
    while (ts.match('&')) node = { type: 'Binary', op: '&', left: node, right: this.parseEquality(ts) };
    return node;
  }

  parseEquality(ts) {
    let node = this.parseRelational(ts);
    while (['==', '!='].includes(ts.peek().value)) {
      const op = ts.next().value;
      node = { type: 'Binary', op, left: node, right: this.parseRelational(ts) };
    }
    return node;
  }

  parseRelational(ts) {
    let node = this.parseShift(ts);
    while (['<', '>', '<=', '>='].includes(ts.peek().value)) {
      const op = ts.next().value;
      node = { type: 'Binary', op, left: node, right: this.parseShift(ts) };
    }
    return node;
  }

  parseShift(ts) {
    let node = this.parseAdditive(ts);
    while (['<<', '>>'].includes(ts.peek().value)) {
      const op = ts.next().value;
      node = { type: 'Binary', op, left: node, right: this.parseAdditive(ts) };
    }
    return node;
  }

  parseAdditive(ts) {
    let node = this.parseMultiplicative(ts);
    while (['+', '-'].includes(ts.peek().value)) {
      const op = ts.next().value;
      node = { type: 'Binary', op, left: node, right: this.parseMultiplicative(ts) };
    }
    return node;
  }

  parseMultiplicative(ts) {
    let node = this.parseUnary(ts);
    while (['*', '/', '%'].includes(ts.peek().value)) {
      const op = ts.next().value;
      node = { type: 'Binary', op, left: node, right: this.parseUnary(ts) };
    }
    return node;
  }

  looksLikeCast(ts) {
    if (ts.peek().value !== '(') return false;
    const probe = new TokenStream(ts.tokens);
    probe.index = ts.index + 1;
    if (!this.isTypeStart(probe)) return false;
    try {
      this.parseType(probe, { allowVoid: true, allowAnonymousDefinition: true });
      while (BORLAND_QUALIFIERS.has(probe.peek().value)) probe.next();
      while (probe.match('*')) {
        while (BORLAND_QUALIFIERS.has(probe.peek().value)) probe.next();
      }
      return probe.peek().value === ')';
    } catch (_) {
      return false;
    }
  }

  parseUnary(ts) {
    const token = ts.peek();
    if (token.value === '(' && this.looksLikeCast(ts)) {
      ts.expect('(');
      const castType = this.parseType(ts, { allowVoid: true, allowAnonymousDefinition: true });
      while (BORLAND_QUALIFIERS.has(ts.peek().value)) ts.next();
      let pointerDepth = 0;
      while (ts.match('*')) {
        pointerDepth++;
        while (BORLAND_QUALIFIERS.has(ts.peek().value)) ts.next();
      }
      ts.expect(')');
      castType.pointerDepth = (castType.pointerDepth | 0) + pointerDepth;
      if (castType.pointerDepth > 0) {
        castType.sizeWords = 1;
        if (!(castType.kind === 'struct' || castType.kind === 'union' || castType.fields)) {
          castType.kind = 'int';
          castType.fields = null;
        }
      }
      return { type: 'Cast', targetType: castType, expr: this.parseUnary(ts) };
    }
    if (['+', '-', '*', '&', '!', '~'].includes(token.value)) {
      return { type: 'Unary', op: ts.next().value, expr: this.parseUnary(ts) };
    }
    if (token.value === 'sizeof') {
      ts.next();
      ts.expect('(');
      if (this.isTypeStart(ts)) {
        const typ = this.parseType(ts, { allowVoid: true });
        let pointerDepth = 0;
        while (ts.match('*')) pointerDepth++;
        ts.expect(')');
        typ.pointerDepth = (typ.pointerDepth | 0) + pointerDepth;
        return { type: 'Literal', value: this.typeSize(typ) };
      }
      const expr = this.parseExpression(ts);
      ts.expect(')');
      return { type: 'Sizeof', expr };
    }
    if (token.value === '++' || token.value === '--') {
      return { type: 'PreIncDec', op: ts.next().value, expr: this.parseUnary(ts) };
    }
    return this.parsePostfix(ts);
  }

  parsePostfix(ts) {
    let node = this.parsePrimary(ts);
    while (true) {
      if (ts.match('[')) {
        const index = this.parseExpression(ts);
        ts.expect(']');
        node = { type: 'Index', array: node, index };
        continue;
      }
      if (ts.match('(')) {
        const args = [];
        if (!ts.match(')')) {
          do args.push(this.parseAssignment(ts)); while (ts.match(','));
          ts.expect(')');
        }
        node = { type: 'Call', callee: node, args };
        continue;
      }
      if (ts.match('.')) {
        node = { type: 'Member', object: node, field: ts.expectType('id').value, throughPointer: false };
        continue;
      }
      if (ts.match('->')) {
        node = { type: 'Member', object: node, field: ts.expectType('id').value, throughPointer: true };
        continue;
      }
      if (ts.peek().value === '++' || ts.peek().value === '--') {
        node = { type: 'PostIncDec', op: ts.next().value, expr: node };
        continue;
      }
      break;
    }
    return node;
  }

  parsePrimary(ts) {
    const token = ts.next();
    if (token.type === 'num') return { type: 'Literal', value: token.value | 0 };
    if (token.type === 'string') {
      let value = token.value;
      while (ts.peek().type === 'string') value += ts.next().value;
      return { type: 'StringLiteral', value };
    }
    if (token.type === 'id') {
      if (this.constants.has(token.value)) return { type: 'Literal', value: this.constants.get(token.value) | 0 };
      return { type: 'Identifier', name: token.value };
    }
    if (token.value === '(') {
      const expr = this.parseExpression(ts);
      ts.expect(')');
      return expr;
    }
    throw new Error(`Expression primaire inattendue: ${token.value}`);
  }

  // ---------- Semantic helpers ----------

  typeSize(type) {
    if (!type) return 1;
    if ((type.pointerDepth | 0) > 0) return 1;
    if (type.kind === 'struct' || type.kind === 'union') return Math.max(1, type.sizeWords | 0);
    return type.kind === 'void' ? 0 : 1;
  }

  resolveArraySize(type, arraySize = null, init = null) {
    if (arraySize == null) return null;
    if ((arraySize | 0) !== 0) return arraySize | 0;
    if (Array.isArray(init)) return Math.max(1, init.length | 0);
    return 1;
  }

  symbolSize(type, arraySize = null, init = null) {
    const resolved = this.resolveArraySize(type, arraySize, init);
    const count = resolved != null ? (resolved | 0) : 1;
    return Math.max(1, this.typeSize(type) * Math.max(1, count));
  }

  symbolIsAggregate(sym) {
    return !!(sym && (sym.arraySize != null || this.typeSize(sym.type) > 1));
  }

  dereferenceType(type) {
    const inner = cloneType(type || primitiveType('int'));
    if ((inner.pointerDepth | 0) > 0) inner.pointerDepth -= 1;
    if ((inner.pointerDepth | 0) > 0) return inner;
    if (inner.kind === 'struct' || inner.kind === 'union' || inner.fields) return inner;
    return primitiveType(inner.kind === 'void' ? 'void' : 'int');
  }

  resolveTypeOfNode(node, env) {
    if (!node) return primitiveType('int');
    if (node.type === 'Identifier') {
      if ((env && env.has(node.name)) || this.globals.has(node.name)) return cloneType(this.lookupSymbol(node.name, env).type);
      if (this.functions.has(node.name) || this.functionPrototypes.has(node.name)) {
        return { kind: 'int', name: null, pointerDepth: 1, sizeWords: 1, fields: null, functionPointer: true, fnParams: null, returnType: primitiveType('int') };
      }
      return primitiveType('int');
    }
    if (node.type === 'Unary' && node.op === '&') {
      const inner = this.resolveTypeOfNode(node.expr, env);
      inner.pointerDepth = (inner.pointerDepth | 0) + 1;
      inner.kind = 'int';
      inner.sizeWords = 1;
      inner.fields = null;
      return inner;
    }
    if (node.type === 'Unary' && node.op === '*') {
      return this.dereferenceType(this.resolveTypeOfNode(node.expr, env));
    }
    if (node.type === 'Index') {
      return cloneType(this.resolveIndexedElementType(node.array, env));
    }
    if (node.type === 'Member') {
      const info = this.resolveMemberInfo(node, env);
      return cloneType(info.type);
    }
    if (node.type === 'Cast') {
      return cloneType(node.targetType);
    }
    if (node.type === 'Call') {
      const calleeType = this.resolveTypeOfNode(node.callee, env);
      if (calleeType && calleeType.functionPointer && calleeType.returnType) return cloneType(calleeType.returnType);
      return primitiveType('int');
    }
    if (node.type === 'Binary' && (node.op === '+' || node.op === '-')) {
      const leftType = this.resolveTypeOfNode(node.left, env);
      const rightType = this.resolveTypeOfNode(node.right, env);
      if ((leftType.pointerDepth | 0) > 0 && (rightType.pointerDepth | 0) === 0) return cloneType(leftType);
      if (node.op === '+' && (rightType.pointerDepth | 0) > 0 && (leftType.pointerDepth | 0) === 0) return cloneType(rightType);
      return primitiveType('int');
    }
    if (node.type === 'StringLiteral') {
      return { kind: 'int', name: null, pointerDepth: 1, sizeWords: 1, fields: null };
    }
    return primitiveType('int');
  }

  evaluateConst(node) {
    switch (node.type) {
      case 'Literal': return node.value | 0;
      case 'Unary': {
        if (node.op === '&' && node.expr && node.expr.type === 'Identifier') {
          if (this.globals.has(node.expr.name)) return this.globals.get(node.expr.name).address | 0;
          if (this.functions.has(node.expr.name) || this.functionPrototypes.has(node.expr.name)) return 0;
        }
        const v = this.evaluateConst(node.expr);
        if (node.op === '+') return v;
        if (node.op === '-') return -v;
        if (node.op === '!') return v ? 0 : 1;
        if (node.op === '~') return ~v;
        break;
      }
      case 'Binary': {
        const lhs = this.evaluateConst(node.left);
        const rhs = this.evaluateConst(node.right);
        switch (node.op) {
          case '+': return lhs + rhs;
          case '-': return lhs - rhs;
          case '*': return lhs * rhs;
          case '/': return rhs === 0 ? 0 : Math.trunc(lhs / rhs);
          case '%': return rhs === 0 ? 0 : lhs % rhs;
          case '<<': return lhs << rhs;
          case '>>': return lhs >> rhs;
          case '&': return lhs & rhs;
          case '|': return lhs | rhs;
          case '^': return lhs ^ rhs;
          case '<': return lhs < rhs ? 1 : 0;
          case '>': return lhs > rhs ? 1 : 0;
          case '<=': return lhs <= rhs ? 1 : 0;
          case '>=': return lhs >= rhs ? 1 : 0;
          case '==': return lhs === rhs ? 1 : 0;
          case '!=': return lhs !== rhs ? 1 : 0;
          case '&&': return (lhs && rhs) ? 1 : 0;
          case '||': return (lhs || rhs) ? 1 : 0;
        }
        break;
      }
      case 'Conditional':
        return this.evaluateConst(node.condition) ? this.evaluateConst(node.thenExpr) : this.evaluateConst(node.elseExpr);
      case 'Comma':
        this.evaluateConst(node.left);
        return this.evaluateConst(node.right);
      case 'Identifier':
        if (this.constants.has(node.name)) return this.constants.get(node.name) | 0;
        if (this.functions.has(node.name) || this.functionPrototypes.has(node.name)) return 0;
        if (this.globals.has(node.name)) return this.globals.get(node.name).address | 0;
        break;
      case 'Sizeof':
        return this.typeSize(this.resolveTypeOfNode(node.expr));
      case 'Cast':
        return this.evaluateConst(node.expr);
      case 'StringLiteral':
        return 0;
    }
    throw new Error('Expression constante non supportée');
  }

  // ---------- Allocation ----------

  nextDataAddress() {
    let next = Math.max((this.dataBase + this.dataImage.length) | 0, this.nextDataFloor | 0);
    for (const sym of this.globals.values()) {
      if (!sym || sym.address == null || sym.size == null) continue;
      next = Math.max(next, (sym.address + sym.size) | 0);
    }
    return next | 0;
  }

  ensureDataCapacityForAddress(address, size = 1) {
    const endIndex = (address - this.dataBase + size) | 0;
    if (endIndex < 0) throw new Error(`Data address out of range: ${address}`);
    while (this.dataImage.length < endIndex) this.dataImage.push(0);
  }

  writeDataWordsAtAddress(address, words) {
    this.ensureDataCapacityForAddress(address, words.length);
    const baseIndex = (address - this.dataBase) | 0;
    for (let i = 0; i < words.length; i++) this.dataImage[baseIndex + i] = words[i] | 0;
  }

  allocateStringFromInitializer(values) {
    const chars = Array.isArray(values) ? values.map((v) => (typeof v === 'number' ? (v | 0) : this.evaluateConst(v) | 0)) : [];
    const zeroTerminated = chars.length && chars[chars.length - 1] === 0 ? chars : chars.concat(0);
    const key = `__initstr_${zeroTerminated.join(',')}`;
    if (this.globals.has(key)) return this.globals.get(key).address;
    const address = this.nextDataAddress();
    const sym = {
      kind: 'global',
      name: key,
      address,
      size: zeroTerminated.length,
      type: { kind: 'int', name: null, pointerDepth: 1, sizeWords: 1, fields: null },
      arraySize: zeroTerminated.length,
    };
    this.globals.set(key, sym);
    this.writeDataWordsAtAddress(address, zeroTerminated);
    return address;
  }

  flattenInitializer(type, arraySize, init) {
    if (init == null) return [];
    if (arraySize != null) {
      const elementType = cloneType(type);
      const values = [];
      const items = Array.isArray(init) ? init : [init];
      for (const item of items) {
        if (values.length >= arraySize) break;
        if (Array.isArray(item)) {
          if ((elementType.pointerDepth | 0) > 0) {
            values.push(this.allocateStringFromInitializer(item));
            continue;
          }
          const nested = this.flattenInitializer(elementType, null, item);
          for (const value of nested) {
            if (values.length >= arraySize) break;
            values.push(value);
          }
          continue;
        }
        values.push(typeof item === 'number' ? (item | 0) : (this.evaluateConst(item) | 0));
      }
      while (values.length < arraySize) values.push(0);
      return values;
    }

    if (Array.isArray(init)) {
      if ((type.pointerDepth | 0) > 0) {
        return [this.allocateStringFromInitializer(init)];
      }
      const values = [];
      for (const item of init) {
        if (Array.isArray(item)) values.push(...this.flattenInitializer(type, null, item));
        else values.push(typeof item === 'number' ? (item | 0) : (this.evaluateConst(item) | 0));
      }
      return values;
    }

    return [typeof init === 'number' ? (init | 0) : (this.evaluateConst(init) | 0)];
  }

  allocateGlobals(globals) {
    let nextAddr = this.nextDataAddress();
    for (const g of globals) {
      const resolvedArraySize = this.resolveArraySize(g.baseType, g.arraySize, g.init);
      const size = this.symbolSize(g.baseType, resolvedArraySize, g.init);
      let sym = this.globals.get(g.name);
      if (sym && sym.address != null) {
        sym = {
          ...sym,
          kind: 'global',
          name: g.name,
          size,
          type: cloneType(g.baseType),
          arraySize: resolvedArraySize,
          extern: g.storage === 'extern',
        };
      } else {
        sym = { kind: 'global', name: g.name, address: nextAddr, size, type: cloneType(g.baseType), arraySize: resolvedArraySize, extern: g.storage === 'extern' };
      }
      this.globals.set(g.name, sym);
      this.ensureDataCapacityForAddress(sym.address, size);
      const flat = this.flattenInitializer(g.baseType, resolvedArraySize, g.init).slice(0, size);
      this.writeDataWordsAtAddress(sym.address, flat.concat(Array(Math.max(0, size - flat.length)).fill(0)));
      nextAddr = Math.max(nextAddr, (sym.address + size) | 0);
    }
  }

  collectLocals(node, out = [], seen = new Set()) {
    const visit = (n) => {
      if (!n) return;
      switch (n.type) {
        case 'Block': n.statements.forEach(visit); break;
        case 'DeclStmt':
          for (const decl of n.declarations) {
            if (seen.has(decl.name)) continue;
            seen.add(decl.name);
            const resolvedArraySize = this.resolveArraySize(decl.type, decl.arraySize, decl.init);
            out.push({ name: decl.name, type: cloneType(decl.type), arraySize: resolvedArraySize, size: this.symbolSize(decl.type, resolvedArraySize, decl.init) });
          }
          break;
        case 'While': visit(n.body); break;
        case 'DoWhile': visit(n.body); break;
        case 'For': visit(n.init); visit(n.body); break;
        case 'If': visit(n.thenBranch); visit(n.elseBranch); break;
        case 'Switch': n.cases.forEach((c) => c.statements.forEach(visit)); break;
        case 'Label': visit(n.statement); break;
      }
    };
    visit(node);
    return out;
  }

  compileFunction(fn) {
    this.exportedFunctions.set(fn.name, this.asm.currentAddress());
    const env = new Map();
    const locals = this.collectLocals(fn.body, [], new Set(fn.params.map((p) => p.name)));
    let localWords = 0;
    for (const local of locals) {
      env.set(local.name, { kind: 'local', name: local.name, offset: -(localWords + local.size), size: local.size, type: cloneType(local.type), arraySize: local.arraySize });
      localWords += local.size;
    }
    fn.params.forEach((param, index) => {
      env.set(param.name, { kind: 'param', name: param.name, offset: 2 + index, size: 1, type: cloneType(param.type), arraySize: param.arraySize });
    });

    const exitLabel = this.newLabel(`${fn.name}_exit`);
    this.currentFunction = { name: fn.name, env, exitLabel, labelPrefix: `__fn_${fn.name}_label_` };

    this.asm.label(`__tna_entry_${fn.name}`);
    this.asm.push(REGISTERS.BP);
    this.asm.movR(REGISTERS.BP, REGISTERS.SP);
    this.asm.addi(REGISTERS.BP, 1);
    if (localWords > 0) this.asm.subi(REGISTERS.SP, localWords);

    this.compileStatement(fn.body, env);

    this.asm.label(exitLabel);
    this.asm.movR(REGISTERS.SP, REGISTERS.BP);
    this.asm.subi(REGISTERS.SP, 1);
    this.asm.pop(REGISTERS.BP);
    if (fn.name === 'main') this.asm.halt(); else this.asm.ret();

    this.currentFunction = null;
    this.breakStack = [];
    this.continueStack = [];
  }

  // ---------- Codegen ----------

  compileStatement(node, env) {
    if (!node) return;
    switch (node.type) {
      case 'Block':
        node.statements.forEach((stmt) => this.compileStatement(stmt, env));
        break;
      case 'DeclStmt':
        for (const decl of node.declarations) {
          const sym = env.get(decl.name);
          if (!decl.init) continue;
          if (Array.isArray(decl.init) || sym.arraySize != null || this.typeSize(sym.type) > 1) {
            const flatInit = this.flattenInitializer(sym.type, sym.arraySize, decl.init);
            const addr = this.acquire();
            this.emitAddressOfSymbol(sym, addr);
            flatInit.forEach((entry, index) => {
              const valueReg = this.acquire();
              const ptr = this.copyRegister(addr);
              if (index) this.asm.addi(ptr, index);
              this.asm.movI(valueReg, (typeof entry === 'number' ? entry : this.evaluateConst(entry)) | 0);
              this.asm.store(ptr, valueReg);
              this.release(ptr);
              this.release(valueReg);
            });
            this.release(addr);
            continue;
          }
          const reg = this.compileExpression(decl.init, env);
          this.storeSymbol(sym, reg);
          this.release(reg);
        }
        break;
      case 'ExprStmt': {
        const reg = this.compileExpression(node.expr, env);
        this.release(reg);
        break;
      }
      case 'While': {
        const start = this.newLabel('while_start');
        const end = this.newLabel('while_end');
        this.breakStack.push(end);
        this.continueStack.push(start);
        this.asm.label(start);
        this.emitConditionFalseJump(node.condition, env, end);
        this.compileStatement(node.body, env);
        this.asm.jmp(start);
        this.asm.label(end);
        this.continueStack.pop();
        this.breakStack.pop();
        break;
      }
      case 'For': {
        const start = this.newLabel('for_start');
        const postLabel = this.newLabel('for_post');
        const end = this.newLabel('for_end');
        if (node.init) {
          if (node.init.type && node.init.type.endsWith('Stmt')) this.compileStatement(node.init, env);
          else { const reg = this.compileExpression(node.init, env); this.release(reg); }
        }
        this.breakStack.push(end);
        this.continueStack.push(postLabel);
        this.asm.label(start);
        if (node.condition) this.emitConditionFalseJump(node.condition, env, end);
        this.compileStatement(node.body, env);
        this.asm.label(postLabel);
        if (node.post) { const reg = this.compileExpression(node.post, env); this.release(reg); }
        this.asm.jmp(start);
        this.asm.label(end);
        this.continueStack.pop();
        this.breakStack.pop();
        break;
      }
      case 'DoWhile': {
        const start = this.newLabel('do_start');
        const condLabel = this.newLabel('do_cond');
        const end = this.newLabel('do_end');
        this.breakStack.push(end);
        this.continueStack.push(condLabel);
        this.asm.label(start);
        this.compileStatement(node.body, env);
        this.asm.label(condLabel);
        const reg = this.compileExpression(node.condition, env);
        this.asm.cmpi(reg, 0);
        this.asm.jnz(start);
        this.release(reg);
        this.asm.label(end);
        this.continueStack.pop();
        this.breakStack.pop();
        break;
      }
      case 'If': {
        const elseLabel = this.newLabel('if_else');
        const end = this.newLabel('if_end');
        this.emitConditionFalseJump(node.condition, env, elseLabel);
        this.compileStatement(node.thenBranch, env);
        this.asm.jmp(end);
        this.asm.label(elseLabel);
        if (node.elseBranch) this.compileStatement(node.elseBranch, env);
        this.asm.label(end);
        break;
      }
      case 'Switch': {
        const end = this.newLabel('switch_end');
        const discr = this.compileExpression(node.discriminant, env);
        const caseMeta = node.cases.map((entry, index) => ({ ...entry, label: this.newLabel(entry.value == null ? 'default' : `case_${index}`) }));
        const defaultMeta = caseMeta.find((entry) => entry.value == null) || null;
        for (const entry of caseMeta) {
          if (entry.value == null) continue;
          const valueReg = this.acquire();
          this.asm.movI(valueReg, entry.value | 0);
          this.asm.cmp(discr, valueReg);
          this.asm.je(entry.label);
          this.release(valueReg);
        }
        this.release(discr);
        if (defaultMeta) this.asm.jmp(defaultMeta.label);
        else this.asm.jmp(end);
        this.breakStack.push(end);
        for (const entry of caseMeta) {
          this.asm.label(entry.label);
          entry.statements.forEach((stmt) => this.compileStatement(stmt, env));
        }
        this.breakStack.pop();
        this.asm.label(end);
        break;
      }
      case 'Return': {
        if (node.expr) {
          const reg = this.compileExpression(node.expr, env);
          if (reg !== ABI.RET_REG) this.asm.movR(ABI.RET_REG, reg);
          this.release(reg);
        }
        this.asm.jmp(this.currentFunction.exitLabel);
        break;
      }
      case 'Break': {
        const label = this.breakStack[this.breakStack.length - 1];
        if (!label) throw new Error('break hors boucle/switch');
        this.asm.jmp(label);
        break;
      }
      case 'Continue': {
        const label = this.continueStack[this.continueStack.length - 1];
        if (!label) throw new Error('continue hors boucle');
        this.asm.jmp(label);
        break;
      }
      case 'Label':
        this.asm.label(`${this.currentFunction.labelPrefix}${node.name}`);
        this.compileStatement(node.statement, env);
        break;
      case 'Goto':
        this.asm.jmp(`${this.currentFunction.labelPrefix}${node.label}`);
        break;
      case 'Empty':
        break;
      case 'AsmStmt':
        break;
      default:
        throw new Error(`Statement non supporté: ${node.type}`);
    }
  }

  emitConditionFalseJump(expr, env, label) {
    const reg = this.compileExpression(expr, env);
    this.asm.cmpi(reg, 0);
    this.asm.jz(label);
    this.release(reg);
  }

  compileExpression(node, env) {
    switch (node.type) {
      case 'Literal': {
        const reg = this.acquire();
        this.asm.movI(reg, node.value | 0);
        return reg;
      }
      case 'StringLiteral': {
        const addr = this.allocateStringLiteral(node.value);
        const reg = this.acquire();
        this.asm.movI(reg, addr);
        return reg;
      }
      case 'Identifier': {
        const reg = this.acquire();
        if ((env && env.has(node.name)) || this.globals.has(node.name)) {
          const sym = this.lookupSymbol(node.name, env);
          if (this.symbolIsAggregate(sym)) this.emitAddressOfSymbol(sym, reg);
          else this.loadSymbol(sym, reg);
          return reg;
        }
        if (this.functions.has(node.name) || this.functionPrototypes.has(node.name)) {
          this.asm.movLabel(reg, `__tna_entry_${node.name}`);
          return reg;
        }
        if (this.options.allowImplicitExterns) {
          const sym = this.ensureExternGlobal(node.name);
          this.loadSymbol(sym, reg);
          return reg;
        }
        throw new Error(`Symbole inconnu: ${node.name}`);
      }
      case 'Unary': {
        if (node.op === '&') {
          if (node.expr.type === 'Identifier' && (this.functions.has(node.expr.name) || this.functionPrototypes.has(node.expr.name))) {
            const reg = this.acquire();
            this.asm.movLabel(reg, `__tna_entry_${node.expr.name}`);
            return reg;
          }
          return this.compileAddress(node.expr, env);
        }
        if (node.op === '*') {
          const addr = this.compileExpression(node.expr, env);
          const out = this.acquire();
          this.asm.load(out, addr);
          this.release(addr);
          return out;
        }
        const reg = this.compileExpression(node.expr, env);
        if (node.op === '-') this.asm.neg(reg);
        else if (node.op === '!') {
          const trueLabel = this.newLabel('not_true');
          const endLabel = this.newLabel('not_end');
          this.asm.cmpi(reg, 0);
          this.asm.je(trueLabel);
          this.asm.movI(reg, 0);
          this.asm.jmp(endLabel);
          this.asm.label(trueLabel);
          this.asm.movI(reg, 1);
          this.asm.label(endLabel);
        } else if (node.op === '~') this.asm.not(reg);
        return reg;
      }
      case 'Binary': return this.compileBinary(node, env);
      case 'Assign': {
        const rhs = this.compileExpression(node.right, env);
        this.storeLValue(node.left, rhs, env);
        return rhs;
      }
      case 'CompoundAssign': return this.compileCompoundAssign(node, env);
      case 'Index': {
        const addr = this.compileIndexAddress(node, env);
        const out = this.acquire();
        this.asm.load(out, addr);
        this.release(addr);
        return out;
      }
      case 'Cast': {
        const reg = this.compileExpression(node.expr, env);
        return reg;
      }
      case 'Member': {
        const info = this.resolveMemberInfo(node, env);
        const addr = this.compileMemberAddress(node, env, info);
        const out = this.acquire();
        this.asm.load(out, addr);
        this.release(addr);
        return out;
      }
      case 'Call': return this.compileCall(node, env);
      case 'PreIncDec':
      case 'PostIncDec': return this.compileIncDec(node, env);
      case 'Conditional': return this.compileConditional(node, env);
      case 'Comma': {
        const left = this.compileExpression(node.left, env);
        this.release(left);
        return this.compileExpression(node.right, env);
      }
      case 'Sizeof': {
        const reg = this.acquire();
        this.asm.movI(reg, this.typeSize(this.resolveTypeOfNode(node.expr, env)));
        return reg;
      }
      default:
        throw new Error(`Expression non supportée: ${node.type}`);
    }
  }

  compileConditional(node, env) {
    const out = this.acquire();
    const falseLabel = this.newLabel('cond_false');
    const endLabel = this.newLabel('cond_end');
    this.emitConditionFalseJump(node.condition, env, falseLabel);
    const yes = this.compileExpression(node.thenExpr, env);
    this.asm.movR(out, yes);
    this.release(yes);
    this.asm.jmp(endLabel);
    this.asm.label(falseLabel);
    const no = this.compileExpression(node.elseExpr, env);
    this.asm.movR(out, no);
    this.release(no);
    this.asm.label(endLabel);
    return out;
  }

  compileCompoundAssign(node, env) {
    const addr = this.compileAddress(node.left, env);
    const current = this.acquire();
    this.asm.load(current, addr);
    const rhs = this.compileExpression(node.right, env);
    switch (node.op) {
      case '+=': this.asm.add(current, rhs); break;
      case '-=': this.asm.sub(current, rhs); break;
      case '*=': this.asm.mul(current, rhs); break;
      case '/=': this.asm.div(current, rhs); break;
      case '%=': this.asm.mod(current, rhs); break;
      case '&=': this.asm.and(current, rhs); break;
      case '|=': this.asm.or(current, rhs); break;
      case '^=': this.asm.xor(current, rhs); break;
      case '<<=': this.asm.shl(current, rhs); break;
      case '>>=': this.asm.shr(current, rhs); break;
      default: throw new Error(`Compound assign non supporté: ${node.op}`);
    }
    this.asm.store(addr, current);
    this.release(addr);
    this.release(rhs);
    return current;
  }

  compileBinary(node, env) {
    if (['<', '>', '<=', '>=', '==', '!=', '&&', '||'].includes(node.op)) return this.compileComparison(node, env);
    const leftType = this.resolveTypeOfNode(node.left, env);
    const rightType = this.resolveTypeOfNode(node.right, env);

    if ((node.op === '+' || node.op === '-') && (leftType.pointerDepth | 0) > 0 && (rightType.pointerDepth | 0) === 0) {
      const left = this.compileExpression(node.left, env);
      const right = this.compileExpression(node.right, env);
      const elemSize = this.typeSize(this.dereferenceType(leftType));
      if (elemSize > 1) this.asm.muli(right, elemSize);
      if (node.op === '+') this.asm.add(left, right); else this.asm.sub(left, right);
      this.release(right);
      return left;
    }

    if (node.op === '+' && (rightType.pointerDepth | 0) > 0 && (leftType.pointerDepth | 0) === 0) {
      const left = this.compileExpression(node.left, env);
      const right = this.compileExpression(node.right, env);
      const elemSize = this.typeSize(this.dereferenceType(rightType));
      if (elemSize > 1) this.asm.muli(left, elemSize);
      this.asm.add(right, left);
      this.release(left);
      return right;
    }

    const left = this.compileExpression(node.left, env);
    const right = this.compileExpression(node.right, env);
    switch (node.op) {
      case '+': this.asm.add(left, right); break;
      case '-': this.asm.sub(left, right); break;
      case '*': this.asm.mul(left, right); break;
      case '/': this.asm.div(left, right); break;
      case '%': this.asm.mod(left, right); break;
      case '&': this.asm.and(left, right); break;
      case '|': this.asm.or(left, right); break;
      case '^': this.asm.xor(left, right); break;
      case '<<': this.asm.shl(left, right); break;
      case '>>': this.asm.shr(left, right); break;
      default: throw new Error(`Opérateur binaire non supporté: ${node.op}`);
    }
    this.release(right);
    return left;
  }

  compileComparison(node, env) {
    if (node.op === '&&' || node.op === '||') {
      const out = this.acquire();
      const trueLabel = this.newLabel('logic_true');
      const falseLabel = this.newLabel('logic_false');
      const endLabel = this.newLabel('logic_end');
      if (node.op === '&&') {
        this.emitConditionFalseJump(node.left, env, falseLabel);
        this.emitConditionFalseJump(node.right, env, falseLabel);
        this.asm.movI(out, 1);
        this.asm.jmp(endLabel);
        this.asm.label(falseLabel);
        this.asm.movI(out, 0);
        this.asm.label(endLabel);
      } else {
        const left = this.compileExpression(node.left, env);
        this.asm.cmpi(left, 0);
        this.asm.jnz(trueLabel);
        this.release(left);
        const right = this.compileExpression(node.right, env);
        this.asm.cmpi(right, 0);
        this.asm.jnz(trueLabel);
        this.release(right);
        this.asm.label(falseLabel);
        this.asm.movI(out, 0);
        this.asm.jmp(endLabel);
        this.asm.label(trueLabel);
        this.asm.movI(out, 1);
        this.asm.label(endLabel);
      }
      return out;
    }

    const left = this.compileExpression(node.left, env);
    const right = this.compileExpression(node.right, env);
    const out = this.acquire();
    const trueLabel = this.newLabel('cmp_true');
    const endLabel = this.newLabel('cmp_end');
    this.asm.cmp(left, right);
    switch (node.op) {
      case '<': this.asm.jl(trueLabel); break;
      case '>': this.asm.jg(trueLabel); break;
      case '<=': this.asm.jle(trueLabel); break;
      case '>=': this.asm.jge(trueLabel); break;
      case '==': this.asm.je(trueLabel); break;
      case '!=': this.asm.jne(trueLabel); break;
      default: throw new Error(`Comparaison non supportée: ${node.op}`);
    }
    this.asm.movI(out, 0);
    this.asm.jmp(endLabel);
    this.asm.label(trueLabel);
    this.asm.movI(out, 1);
    this.asm.label(endLabel);
    this.release(left);
    this.release(right);
    return out;
  }

  compileCall(node, env) {
    const argRegs = [];
    for (let i = node.args.length - 1; i >= 0; i--) {
      const reg = this.compileExpression(node.args[i], env);
      this.asm.push(reg);
      argRegs.push(reg);
    }
    argRegs.forEach((reg) => this.release(reg));
    if (node.callee.type === 'Identifier') {
      if (this.functions.has(node.callee.name) || this.functionPrototypes.has(node.callee.name)) {
        this.asm.call(`__tna_entry_${node.callee.name}`);
      } else if (this.options.allowImplicitExterns) {
        this.ensureExternFunction(node.callee.name);
        this.asm.call(`__tna_entry_${node.callee.name}`);
      } else {
        const target = this.compileExpression(node.callee, env);
        this.asm.callr(target);
        this.release(target);
      }
    } else {
      const target = this.compileExpression(node.callee, env);
      this.asm.callr(target);
      this.release(target);
    }
    if (node.args.length > 0) this.asm.addi(REGISTERS.SP, node.args.length);
    const out = this.acquire();
    this.asm.movR(out, ABI.RET_REG);
    return out;
  }

  compileIncDec(node, env) {
    const addr = this.compileAddress(node.expr, env);
    const cur = this.acquire();
    this.asm.load(cur, addr);
    const original = this.acquire();
    this.asm.movR(original, cur);
    if (node.op === '++') this.asm.inc(cur); else this.asm.dec(cur);
    this.asm.store(addr, cur);
    this.release(addr);
    if (node.type === 'PreIncDec') { this.release(original); return cur; }
    this.release(cur);
    return original;
  }

  compileAddress(node, env) {
    switch (node.type) {
      case 'Identifier': {
        const reg = this.acquire();
        if ((env && env.has(node.name)) || this.globals.has(node.name)) {
          this.emitAddressOfSymbol(this.lookupSymbol(node.name, env), reg);
          return reg;
        }
        if (this.functions.has(node.name) || this.functionPrototypes.has(node.name)) {
          this.asm.movLabel(reg, `__tna_entry_${node.name}`);
          return reg;
        }
        if (this.options.allowImplicitExterns) {
          this.emitAddressOfSymbol(this.ensureExternGlobal(node.name), reg);
          return reg;
        }
        throw new Error(`Symbole inconnu: ${node.name}`);
      }
      case 'Unary':
        if (node.op === '*') return this.compileExpression(node.expr, env);
        break;
      case 'Index':
        return this.compileIndexAddress(node, env);
      case 'Cast': {
        const reg = this.compileExpression(node.expr, env);
        return reg;
      }
      case 'Member': {
        const info = this.resolveMemberInfo(node, env);
        return this.compileMemberAddress(node, env, info);
      }
    }
    throw new Error(`Expression non adressable: ${node.type}`);
  }

  isArrayBaseNode(node, env) {
    if (!node) return false;
    if (node.type === 'Identifier') {
      if ((env && env.has(node.name)) || this.globals.has(node.name)) {
        const sym = this.lookupSymbol(node.name, env);
        return sym.arraySize != null || (sym.type && (sym.type.kind === 'struct' || sym.type.kind === 'union') && (sym.type.pointerDepth | 0) === 0);
      }
      return false;
    }
    if (node.type === 'StringLiteral') return true;
    if (node.type === 'Member') {
      const info = this.resolveMemberInfo(node, env);
      return info.arrayLength != null || (info.type && (info.type.kind === 'struct' || info.type.kind === 'union') && (info.type.pointerDepth | 0) === 0);
    }
    return false;
  }

  compileIndexAddress(node, env) {
    const base = this.isArrayBaseNode(node.array, env) ? this.compileAddress(node.array, env) : this.compileExpression(node.array, env);
    const index = this.compileExpression(node.index, env);
    const elemSize = this.typeSize(this.resolveIndexedElementType(node.array, env));
    if (elemSize > 1) this.asm.muli(index, elemSize);
    this.asm.add(base, index);
    this.release(index);
    return base;
  }

  compileMemberAddress(node, env, info = null) {
    const meta = info || this.resolveMemberInfo(node, env);
    const base = node.throughPointer ? this.compileExpression(node.object, env) : this.compileAddress(node.object, env);
    if (meta.offset) this.asm.addi(base, meta.offset);
    return base;
  }

  storeLValue(node, valueReg, env) {
    if (node.type === 'Identifier') {
      if ((env && env.has(node.name)) || this.globals.has(node.name)) this.storeSymbol(this.lookupSymbol(node.name, env), valueReg);
      else if (this.options.allowImplicitExterns) this.storeSymbol(this.ensureExternGlobal(node.name), valueReg);
      else throw new Error(`Symbole inconnu: ${node.name}`);
      return;
    }
    const addr = this.compileAddress(node, env);
    this.asm.store(addr, valueReg);
    this.release(addr);
  }

  loadSymbol(sym, reg) {
    if (sym.kind === 'global') {
      const addr = this.acquire();
      this.asm.movI(addr, sym.address);
      this.asm.load(reg, addr);
      this.release(addr);
      return;
    }
    this.asm.loadi(reg, REGISTERS.BP, sym.offset);
  }

  storeSymbol(sym, reg) {
    if (sym.kind === 'global') {
      const addr = this.acquire();
      this.asm.movI(addr, sym.address);
      this.asm.store(addr, reg);
      this.release(addr);
      return;
    }
    this.asm.storei(reg, REGISTERS.BP, sym.offset);
  }

  emitAddressOfSymbol(sym, reg) {
    if (sym.kind === 'global') {
      this.asm.movI(reg, sym.address);
      return;
    }
    this.asm.lea(reg, REGISTERS.BP, sym.offset);
  }

  resolveIndexedElementType(node, env) {
    const base = this.resolveTypeOfNode(node, env);
    if (base.pointerDepth > 0) {
      base.pointerDepth -= 1;
      if (base.pointerDepth > 0) return base;
      if (base.kind === 'struct' || base.kind === 'union' || base.fields) return base;
      return primitiveType('int');
    }
    if (base.kind === 'struct' || base.kind === 'union' || base.fields) return base;
    return primitiveType('int');
  }

  resolveMemberInfo(node, env) {
    const objectType = this.resolveTypeOfNode(node.object, env);
    const structType = node.throughPointer
      ? (objectType.pointerDepth > 0 && objectType.name && this.structTypes.get(objectType.name)) || (objectType.kind === 'struct' ? objectType : null)
      : objectType;
    const resolved = structType && structType.fields ? structType.fields.get(node.field) : null;
    if (!resolved) throw new Error(`Champ inconnu: ${node.field}`);
    return resolved;
  }

  ensureExternGlobal(name) {
    if (this.globals.has(name)) return this.globals.get(name);
    if (this.importedGlobals.has(name)) return this.importedGlobals.get(name);
    const address = this.nextDataAddress();
    const sym = {
      kind: 'global',
      name,
      address,
      size: 1,
      type: primitiveType('int'),
      arraySize: null,
      extern: true,
    };
    this.ensureDataCapacityForAddress(address, 1);
    this.globals.set(name, sym);
    this.importedGlobals.set(name, sym);
    return sym;
  }

  ensureExternFunction(name) {
    if (!this.functions.has(name) && !this.functionPrototypes.has(name)) {
      this.functionPrototypes.set(name, {
        type: 'Function',
        returnType: primitiveType('int'),
        name,
        params: [],
        variadic: true,
        prototype: true,
        body: null,
        imported: true,
      });
    }
    this.importedFunctions.add(name);
    return this.functionPrototypes.get(name) || this.functions.get(name);
  }

  emitImportedFunctionStubs() {
    const names = new Set([...this.importedFunctions, ...[...this.functionPrototypes.keys()].filter((name) => !this.functions.has(name))]);
    for (const name of names) {
      const label = `__tna_entry_${name}`;
      if (this.asm.labels.has(label)) continue;
      const addr = this.asm.currentAddress();
      this.asm.label(label);
      this.importStubAddresses.set(name, addr);
      this.asm.movI(ABI.RET_REG, 0);
      this.asm.ret();
    }
  }

  allocateStringLiteral(value) {
    const key = `__str_${value}`;
    if (this.globals.has(key)) return this.globals.get(key).address;
    const address = this.nextDataAddress();
    const sym = {
      kind: 'global',
      name: key,
      address,
      size: value.length + 1,
      type: { kind: 'int', name: null, pointerDepth: 1, sizeWords: 1, fields: null },
      arraySize: value.length + 1,
    };
    this.globals.set(key, sym);
    this.writeDataWordsAtAddress(address, [...value].map((ch) => ch.charCodeAt(0) | 0).concat(0));
    return address;
  }

  lookupSymbol(name, env) {
    if (env && env.has(name)) return env.get(name);
    if (this.globals.has(name)) return this.globals.get(name);
    throw new Error(`Symbole inconnu: ${name}`);
  }

  acquire() {
    if (this.pool.length === 0) throw new Error('Plus de registres scratch disponibles');
    return this.pool.shift();
  }

  release(reg) {
    if (reg == null) return;
    if (!this.pool.includes(reg)) this.pool.unshift(reg);
  }

  copyRegister(src) {
    const reg = this.acquire();
    this.asm.movR(reg, src);
    return reg;
  }

  newLabel(prefix = 'L') {
    return `${prefix}_${this.labelCounter++}`;
  }
}

module.exports = C_Compiler;
