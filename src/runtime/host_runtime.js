const fs = require('fs');
const path = require('path');
const { MMIO } = require('../config');
const { parseMaps, parseVSwap, parseVgaGraph } = require('./wolf_asset_import');

function normalizeGuestPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

class TNAHostRuntime {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    const defaultAssetRoot = fs.existsSync(path.join(this.projectRoot, 'assets', 'wolf3d', 'raw'))
      ? path.join(this.projectRoot, 'assets', 'wolf3d', 'raw')
      : path.join(this.projectRoot, 'assets');
    this.assetRoot = options.assetRoot || process.env.WOLF3D_DATA || defaultAssetRoot;
    this.stdout = [];
    this.fdTable = new Map();
    this.nextFd = 3;
    this.importNames = [];
    this.importIds = new Map();
    this.coverage = new Map();
    this.heapPtr = MMIO.HEAP_BASE;
    this.latchCache = new Map();
    this.randSeed = 0x1234;
    this.hardErrorHandler = 0;
    this.wolfData = undefined;
    this.paletteData = undefined;
    this.activePalette = null;
    this.vgaData = undefined;
    this.findState = { matches: [], index: -1, pattern: '' };
    this.loadSaveHooks = { load: 0, save: 0, reset: 0 };
    this.currentExecutable = null;
    this.currentGlobals = {};
    this.mmState = { blocks: new Map(), totalAllocated: 0, bombOnError: true };
    this.keyQueue = [];
    this.keyState = new Set();
    this.hostPressedKeys = new Set();
    this.keyStateByCode = new Map();
    this.lastKeyEvent = null;
    this.keyHookPtr = 0;
    this.ackButtons = new Array(8).fill(false);
    this.hostNavState = { stepCounter: 0 };
    this.uiState = {
      cursorX: 8,
      cursorY: 8,
      textColor: 0x00FFFFFF,
      backColor: 0x00000000,
      window: { x: 0, y: 0, w: 0, h: 0 },
      cursorVisible: false,
      screen: { crtc: 0, pelpan: 0 },
    };
    this.installBuiltins();
  }

  installBuiltins() {
    const actual = {
      abs: (ctx, x) => Math.abs(x | 0) | 0,
      AsmRefresh: (ctx) => this.renderWolfView(ctx.bus),
      Attack: () => 0,
      CAL_ShiftSprite: () => 0,
      CP_ExitOptions: () => 0,
      CP_ReadThis: (ctx) => { this.setTextWindow(ctx.bus, 8, 8, 144, 88); this.printText(ctx.bus, 'Read This', true, true); this.printText(ctx.bus, 'Wolf3D historical runtime', true, true); const wolf = this.loadWolfData(); if (wolf && wolf.maps && wolf.maps.length) this.printText(ctx.bus, `Maps: ${wolf.maps.length}`, true, true); return 0; },
      CheckIs386: () => 1,
      CheckSecretMissions: () => 0,
      DrawRtn: () => 0,
      FizzleOut: (ctx) => { this.clearVideo(ctx.bus, 0); return 0; },
      GetYorN: (ctx) => { const key = this.readKeyboard(ctx.bus); if (!key || key === 13) return 1; const ch = String.fromCharCode(key & 0xFF).toLowerCase(); return (ch === 'y' || ch === 'j') ? 1 : 0; },
      INL_KeyHook: (ctx) => this.inputAck(ctx.bus),
      InitHitRect: () => 0,
      InitObjList: () => 0,
      MML_CheckForEMS: () => 0,
      MML_ShutdownEMS: () => 0,
      MML_UseSpace: () => 0,
      MM_MapEMS: () => 0,
      MM_Startup: (ctx) => this.mmStartup(ctx.bus),
      MM_Shutdown: (ctx) => this.mmShutdown(ctx.bus),
      MM_GetPtr: (ctx, basePtr, size) => this.mmGetPtr(ctx.bus, basePtr, size),
      MM_FreePtr: (ctx, basePtr) => this.mmFreePtr(ctx.bus, basePtr),
      MM_SetPurge: () => 0,
      MM_SetLock: () => 0,
      MM_SortMem: () => 0,
      MM_UnusedMemory: () => this.mmUnusedMemory(),
      MM_TotalFree: () => this.mmUnusedMemory(),
      MM_BombOnError: (ctx, bomb) => { this.mmState.bombOnError = !!(bomb | 0); return 0; },
      MapRow: (ctx) => { this.drawMapPreview(ctx.bus, 0, 0, 0, 0, 1, { rows: 1, startRow: this.uiState.mapRow || 0 }); this.uiState.mapRow = (((this.uiState.mapRow || 0) + 1) % 64) | 0; return 0; },
      OrderingInfo: (ctx) => { const wolf = this.loadWolfData(); const wallCount = (((wolf || {}).vswap || {}).walls || []).length | 0; this.setTextWindow(ctx.bus, 8, 8, 144, 88); this.printText(ctx.bus, 'Ordering Info', true, true); this.printText(ctx.bus, 'Use registered data', true, true); if (wolf && wolf.maps) this.printText(ctx.bus, `Maps: ${wolf.maps.length}  Walls: ${wallCount}`, true, true); return 0; },
      PM_Startup: (ctx) => this.pmStartup(ctx.bus),
      PM_Shutdown: (ctx) => this.pmShutdown(ctx.bus),
      PM_Reset: () => 0,
      PM_Preload: () => 0,
      PM_NextFrame: () => 0,
      PM_SetPageLock: () => 0,
      PM_SetMainPurge: () => 0,
      PM_CheckMainMem: () => 0,
      PM_GetPageAddress: () => 0,
      PM_GetPage: () => 0,
      PrintRtn: () => 0,
      SDL_IndicatePC: () => 0,
      SDL_SetDS: () => 0,
      SDL_t0ExtremeAsmService: () => 0,
      SDL_t0FastAsmService: () => 0,
      SDL_t0SlowAsmService: () => 0,
      Search: () => 0,
      SelectItem: () => 0,
      SelectWeapon: () => 0,
      SpawnAngel: () => 0,
      SpawnDeath: () => 0,
      SpawnSpectre: () => 0,
      SpawnTrans: () => 0,
      SpawnUber: () => 0,
      SpawnWill: () => 0,
      TEDDeath: () => 0,
      T_DeathCam: () => 0,
      T_FatThrow: () => 0,
      USL_GiveSaveName: (ctx, game) => { const slot = Math.max(0, game | 0); const name = `SAVEGAM${slot}.WL6`; const addr = this.alloc(name.length + 1); this.writeCString(ctx.bus, addr, name); return addr; },
      US_CheckHighScore: () => 0,
      US_DisplayHighScores: (ctx) => { this.setTextWindow(ctx.bus, 8, 8, 144, 96); this.printText(ctx.bus, 'High Scores', true, true); this.printText(ctx.bus, 'BJ 000000', true, true); return 0; },
      US_SetLoadSaveHooks: (ctx, loadFn, saveFn, resetFn) => { this.loadSaveHooks = { load: loadFn | 0, save: saveFn | 0, reset: resetFn | 0 }; return 0; },
      Use: () => 0,
      ViewMap: (ctx) => { this.clearVideo(ctx.bus, 0); const wolf = this.loadWolfData(); const map = (wolf && wolf.maps && wolf.maps.length) ? wolf.maps[0] : null; this.drawMapPreview(ctx.bus, 0, 0, 4, 4, 2); this.hostDrawString(ctx.bus, map ? map.name : 'No map', 6, 6, 0x00FFFFFF); return 0; },
      VWL_UpdateScreenBlocks: () => 0,
      aftersort: () => 0,
      beforesort: () => 0,
      jabhack2: () => 0,
      routine: () => 0,
      think: () => 0,
      update: () => 0,
      atoi: (ctx, s) => parseInt(this.readCString(ctx.bus, s), 10) | 0,
      atol: (ctx, s) => parseInt(this.readCString(ctx.bus, s), 10) | 0,
      isalpha: (ctx, ch) => /[A-Za-z]/.test(String.fromCharCode(ch & 0xFF)) ? 1 : 0,
      isdigit: (ctx, ch) => /[0-9]/.test(String.fromCharCode(ch & 0xFF)) ? 1 : 0,
      isupper: (ctx, ch) => /[A-Z]/.test(String.fromCharCode(ch & 0xFF)) ? 1 : 0,
      isprint: (ctx, ch) => {
        const c = ch & 0xFF;
        return c >= 32 && c < 127 ? 1 : 0;
      },
      isspace: (ctx, ch) => /\s/.test(String.fromCharCode(ch & 0xFF)) ? 1 : 0,
      tolower: (ctx, ch) => String.fromCharCode(ch & 0xFF).toLowerCase().charCodeAt(0) | 0,
      malloc: (ctx, size) => this.alloc(size | 0),
      free: () => 0,
      farmalloc: (ctx, size) => this.alloc(size | 0),
      farfree: () => 0,
      memcpy: (ctx, dst, src, n) => this.copyWords(ctx.bus, dst, src, n),
      _fmemcpy: (ctx, dst, src, n) => this.copyWords(ctx.bus, dst, src, n),
      memset: (ctx, dst, value, n) => this.fillWords(ctx.bus, dst, value, n),
      _fmemset: (ctx, dst, value, n) => this.fillWords(ctx.bus, dst, value, n),
      memcmp: (ctx, a, b, n) => this.compareWords(ctx.bus, a, b, n),
      _fmemcmp: (ctx, a, b, n) => this.compareWords(ctx.bus, a, b, n),
      strcpy: (ctx, dst, src) => this.copyCString(ctx.bus, dst, this.readCString(ctx.bus, src)),
      _fstrcpy: (ctx, dst, src) => this.copyCString(ctx.bus, dst, this.readCString(ctx.bus, src)),
      strcat: (ctx, dst, src) => this.appendCString(ctx.bus, dst, this.readCString(ctx.bus, src)),
      strcmp: (ctx, a, b) => this.compareStrings(this.readCString(ctx.bus, a), this.readCString(ctx.bus, b)),
      stricmp: (ctx, a, b) => this.compareStrings(this.readCString(ctx.bus, a).toLowerCase(), this.readCString(ctx.bus, b).toLowerCase()),
      _fstricmp: (ctx, a, b) => this.compareStrings(this.readCString(ctx.bus, a).toLowerCase(), this.readCString(ctx.bus, b).toLowerCase()),
      strlen: (ctx, s) => this.readCString(ctx.bus, s).length | 0,
      _fstrlen: (ctx, s) => this.readCString(ctx.bus, s).length | 0,
      sin: (ctx, x) => Math.round(Math.sin(x) * 256) | 0,
      cos: (ctx, x) => Math.round(Math.cos(x) * 256) | 0,
      atan: (ctx, x) => Math.round(Math.atan(x) * 256) | 0,
      atan2: (ctx, y, x) => Math.round(Math.atan2(y, x) * 256) | 0,
      sqrt: (ctx, x) => Math.floor(Math.sqrt(Math.max(0, x))) | 0,
      tan: (ctx, x) => Math.round(Math.tan(x) * 256) | 0,
      toupper: (ctx, ch) => String.fromCharCode(ch & 0xFF).toUpperCase().charCodeAt(0) | 0,
      strtol: (ctx, s, endptr, base) => parseInt(this.readCString(ctx.bus, s), (base | 0) || 10) | 0,
      FP_SEG: (ctx, ptr) => (ptr >> 4) | 0,
      FP_OFF: (ctx, ptr) => (ptr & 0xF) | 0,
      MK_FP: (ctx, seg, off) => (((seg & 0xFFFF) << 4) + (off & 0xFFFF)) | 0,
      puts: (ctx, s) => { this.stdout.push(this.readCString(ctx.bus, s)); return 0; },
      printf: (ctx, fmt) => { this.stdout.push(this.readCString(ctx.bus, fmt)); return 0; },
      sprintf: (ctx, dst, fmt) => this.copyCString(ctx.bus, dst, this.readCString(ctx.bus, fmt)),
      fprintf: (ctx, fd, fmt) => this.fprintf(ctx.bus, fd, fmt),
      itoa: (ctx, value, dst, base) => this.copyCString(ctx.bus, dst, this.formatInt(value, base, false)),
      ltoa: (ctx, value, dst, base) => this.copyCString(ctx.bus, dst, this.formatInt(value, base, false)),
      ultoa: (ctx, value, dst, base) => this.copyCString(ctx.bus, dst, this.formatInt(value >>> 0, base, true)),
      fopen: (ctx, p, mode) => this.openHostFile(this.readCString(ctx.bus, p), /[wa+]/i.test(this.readCString(ctx.bus, mode))),
      fclose: (ctx, fd) => this.closeHostFile(fd),
      open: (ctx, p) => this.openHostFile(this.readCString(ctx.bus, p)),
      creat: (ctx, p) => this.openHostFile(this.readCString(ctx.bus, p), true),
      close: (ctx, fd) => this.closeHostFile(fd),
      unlink: (ctx, p) => this.unlinkHostFile(this.readCString(ctx.bus, p)),
      read: (ctx, fd, dst, count) => this.readHostFile(ctx.bus, fd, dst, count),
      write: (ctx, fd, src, count) => this.writeHostFile(ctx.bus, fd, src, count),
      _dos_write: (ctx, fd, src, count, writtenPtr) => {
        const written = this.writeHostFile(ctx.bus, fd, src, count);
        if (writtenPtr) ctx.bus.write(writtenPtr, written | 0);
        return written >= 0 ? 0 : -1;
      },
      lseek: (ctx, fd, offset, whence) => this.seekHostFile(fd, offset, whence),
      filelength: (ctx, fd) => this.fileLength(fd),
      kbhit: (ctx) => this.kbhit(ctx.bus),
      getch: (ctx) => this.readKeyboard(ctx.bus),
      bioskey: (ctx) => this.readKeyboard(ctx.bus),
      clrscr: (ctx) => { ctx.bus.write(MMIO.GPU_CMD, 1); ctx.bus.write(MMIO.GPU_ARG0, 0); return 0; },
      ClearScreen: (ctx) => { ctx.bus.write(MMIO.GPU_CMD, 1); ctx.bus.write(MMIO.GPU_ARG0, 0); return 0; },
      closegraph: (ctx) => { ctx.bus.write(MMIO.GPU_CMD, 1); ctx.bus.write(MMIO.GPU_ARG0, 0); return 0; },
      gotoxy: () => 0,
      VL_WaitVBL: () => 0,
      VH_UpdateScreen: () => 0,
      delay: () => 0,
      exit: (ctx, code) => { ctx.cpu.halted = true; return code | 0; },
      coreleft: () => 160 * 1024,
      farcoreleft: () => 160 * 1024,
      getenv: () => 0,
      findfirst: (ctx, pattern, blk) => this.findFirst(ctx.bus, pattern, blk),
      findnext: (ctx, blk) => this.findNext(ctx.bus, blk),
      getdfree: () => 0,
      _dos_getdiskfree: () => 0,
      _dos_gettime: () => 0,
      getvect: () => 0,
      setvect: () => 0,
      segread: () => 0,
      harderr: (ctx, handler) => { this.hardErrorHandler = handler | 0; return 0; },
      int86: () => 0,
      int86x: () => 0,
      geninterrupt: () => 0,
      inportb: () => 0,
      outport: () => 0,
      outportb: () => 0,
      sbIn: () => 0,
      sbOut: () => 0,
      peek: (ctx, seg, off) => ctx.bus.read((((seg & 0xFFFF) << 4) + (off & 0xFFFF)) | 0) | 0,
      peekb: (ctx, seg, off) => ctx.bus.read((((seg & 0xFFFF) << 4) + (off & 0xFFFF)) | 0) & 0xFF,
      movedata: (ctx, sseg, soff, dseg, doff, count) => {
        const src = (((sseg & 0xFFFF) << 4) + (soff & 0xFFFF)) | 0;
        const dst = (((dseg & 0xFFFF) << 4) + (doff & 0xFFFF)) | 0;
        return this.copyWords(ctx.bus, dst, src, count);
      },
      poke: (ctx, seg, off, value) => { ctx.bus.write((((seg & 0xFFFF) << 4) + (off & 0xFFFF)) | 0, value | 0); return 0; },
      CA_FarRead: (ctx, handle, dest, length) => {
        const want = Math.max(0, length | 0);
        const got = this.readHostFile(ctx.bus, handle, dest, want);
        return got === want ? 1 : 0;
      },
      CA_FarWrite: (ctx, handle, src, length) => {
        const want = Math.max(0, length | 0);
        const wrote = this.writeHostFile(ctx.bus, handle, src, want);
        return wrote === want ? 1 : 0;
      },
      CA_CacheMap: (ctx, mapnum) => this.cacheWolfMap(ctx.bus, mapnum),
      CA_CacheScreen: (ctx, chunk) => this.cacheWolfScreen(ctx.bus, chunk),
      VL_DePlaneVGA: () => 0,
      VL_MemToLatch: (ctx, source, width, height, dest) => this.cacheLatch(ctx.bus, source, width, height, dest),
      VL_MemToScreen: (ctx, source, width, height, x, y) => this.blitBuffer(ctx.bus, source, width, height, x, y, false),
      VL_MaskedToScreen: (ctx, source, width, height, x, y) => this.blitBuffer(ctx.bus, source, width, height, x, y, true),
      VL_LatchToScreen: (ctx, source, width, height, x, y) => this.blitLatch(ctx.bus, source, width, height, x, y),
      errout: (ctx, s) => { this.stdout.push(this.readCString(ctx.bus, s)); return 0; },
      USL_MeasureString: (ctx, s, wPtr, hPtr) => {
        const len = this.readCString(ctx.bus, s).length | 0;
        if (wPtr) ctx.bus.write(wPtr, (len * 8) | 0);
        if (hPtr) ctx.bus.write(hPtr, 8);
        return 0;
      },
      USL_DrawString: (ctx, s) => this.drawGuestString(ctx.bus, this.readCString(ctx.bus, s), 'px', 'py'),
      US_InitRndT: () => { this.randSeed = 0x1234; return 0; },
      US_RndT: () => {
        this.randSeed = (Math.imul(this.randSeed, 1103515245) + 12345) & 0x7fffffff;
        return (this.randSeed >> 8) & 0xff;
      },
      IN_Startup: (ctx) => this.inputStartup(ctx.bus),
      IN_Shutdown: (ctx) => this.inputShutdown(ctx.bus),
      IN_ClearKeysDown: (ctx) => { this.clearKeys(ctx.bus); return 0; },
      IN_CheckAck: (ctx) => this.checkAck(ctx.bus),
      IN_Ack: (ctx) => this.checkAck(ctx.bus),
      IN_AckBack: (ctx) => this.checkAck(ctx.bus),
      IN_UserInput: (ctx, delay) => this.userInput(ctx.bus, delay),
      IN_WaitForASCII: (ctx) => this.waitForAscii(ctx.bus),
      IN_WaitForKey: (ctx) => this.waitForKey(ctx.bus),
      IN_MouseButtons: (ctx) => this.mouseButtons(ctx.bus),
      IN_JoyButtons: () => 0,
      IN_GetJoyButtonsDB: () => 0,
      IN_GetJoyAbs: (ctx, joy, xPtr, yPtr) => { if (xPtr) ctx.bus.write(xPtr, 0); if (yPtr) ctx.bus.write(yPtr, 0); return 0; },
      IN_SetupJoy: () => 0,
      IN_StartAck: (ctx) => this.startAck(ctx.bus),
      IN_StopDemo: () => 0,
      IN_FreeDemoBuffer: () => 0,
      IN_Default: (ctx, gotit, type) => this.inputDefault(ctx.bus, gotit, type),
      IN_SetControlType: (ctx, player, type) => this.inputSetControlType(ctx.bus, player, type),
      IN_SetKeyHook: (ctx, hook) => { this.keyHookPtr = hook | 0; return 0; },
      IN_ReadCursor: (ctx, ptr) => this.writeCursorInfo(ctx.bus, ptr),
      IN_ReadControl: (ctx, player, ptr) => this.writeCursorInfo(ctx.bus, ptr),
      NormalScreen: (ctx) => { this.clearVideo(ctx.bus, this.getGuestBackColor(ctx.bus, 0)); this.syncGuestWindow(ctx.bus, { x: 0, y: 0, w: 160, h: 120 }); return 0; },
      US_TextScreen: (ctx) => { this.clearVideo(ctx.bus, this.getGuestBackColor(ctx.bus, 0)); this.syncGuestWindow(ctx.bus, { x: 0, y: 0, w: 160, h: 120 }); return 0; },
      US_FinishTextScreen: (ctx) => { this.uiState.cursorVisible = false; return 0; },
      US_UpdateTextScreen: () => 0,
      US_StartCursor: () => { this.uiState.cursorVisible = true; return 0; },
      US_ShutCursor: () => { this.uiState.cursorVisible = false; return 0; },
      US_UpdateCursor: (ctx) => { if (this.uiState.cursorVisible) this.drawGuestCursor(ctx.bus); return 0; },
      US_CenterWindow: (ctx, w, h) => this.centerGuestWindow(ctx.bus, w, h),
      US_DrawWindow: (ctx, x, y, w, h) => this.drawGuestWindow(ctx.bus, x, y, w, h),
      US_ClearWindow: (ctx) => this.clearGuestWindow(ctx.bus),
      US_Print: (ctx, s) => this.printGuestString(ctx.bus, this.readCString(ctx.bus, s), false, false),
      US_CPrint: (ctx, s) => this.printGuestString(ctx.bus, this.readCString(ctx.bus, s), true, false),
      US_CPrintLine: (ctx, s) => this.printGuestString(ctx.bus, this.readCString(ctx.bus, s), true, true),
      US_PrintCentered: (ctx, s) => this.printGuestString(ctx.bus, this.readCString(ctx.bus, s), true, true),
      US_PrintUnsigned: (ctx, n) => this.printGuestString(ctx.bus, String(n >>> 0), false, false),
      US_PrintSigned: (ctx, n) => this.printGuestString(ctx.bus, String(n | 0), false, false),
      US_Setup: (ctx) => { this.syncGuestWindow(ctx.bus, { x: 0, y: 0, w: 160, h: 120 }); return 0; },
      US_Startup: (ctx) => { this.syncGuestWindow(ctx.bus, { x: 0, y: 0, w: 160, h: 120 }); return 0; },
      US_Shutdown: () => 0,
      US_CheckParm: () => -1,
      VH_SetDefaultColors: () => 0,
      VL_ClearVideo: (ctx, color) => this.clearVideo(ctx.bus, color | 0),
      VL_Plot: (ctx, x, y, color) => this.plotPixel(ctx.bus, x, y, color),
      VL_Hlin: (ctx, x, y, width, color) => this.drawHLine(ctx.bus, x, y, width, color),
      VL_Vlin: (ctx, x, y, height, color) => this.drawVLine(ctx.bus, x, y, height, color),
      VL_Bar: (ctx, x, y, width, height, color) => this.drawRect(ctx.bus, x, y, width, height, color),
      VL_CrtcStart: (ctx, value) => { this.uiState.screen.crtc = value | 0; return 0; },
      VL_SetCRTC: (ctx, value) => { this.uiState.screen.crtc = value | 0; return 0; },
      VL_SetScreen: (ctx, crtc, pelpan) => { this.uiState.screen = { crtc: crtc | 0, pelpan: pelpan | 0 }; return 0; },
      VL_SetVGAPlane: () => 0,
      VL_VideoID: () => 5,
      VL_ScreenToScreen: () => 0,
      VL_MungePic: () => 0,
      VL_DrawPicBare: (ctx, x, y, pic, width, height) => this.drawPicFromMemory(ctx.bus, x, y, pic, width, height, 0),
      VL_SetPalette: (ctx, palette) => this.setPaletteFromGuest(ctx.bus, palette),
      VL_GetPalette: (ctx, palette) => this.writePaletteToGuest(ctx.bus, palette),
      VL_FadeIn: (ctx, start, end, palette) => this.setPaletteFromGuest(ctx.bus, palette, start, end),
      VL_DrawPropString: (ctx, s, tile8ptr, printx, printy) => this.hostDrawString(ctx.bus, this.readCString(ctx.bus, s), printx, printy, this.getGuestTextColor(ctx.bus, this.uiState.textColor)),
      VL_SizePropString: (ctx, s, wPtr, hPtr) => this.writeStringMeasure(ctx.bus, this.readCString(ctx.bus, s), wPtr, hPtr),
      VWB_Bar: (ctx, x, y, width, height, color) => this.drawRect(ctx.bus, x, y, width, height, color),
      VWB_Plot: (ctx, x, y, color) => this.plotPixel(ctx.bus, x, y, color),
      VWB_Hlin: (ctx, x1, x2, y, color) => this.drawHLine(ctx.bus, x1, y, ((x2 | 0) - (x1 | 0) + 1) | 0, color),
      VWB_Vlin: (ctx, y1, y2, x, color) => this.drawVLine(ctx.bus, x, y1, ((y2 | 0) - (y1 | 0) + 1) | 0, color),
      VW_Bar: (ctx, x, y, width, height, color) => this.drawRect(ctx.bus, x, y, width, height, color),
      VW_Plot: (ctx, x, y, color) => this.plotPixel(ctx.bus, x, y, color),
      VW_Hlin: (ctx, x1, x2, y, color) => this.drawHLine(ctx.bus, x1, y, ((x2 | 0) - (x1 | 0) + 1) | 0, color),
      VW_Vlin: (ctx, y1, y2, x, color) => this.drawVLine(ctx.bus, x, y1, ((y2 | 0) - (y1 | 0) + 1) | 0, color),
      VW_MarkUpdateBlock: () => 0,
      VW_UpdateScreen: () => 0,
      VW_InitDoubleBuffer: () => 0,
      VW_MeasurePropString: (ctx, s, wPtr, hPtr) => this.writeStringMeasure(ctx.bus, this.readCString(ctx.bus, s), wPtr, hPtr),
      VWB_DrawPic: (ctx, x, y, chunk) => this.drawWolfPic(ctx.bus, x, y, chunk, false),
      VWB_DrawMPic: (ctx, x, y, chunk) => this.drawWolfPic(ctx.bus, x, y, chunk, true),
      VWB_DrawSprite: (ctx, x, y, chunk) => this.drawWolfPic(ctx.bus, x, y, chunk, true, { fallbackWidth: 24, fallbackHeight: 24 }),
      VWB_DrawTile8: (ctx, x, y, tile) => this.drawWolfChunk(ctx.bus, x, y, tile, 8, 8, false),
      VWB_DrawTile8M: (ctx, x, y, tile) => this.drawWolfChunk(ctx.bus, x, y, tile, 8, 8, true),
      VWB_DrawTile16: (ctx, x, y, tile) => this.drawWolfChunk(ctx.bus, x, y, tile, 16, 16, false),
      VWB_DrawTile16M: (ctx, x, y, tile) => this.drawWolfChunk(ctx.bus, x, y, tile, 16, 16, true),
      VWB_DrawPropString: (ctx, s) => this.drawGuestString(ctx.bus, this.readCString(ctx.bus, s), 'px', 'py'),
      VWB_DrawMPropString: (ctx, s) => this.drawGuestString(ctx.bus, this.readCString(ctx.bus, s), 'px', 'py'),
    };
    for (const [name, fn] of Object.entries(actual)) this.coverage.set(name, { kind: 'actual', fn });

    const noops = [
      'AsmRefresh','CAL_ShiftSprite','CP_ExitOptions','CP_ReadThis','CheckHighScore','CheckIs386','CheckSecretMissions',
      'ClearSplitVWB','DrawAmmo','DrawFace','DrawHealth','DrawHighScores','DrawKeys','DrawLevel','DrawLives','DrawRtn','DrawScore',
      'DrawWeapon','EndText','FizzleFade','FizzleOut','GetBonus','GetYorN','GiveAmmo','GiveExtraMan','GiveKey','GivePoints','GiveWeapon',
      'HealSelf','HelpScreens','INL_GetJoyDelta','IN_Ack','IN_AckBack','IN_CheckAck','IN_ClearKeysDown','IN_Default','IN_FreeDemoBuffer',
      'IN_GetJoyAbs','IN_GetJoyButtonsDB','IN_JoyButtons','IN_MouseButtons','IN_ReadControl','IN_ReadCursor','IN_SetControlType',
      'IN_SetKeyHook','IN_SetupJoy','IN_Shutdown','IN_StartAck','IN_Startup','IN_StopDemo','IN_UserInput','IN_WaitForASCII','IN_WaitForKey',
      'InitHitRect','InitObjList','LatchDrawPic','LevelCompleted','LoadLatchMem','MML_CheckForEMS','MML_ShutdownEMS','MM_MapEMS',
      'NonShareware','NormalScreen','OrderingInfo','PG13','PM_SetMainPurge','PreloadGraphics','PrintRtn','SDL_IndicatePC','SDL_SetDS',
      'SDL_t0ExtremeAsmService','SDL_t0FastAsmService','SDL_t0SlowAsmService','ScaleShape','SetupScaling','SimpleScaleShape','SpawnAngel',
      'SpawnDeath','SpawnPlayer','SpawnSpectre','SpawnTrans','SpawnUber','SpawnWill','TEDDeath','T_DeathCam','T_FatThrow','TakeDamage',
      'Thrust','USL_GiveSaveName','USL_PrintInCenter','US_CPrint','US_CPrintLine','US_CenterWindow','US_CheckHighScore','US_CheckParm',
      'US_ClearWindow','US_DisplayHighScores','US_DrawWindow','US_FinishTextScreen','US_InitRndT','US_LineInput','US_Print','US_PrintCentered',
      'US_PrintSigned','US_PrintUnsigned','US_RestoreWindow','US_RndT','US_SaveWindow','US_SetLoadSaveHooks','US_SetPrintRoutines','US_Setup',
      'US_ShutCursor','US_Shutdown','US_StartCursor','US_Startup','US_TextScreen','US_UpdateCursor','US_UpdateTextScreen','VH_SetDefaultColors',
      'VL_CrtcStart','VL_DrawPicBare','VL_DrawPropString','VL_MungePic','VL_ScreenToScreen','VL_SetCRTC','VL_SetScreen','VL_SetVGAPlane',
      'VL_SizePropString','VL_VideoID','VWB_Bar','VWB_DrawMPic','VWB_DrawMPropString','VWB_DrawPic','VWB_DrawPropString',
      'VWB_DrawSprite','VWB_DrawTile16','VWB_DrawTile16M','VWB_DrawTile8','VWB_DrawTile8M','VWB_Hlin','VWB_Plot','VWB_Vlin',
      'VW_InitDoubleBuffer','VW_MarkUpdateBlock','VW_MeasurePropString','VW_UpdateScreen','Victory','ViewMap','VWL_UpdateScreenBlocks','Write','aftersort','beforesort',
      'Attack','INL_KeyHook','MapRow','Search','SelectItem','SelectWeapon','Use',
      'jabhack2','routine','US_Startup','US_Shutdown','think','update'
    ];
    for (const name of noops) {
      if (!this.coverage.has(name)) this.coverage.set(name, { kind: 'noop', fn: () => 0 });
    }
  }

  setImportNames(names = []) {
    this.importNames = [...names];
    this.importIds = new Map(this.importNames.map((name, index) => [name, index + 1]));
  }

  getImportId(name) {
    return this.importIds.get(name) || 0;
  }

  supportsImport(name) {
    return this.coverage.has(name);
  }

  getCoverageSummary(names = this.importNames) {
    const summary = { total: names.length, actual: 0, noop: 0, missing: 0, actualNames: [], noopNames: [], missingNames: [] };
    for (const name of names) {
      const entry = this.coverage.get(name);
      if (!entry) { summary.missing++; summary.missingNames.push(name); }
      else if (entry.kind === 'actual') { summary.actual++; summary.actualNames.push(name); }
      else { summary.noop++; summary.noopNames.push(name); }
    }
    return summary;
  }

  invokeImport(id, cpu, bus) {
    const name = this.importNames[(id | 0) - 1];
    if (!name) return 0;
    const entry = this.coverage.get(name);
    if (!entry) return 0;
    const ctx = {
      cpu,
      bus,
      arg: (index) => bus.read((cpu.SP + 2 + (index | 0)) | 0) | 0,
      setRet: (value) => { cpu.REG[0] = value | 0; },
      name,
      runtime: this,
    };
    const fn = entry.fn;
    return fn(ctx, ctx.arg(0), ctx.arg(1), ctx.arg(2), ctx.arg(3), ctx.arg(4), ctx.arg(5)) | 0;
  }

  configureExecutable(executable = null) {
    this.currentExecutable = executable || null;
    this.currentGlobals = (executable && executable.globals) || (executable && executable.meta && executable.meta.globals) || {};
    this.mmState = { blocks: new Map(), totalAllocated: 0, bombOnError: true };
    return { globals: Object.keys(this.currentGlobals).length | 0 };
  }

  configureMemoryLayout(layout = {}) {
    if (Number.isFinite(layout.heapBase)) {
      this.heapPtr = layout.heapBase | 0;
    }
    if (Number.isFinite(layout.stackStart)) {
      this.stackStart = layout.stackStart | 0;
    }
    if (Number.isFinite(layout.stackLimit)) {
      this.stackLimit = layout.stackLimit | 0;
    }
    return {
      heapBase: this.heapPtr | 0,
      stackStart: this.stackStart | 0,
      stackLimit: this.stackLimit | 0,
    };
  }

  tick(bus) {
    this.syncGuestInputState(bus);
    const timeCount = this.currentGlobals && this.currentGlobals.TimeCount;
    if (timeCount && Number.isFinite(timeCount.address)) {
      const addr = timeCount.address | 0;
      bus.write(addr, ((bus.read(addr) | 0) + 1) | 0);
    }
    const localTime = this.currentGlobals && this.currentGlobals.LocalTime;
    if (localTime && Number.isFinite(localTime.address)) {
      const addr = localTime.address | 0;
      bus.write(addr, ((bus.read(addr) | 0) + 1) | 0);
    }
    return 0;
  }

  alloc(size) {
    const words = Math.max(1, size | 0);
    const addr = this.heapPtr | 0;
    const next = (this.heapPtr + words) | 0;
    if (Number.isFinite(this.stackLimit) && next >= (this.stackLimit | 0)) {
      return 0;
    }
    this.heapPtr = next;
    return addr;
  }

  readCString(bus, addr) {
    const chars = [];
    let p = addr | 0;
    for (let i = 0; i < 4096; i++) {
      const ch = bus.read(p++) | 0;
      if (ch === 0) break;
      chars.push(String.fromCharCode(ch & 0xFF));
    }
    return chars.join('');
  }

  writeCString(bus, addr, text) {
    const s = String(text);
    for (let i = 0; i < s.length; i++) bus.write((addr + i) | 0, s.charCodeAt(i) | 0);
    bus.write((addr + s.length) | 0, 0);
    return addr | 0;
  }

  copyCString(bus, dst, text) {
    this.writeCString(bus, dst, text);
    return dst | 0;
  }

  appendCString(bus, dst, text) {
    const head = this.readCString(bus, dst);
    this.writeCString(bus, dst, head + String(text));
    return dst | 0;
  }

  compareStrings(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  copyWords(bus, dst, src, n) {
    const count = Math.max(0, n | 0);
    if ((src | 0) < (dst | 0)) {
      for (let i = count - 1; i >= 0; i--) bus.write((dst + i) | 0, bus.read((src + i) | 0));
    } else {
      for (let i = 0; i < count; i++) bus.write((dst + i) | 0, bus.read((src + i) | 0));
    }
    return dst | 0;
  }

  fillWords(bus, dst, value, n) {
    const count = Math.max(0, n | 0);
    for (let i = 0; i < count; i++) bus.write((dst + i) | 0, value | 0);
    return dst | 0;
  }

  compareWords(bus, a, b, n) {
    const count = Math.max(0, n | 0);
    for (let i = 0; i < count; i++) {
      const av = bus.read((a + i) | 0) | 0;
      const bv = bus.read((b + i) | 0) | 0;
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return 0;
  }


  resolveCaseInsensitive(targetPath) {
    const absolute = path.resolve(targetPath);
    if (fs.existsSync(absolute)) return absolute;
    const parsed = path.parse(absolute);
    let current = parsed.root;
    const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (const part of parts) {
      if (!fs.existsSync(current)) return null;
      const entries = fs.readdirSync(current);
      const match = entries.find((entry) => entry.toLowerCase() === part.toLowerCase());
      if (!match) return null;
      current = path.join(current, match);
    }
    return fs.existsSync(current) ? current : null;
  }

  fprintf(bus, fd, fmtAddr) {
    const text = this.readCString(bus, fmtAddr);
    if ((fd | 0) === 1 || (fd | 0) === 2) {
      this.stdout.push(text);
      return text.length | 0;
    }
    const addr = this.alloc(text.length + 1);
    this.writeCString(bus, addr, text);
    return this.writeHostFile(bus, fd, addr, text.length);
  }

  resolveHostPath(guestPath) {
    const normalized = normalizeGuestPath(guestPath);
    const assetRoots = [
      this.assetRoot,
      path.join(this.projectRoot, 'assets'),
      path.join(this.projectRoot, 'assets', 'wolf3d', 'raw'),
    ];
    const candidates = [
      path.resolve(this.projectRoot, normalized),
      ...assetRoots.flatMap((root) => [
        path.resolve(root, normalized),
        path.resolve(root, path.basename(normalized)),
      ]),
    ];
    for (const candidate of candidates) {
      const resolved = this.resolveCaseInsensitive(candidate);
      if (resolved) return resolved;
    }
    return path.resolve(this.assetRoot, path.basename(normalized));
  }

  openHostFile(guestPath, create = false) {
    const resolved = this.resolveHostPath(guestPath);
    let buffer = Buffer.alloc(0);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return -1;
      buffer = fs.readFileSync(resolved);
    } else if (!create) return -1;
    const fd = this.nextFd++;
    this.fdTable.set(fd, { path: resolved, buffer, position: 0, dirty: create });
    return fd | 0;
  }

  unlinkHostFile(guestPath) {
    const resolved = this.resolveHostPath(guestPath);
    try { if (fs.existsSync(resolved)) fs.unlinkSync(resolved); return 0; } catch { return -1; }
  }

  wildcardToRegExp(pattern) {
    const escaped = String(pattern || '')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  }

  listGuestFiles() {
    try {
      return fs.readdirSync(this.assetRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  writeFindBlock(bus, blk, name) {
    const filename = String(name || '').slice(0, 12);
    this.writeCString(bus, blk | 0, filename);
    return 0;
  }

  findFirst(bus, patternPtr, blkPtr) {
    const pattern = this.readCString(bus, patternPtr);
    const matcher = this.wildcardToRegExp(path.basename(pattern));
    const matches = this.listGuestFiles().filter((name) => matcher.test(name)).sort((a, b) => a.localeCompare(b));
    if (!matches.length) {
      this.findState = { matches: [], index: -1, pattern };
      return -1;
    }
    this.findState = { matches, index: 0, pattern };
    return this.writeFindBlock(bus, blkPtr, matches[0]);
  }

  findNext(bus, blkPtr) {
    if (!this.findState.matches.length) return -1;
    const nextIndex = (this.findState.index | 0) + 1;
    if (nextIndex >= this.findState.matches.length) return -1;
    this.findState.index = nextIndex;
    return this.writeFindBlock(bus, blkPtr, this.findState.matches[nextIndex]);
  }

  closeHostFile(fd) {
    const entry = this.fdTable.get(fd | 0);
    if (!entry) return -1;
    if (entry.dirty) {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      fs.writeFileSync(entry.path, entry.buffer);
    }
    this.fdTable.delete(fd | 0);
    return 0;
  }

  fileLength(fd) {
    const entry = this.fdTable.get(fd | 0);
    return entry ? entry.buffer.length | 0 : -1;
  }

  seekHostFile(fd, offset, whence) {
    const entry = this.fdTable.get(fd | 0);
    if (!entry) return -1;
    const base = (whence | 0) === 1 ? entry.position : (whence | 0) === 2 ? entry.buffer.length : 0;
    entry.position = Math.max(0, Math.min(entry.buffer.length, (base + (offset | 0)) | 0));
    return entry.position | 0;
  }

  readHostFile(bus, fd, dst, count) {
    const entry = this.fdTable.get(fd | 0);
    if (!entry) return -1;
    const n = Math.max(0, Math.min(count | 0, entry.buffer.length - entry.position));
    for (let i = 0; i < n; i++) bus.write((dst + i) | 0, entry.buffer[entry.position + i] | 0);
    entry.position += n;
    return n | 0;
  }

  writeHostFile(bus, fd, src, count) {
    const n = Math.max(0, count | 0);
    if ((fd | 0) === 1 || (fd | 0) === 2) {
      let text = '';
      for (let i = 0; i < n; i++) text += String.fromCharCode(bus.read((src + i) | 0) & 0xFF);
      this.stdout.push(text);
      return n | 0;
    }
    const entry = this.fdTable.get(fd | 0);
    if (!entry) return -1;
    const buf = Buffer.alloc(Math.max(entry.buffer.length, entry.position + n));
    entry.buffer.copy(buf, 0, 0, entry.buffer.length);
    for (let i = 0; i < n; i++) buf[entry.position + i] = bus.read((src + i) | 0) & 0xFF;
    entry.buffer = buf;
    entry.position += n;
    entry.dirty = true;
    return n | 0;
  }

  formatInt(value, base, unsigned = false) {
    const radix = Math.max(2, Math.min(36, (base | 0) || 10));
    if (unsigned) return (value >>> 0).toString(radix);
    return (value | 0).toString(radix);
  }

  toRgbFromVga6(r, g, b) {
    const r8 = Math.max(0, Math.min(63, r | 0)) * 255 / 63;
    const g8 = Math.max(0, Math.min(63, g | 0)) * 255 / 63;
    const b8 = Math.max(0, Math.min(63, b | 0)) * 255 / 63;
    return (((r8 & 0xFF) << 16) | ((g8 & 0xFF) << 8) | (b8 & 0xFF)) >>> 0;
  }

  findGamePalettePath() {
    const candidates = [
      path.join(this.projectRoot, 'historical', 'wolf3d_official', 'wolf3d-master', 'WOLFSRC', 'OBJ', 'GAMEPAL.OBJ'),
      path.join(this.projectRoot, 'historical', 'wolf3d_official', 'WOLFSRC', 'OBJ', 'GAMEPAL.OBJ'),
      path.join(this.projectRoot, 'OBJ', 'GAMEPAL.OBJ'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }

  loadGamePalette() {
    if (this.paletteData !== undefined) return this.paletteData;
    try {
      const palettePath = this.findGamePalettePath();
      if (!palettePath) {
        this.paletteData = null;
        return this.paletteData;
      }
      const buffer = fs.readFileSync(palettePath);
      let offset = 0;
      while (offset + 3 <= buffer.length) {
        const type = buffer[offset];
        const length = buffer.readUInt16LE(offset + 1);
        const end = offset + 3 + length;
        if (type === 0xA0 && end <= buffer.length) {
          const payload = buffer.slice(offset + 3, end);
          if (payload.length >= 3 + 768) {
            const palette = Buffer.from(payload.slice(3, 3 + 768));
            this.paletteData = palette;
            this.activePalette = new Array(256).fill(0).map((_, i) => this.toRgbFromVga6(palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]));
            return this.paletteData;
          }
        }
        offset = end;
      }
      this.paletteData = null;
    } catch {
      this.paletteData = null;
    }
    return this.paletteData;
  }

  getActivePalette() {
    if (this.activePalette && this.activePalette.length === 256) return this.activePalette;
    const palette = this.loadGamePalette();
    if (palette && palette.length >= 768) return this.activePalette;
    this.activePalette = new Array(256).fill(0).map((_, i) => this.toRgbFromVga6(i >> 4, i >> 2, i));
    return this.activePalette;
  }

  setPaletteFromGuest(bus, ptr, start = 0, end = 255) {
    const palette = this.getActivePalette().slice();
    const lo = Math.max(0, start | 0);
    const hi = Math.min(255, end | 0);
    let base = ptr | 0;
    for (let i = lo; i <= hi; i++) {
      const r = bus.read(base++) | 0;
      const g = bus.read(base++) | 0;
      const b = bus.read(base++) | 0;
      palette[i] = this.toRgbFromVga6(r, g, b);
    }
    this.activePalette = palette;
    return 0;
  }

  writePaletteToGuest(bus, ptr) {
    const palette6 = this.loadGamePalette();
    if (!palette6 || palette6.length < 768) return 0;
    for (let i = 0; i < 768; i++) bus.write((ptr | 0) + i, palette6[i] | 0);
    return 0;
  }

  getVideoDevice(bus) {
    return (bus && Array.isArray(bus.devices)) ? bus.devices.find((dev) => dev && dev.frameBuffer && Number.isFinite(dev.width) && Number.isFinite(dev.height)) : null;
  }

  colorFromIndex(index) {
    const palette = this.getActivePalette();
    return palette[(index | 0) & 0xFF] >>> 0;
  }

  clearVideo(bus, color = 0) {
    const gpu = this.getVideoDevice(bus);
    if (gpu && typeof gpu.clear === 'function') gpu.clear(color | 0);
    this.uiState.cursorX = 8;
    this.uiState.cursorY = 8;
    return 0;
  }

  plotPixel(bus, x, y, color = 0x00FFFFFF) {
    const gpu = this.getVideoDevice(bus);
    if (!gpu) return 0;
    const px = x | 0;
    const py = y | 0;
    if (px < 0 || py < 0 || px >= gpu.width || py >= gpu.height) return 0;
    bus.write((MMIO.GPU_BASE + py * gpu.width + px) | 0, color | 0);
    return 0;
  }

  drawHLine(bus, x, y, width, color = 0x00FFFFFF) {
    const py = y | 0;
    const count = Math.max(0, width | 0);
    for (let i = 0; i < count; i++) this.plotPixel(bus, (x | 0) + i, py, color);
    return 0;
  }

  drawVLine(bus, x, y, height, color = 0x00FFFFFF) {
    const px = x | 0;
    const count = Math.max(0, height | 0);
    for (let i = 0; i < count; i++) this.plotPixel(bus, px, (y | 0) + i, color);
    return 0;
  }

  drawRect(bus, x, y, width, height, color = 0x00FFFFFF) {
    const gpu = this.getVideoDevice(bus);
    if (!gpu) return 0;
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(gpu.width, x0 + Math.max(0, width | 0));
    const y1 = Math.min(gpu.height, y0 + Math.max(0, height | 0));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        bus.write((MMIO.GPU_BASE + yy * gpu.width + xx) | 0, color | 0);
      }
    }
    return 0;
  }

  setTextWindow(bus, x, y, w, h) {
    this.uiState.window = { x: Math.max(0, x | 0), y: Math.max(0, y | 0), w: Math.max(8, w | 0), h: Math.max(8, h | 0) };
    this.drawRect(bus, this.uiState.window.x, this.uiState.window.y, this.uiState.window.w, this.uiState.window.h, 0x00102030);
    this.drawRect(bus, this.uiState.window.x + 1, this.uiState.window.y + 1, this.uiState.window.w - 2, this.uiState.window.h - 2, 0x00E8E8E8);
    this.uiState.cursorX = this.uiState.window.x + 4;
    this.uiState.cursorY = this.uiState.window.y + 4;
    return 0;
  }

  clearWindow(bus) {
    const w = this.uiState.window;
    if (w.w > 0 && w.h > 0) this.drawRect(bus, w.x + 2, w.y + 2, Math.max(0, w.w - 4), Math.max(0, w.h - 4), 0x00E8E8E8);
    this.uiState.cursorX = w.x + 4;
    this.uiState.cursorY = w.y + 4;
    return 0;
  }

  readGuestValue(bus, name, fallback = 0) {
    const addr = this.readGuestGlobal(name);
    if (!addr) return fallback | 0;
    return bus.read(addr | 0) | 0;
  }

  writeGuestValue(bus, name, value) {
    const addr = this.readGuestGlobal(name);
    if (addr) bus.write(addr | 0, value | 0);
    return value | 0;
  }

  getGuestTextColor(bus, fallback = 0x00FFFFFF) {
    const idx = this.readGuestValue(bus, 'fontcolor', -1);
    return idx >= 0 ? this.colorFromIndex(idx) : (fallback >>> 0);
  }

  getGuestBackColor(bus, fallback = 0x00000000) {
    const idx = this.readGuestValue(bus, 'backcolor', -1);
    return idx >= 0 ? this.colorFromIndex(idx) : (fallback >>> 0);
  }

  getGuestWindow(bus) {
    const fallback = this.uiState.window || { x: 0, y: 0, w: 160, h: 120 };
    const x = this.readGuestValue(bus, 'WindowX', fallback.x || 0);
    const y = this.readGuestValue(bus, 'WindowY', fallback.y || 0);
    const w = Math.max(8, this.readGuestValue(bus, 'WindowW', fallback.w || 160));
    const h = Math.max(8, this.readGuestValue(bus, 'WindowH', fallback.h || 120));
    return { x, y, w, h };
  }

  syncGuestWindow(bus, window = {}) {
    const next = {
      x: Math.max(0, window.x | 0),
      y: Math.max(0, window.y | 0),
      w: Math.max(8, window.w | 0),
      h: Math.max(8, window.h | 0),
    };
    this.uiState.window = next;
    this.writeGuestValue(bus, 'WindowX', next.x);
    this.writeGuestValue(bus, 'WindowY', next.y);
    this.writeGuestValue(bus, 'WindowW', next.w);
    this.writeGuestValue(bus, 'WindowH', next.h);
    this.writeGuestValue(bus, 'PrintX', next.x);
    this.writeGuestValue(bus, 'PrintY', next.y);
    this.uiState.cursorX = next.x;
    this.uiState.cursorY = next.y;
    return next;
  }

  drawGuestWindow(bus, x, y, w, h) {
    const next = this.syncGuestWindow(bus, { x: (x | 0) * 8, y: (y | 0) * 8, w: (w | 0) * 8, h: (h | 0) * 8 });
    const border = this.getGuestTextColor(bus, 0x00FFFFFF);
    const fill = this.getGuestBackColor(bus, 0x00202020);
    this.drawRect(bus, next.x, next.y, next.w, next.h, border);
    this.drawRect(bus, next.x + 1, next.y + 1, Math.max(0, next.w - 2), Math.max(0, next.h - 2), fill);
    this.writeGuestValue(bus, 'PrintX', next.x);
    this.writeGuestValue(bus, 'PrintY', next.y);
    this.uiState.cursorX = next.x;
    this.uiState.cursorY = next.y;
    return 0;
  }

  centerGuestWindow(bus, w, h) {
    const width = Math.max(8, (w | 0) * 8);
    const height = Math.max(8, (h | 0) * 8);
    const x = ((160 - width) / 2) | 0;
    const y = ((120 - height) / 2) | 0;
    return this.drawGuestWindow(bus, x >> 3, y >> 3, w, h);
  }

  clearGuestWindow(bus) {
    const win = this.getGuestWindow(bus);
    this.drawRect(bus, win.x, win.y, win.w, win.h, this.getGuestBackColor(bus, 0x00000000));
    this.writeGuestValue(bus, 'PrintX', win.x);
    this.writeGuestValue(bus, 'PrintY', win.y);
    this.uiState.cursorX = win.x;
    this.uiState.cursorY = win.y;
    return 0;
  }

  getGuestPrintPosition(bus, xName = 'PrintX', yName = 'PrintY') {
    return { x: this.readGuestValue(bus, xName, this.uiState.cursorX || 0), y: this.readGuestValue(bus, yName, this.uiState.cursorY || 0) };
  }

  setGuestPrintPosition(bus, x, y, xName = 'PrintX', yName = 'PrintY') {
    this.writeGuestValue(bus, xName, x | 0);
    this.writeGuestValue(bus, yName, y | 0);
    this.uiState.cursorX = x | 0;
    this.uiState.cursorY = y | 0;
    return 0;
  }

  drawGuestString(bus, text, xName = 'PrintX', yName = 'PrintY') {
    const pos = this.getGuestPrintPosition(bus, xName, yName);
    const color = this.getGuestTextColor(bus, this.uiState.textColor);
    this.hostDrawString(bus, text, pos.x, pos.y, color);
    this.uiState.cursorX = pos.x;
    this.uiState.cursorY = pos.y;
    return 0;
  }

  printGuestString(bus, text, centered = false, newline = false) {
    const str = String(text);
    const win = this.getGuestWindow(bus);
    let { x, y } = this.getGuestPrintPosition(bus, 'PrintX', 'PrintY');
    const color = this.getGuestTextColor(bus, this.uiState.textColor);
    const lines = str.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const metrics = this.measureText(line);
      const drawX = centered ? (win.x + (((win.w - metrics.width) / 2) | 0)) : x;
      if (line) this.hostDrawString(bus, line, drawX, y, color);
      if (i < lines.length - 1 || newline) {
        x = win.x;
        y += 8;
      } else {
        x = drawX + metrics.width;
      }
    }
    this.setGuestPrintPosition(bus, x, y, 'PrintX', 'PrintY');
    return 0;
  }

  drawGuestCursor(bus) {
    const pos = this.getGuestPrintPosition(bus, 'PrintX', 'PrintY');
    this.drawRect(bus, pos.x, pos.y + 7, 5, 1, this.getGuestTextColor(bus, this.uiState.textColor));
    return 0;
  }

  measureText(text) {
    const lines = String(text).split(/\n/);
    const width = lines.reduce((m, line) => Math.max(m, line.length), 0) * 6;
    const height = Math.max(1, lines.length) * 8;
    return { width, height };
  }

  writeStringMeasure(bus, text, wPtr, hPtr) {
    const m = this.measureText(text);
    if (wPtr) bus.write(wPtr, m.width | 0);
    if (hPtr) bus.write(hPtr, m.height | 0);
    return 0;
  }

  getFontGlyph(ch) {
    const table = FONT5X7[ch] || FONT5X7[ch.toUpperCase()] || FONT5X7['?'];
    return table;
  }

  hostDrawString(bus, text, x, y, color = 0x00FFFFFF) {
    const str = String(text);
    let cx = x | 0;
    let cy = y | 0;
    for (const ch of str) {
      if (ch === '\n') {
        cx = x | 0;
        cy += 8;
        continue;
      }
      const glyph = this.getFontGlyph(ch);
      for (let row = 0; row < glyph.length; row++) {
        const bits = glyph[row] | 0;
        for (let col = 0; col < 5; col++) {
          if ((bits >> (4 - col)) & 1) this.plotPixel(bus, cx + col, cy + row, color);
        }
      }
      cx += 6;
    }
    this.stdout.push(str);
    return 0;
  }

  printText(bus, text, centered = false, newline = false) {
    const str = String(text);
    const metrics = this.measureText(str);
    const baseX = centered && this.uiState.window.w
      ? (this.uiState.window.x + (((this.uiState.window.w - metrics.width) / 2) | 0))
      : this.uiState.cursorX;
    this.hostDrawString(bus, str, baseX, this.uiState.cursorY, this.uiState.textColor);
    if (newline || centered) {
      this.uiState.cursorX = this.uiState.window.x ? this.uiState.window.x + 4 : 8;
      this.uiState.cursorY += 8;
    } else {
      this.uiState.cursorX = baseX + metrics.width;
    }
    return 0;
  }

  drawCursor(bus) {
    const x = this.uiState.cursorX | 0;
    const y = this.uiState.cursorY | 0;
    this.drawRect(bus, x, y + 7, 5, 1, this.uiState.textColor);
    return 0;
  }

  normalizeKeyEvent(value) {
    const raw = String(value == null ? '' : value);
    const token = raw === '\n' ? 'Enter' : raw;
    if (!token) return null;
    const named = {
      Enter: { ascii: 13, scan: 0x1c, token: 'Enter' },
      Escape: { ascii: 27, scan: 0x01, token: 'Escape' },
      Tab: { ascii: 9, scan: 0x0f, token: 'Tab' },
      Backspace: { ascii: 8, scan: 0x0e, token: 'Backspace' },
      ' ': { ascii: 32, scan: 0x39, token: 'Space' },
      Space: { ascii: 32, scan: 0x39, token: 'Space' },
      ArrowUp: { ascii: 0, scan: 0x48, token: 'ArrowUp' },
      ArrowDown: { ascii: 0, scan: 0x50, token: 'ArrowDown' },
      ArrowLeft: { ascii: 0, scan: 0x4b, token: 'ArrowLeft' },
      ArrowRight: { ascii: 0, scan: 0x4d, token: 'ArrowRight' },
      Control: { ascii: 0, scan: 0x1d, token: 'Control' },
      Alt: { ascii: 0, scan: 0x38, token: 'Alt' },
      Shift: { ascii: 0, scan: 0x2a, token: 'Shift' },
    };
    if (named[token]) return { ...named[token] };
    if (token.length === 1) {
      const ch = token.charCodeAt(0) | 0;
      const lower = token.toLowerCase();
      const scanMap = {
        a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23,
        i: 0x17, j: 0x24, k: 0x25, l: 0x26, m: 0x32, n: 0x31, o: 0x18, p: 0x19,
        q: 0x10, r: 0x13, s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d,
        y: 0x15, z: 0x2c,
        '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06,
        '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0a, '0': 0x0b,
      };
      return { ascii: ch, scan: scanMap[lower] || ch, token: lower };
    }
    return { ascii: 0, scan: 0, token };
  }

  enqueueKey(value, down = true, bus = null) {
    const event = this.normalizeKeyEvent(value);
    if (!event) return 0;
    const isDown = down !== false;
    if (isDown) {
      this.keyQueue.push(event);
      this.lastKeyEvent = event;
      if (event.token) {
        this.keyState.add(event.token);
        this.hostPressedKeys.add(event.token);
      }
      if (event.scan) this.keyStateByCode.set(event.scan | 0, event.token || String(event.scan | 0));
      if (bus) this.applyGuestKeyEvent(bus, event, true);
    } else {
      if (event.token) {
        this.keyState.delete(event.token);
        this.hostPressedKeys.delete(event.token);
      }
      if (event.scan) this.keyStateByCode.delete(event.scan | 0);
      if (bus) this.applyGuestKeyEvent(bus, event, false);
    }
    return event.ascii || event.scan || 0;
  }

  kbhit(bus) {
    return (this.keyQueue.length > 0 || (bus.read(MMIO.KEYBOARD) | 0) !== 0) ? 1 : 0;
  }

  readGuestGlobal(name) {
    const sym = this.currentGlobals && this.currentGlobals[name];
    if (!sym || !Number.isFinite(sym.address)) return 0;
    return sym.address | 0;
  }

  writeMminfo(bus, values = {}) {
    const base = this.readGuestGlobal('mminfo');
    if (!base) return 0;
    const nearheap = values.nearheap ?? 0;
    const farheap = values.farheap ?? 0;
    const ems = values.EMSmem ?? 0;
    const xms = values.XMSmem ?? 0;
    const main = values.mainmem ?? ((nearheap | 0) + (farheap | 0));
    bus.write(base + 0, nearheap | 0);
    bus.write(base + 1, farheap | 0);
    bus.write(base + 2, ems | 0);
    bus.write(base + 3, xms | 0);
    bus.write(base + 4, main | 0);
    return 0;
  }

  pmStartup(bus) {
    const wolf = this.loadWolfData() || {};
    const vswap = wolf.vswap || {};
    const set = (name, value) => { const addr = this.readGuestGlobal(name); if (addr) bus.write(addr, value | 0); };
    const setString = (name, value) => { const addr = this.readGuestGlobal(name); if (addr) this.writeCString(bus, addr, value); };
    set('XMSPresent', 0);
    set('EMSPresent', 0);
    set('XMSPagesAvail', 0);
    set('EMSPagesAvail', 0);
    set('ChunksInFile', vswap.chunksInFile || 0);
    set('PMSpriteStart', vswap.spriteStart || 0);
    set('PMSoundStart', vswap.soundStart || 0);
    set('PMPages', 0);
    set('MainPresent', 0);
    set('MainPagesAvail', 0);
    set('MainPagesUsed', 0);
    set('PMNumBlocks', vswap.chunksInFile || 0);
    set('PMFrameCount', 0);
    set('PMSegPages', 0);
    set('PageFile', 0);
    set('PMStarted', 1);
    set('PMPanicMode', 0);
    set('PMThrashing', 0);
    setString('PageFileName', 'VSWAP.WL6');
    return 0;
  }

  pmShutdown(bus) {
    const started = this.readGuestGlobal('PMStarted');
    if (started) bus.write(started, 0);
    return 0;
  }

  mmStartup(bus) {
    this.mmState = { blocks: new Map(), totalAllocated: 0, bombOnError: true };
    const freeBytes = this.mmUnusedMemory();
    const nearheap = Math.min(freeBytes >> 1, 96 * 1024) | 0;
    const farheap = Math.max(0, freeBytes - nearheap) | 0;
    this.writeMminfo(bus, { nearheap, farheap, EMSmem: 0, XMSmem: 0, mainmem: freeBytes });
    const mmerror = this.readGuestGlobal('mmerror');
    if (mmerror) bus.write(mmerror, 0);
    const bufferseg = this.readGuestGlobal('bufferseg');
    if (bufferseg) {
      const ptr = this.alloc(0x1000);
      this.mmState.blocks.set(bufferseg | 0, { ptr, size: 0x1000, purge: 0, locked: true });
      this.mmState.totalAllocated = (this.mmState.totalAllocated + 0x1000) | 0;
      bus.write(bufferseg, ptr | 0);
    }
    return 0;
  }

  mmShutdown(bus) {
    const bufferseg = this.readGuestGlobal('bufferseg');
    if (bufferseg) bus.write(bufferseg, 0);
    this.mmState = { blocks: new Map(), totalAllocated: 0, bombOnError: this.mmState.bombOnError };
    return 0;
  }

  mmGetPtr(bus, basePtr, size) {
    const bytes = Math.max(1, size | 0);
    const ptr = this.alloc(bytes);
    if (!ptr) {
      const mmerror = this.readGuestGlobal('mmerror');
      if (mmerror) bus.write(mmerror, 1);
      return 0;
    }
    bus.write(basePtr | 0, ptr | 0);
    this.mmState.blocks.set(basePtr | 0, { ptr, size: bytes, purge: 0, locked: false });
    this.mmState.totalAllocated = (this.mmState.totalAllocated + bytes) | 0;
    const mmerror = this.readGuestGlobal('mmerror');
    if (mmerror) bus.write(mmerror, 0);
    return 0;
  }

  mmFreePtr(bus, basePtr) {
    const base = basePtr | 0;
    const entry = this.mmState.blocks.get(base);
    if (entry) this.mmState.blocks.delete(base);
    bus.write(base, 0);
    return 0;
  }

  mmUnusedMemory() {
    const top = Number.isFinite(this.stackLimit) ? (this.stackLimit | 0) : ((this.heapPtr + (128 * 1024)) | 0);
    return Math.max(0, (top - (this.heapPtr | 0)) | 0);
  }

  popKeyEvent(bus) {
    let event = null;
    if (this.keyQueue.length) event = this.keyQueue.shift() || null;
    else {
      const ascii = bus.read(MMIO.KEYBOARD) | 0;
      if (ascii) event = this.normalizeKeyEvent(String.fromCharCode(ascii & 0xFF));
    }
    bus.write(MMIO.KEYBOARD, 0);
    if (event) this.consumeGuestKey(bus, event);
    return event;
  }

  readKeyboard(bus) {
    const event = this.popKeyEvent(bus);
    if (!event) return 0;
    return (event.ascii || event.scan || 0) | 0;
  }

  clearKeys(bus) {
    this.keyQueue = [];
    this.keyState.clear();
    this.keyStateByCode.clear();
    this.lastKeyEvent = null;
    if (bus) {
      bus.write(MMIO.KEYBOARD, 0);
      this.clearGuestInputState(bus);
    }
    return 0;
  }

  mouseButtons(bus) {
    let buttons = bus.read(MMIO.MOUSE + 2) | 0;
    if (this.hostPressedKeys.has('Space') || this.hostPressedKeys.has('control') || this.hostPressedKeys.has('Control') || this.hostPressedKeys.has('x')) buttons |= 1;
    if (this.hostPressedKeys.has('Alt') || this.hostPressedKeys.has('alt') || this.hostPressedKeys.has('z')) buttons |= 2;
    return buttons | 0;
  }

  startAck(bus) {
    this.clearKeys(bus);
    const buttons = this.mouseButtons(bus);
    this.ackButtons = new Array(8).fill(false);
    for (let i = 0, mask = buttons; i < 8; i++, mask >>= 1) this.ackButtons[i] = !!(mask & 1);
    return 0;
  }

  checkAck(bus) {
    if (this.kbhit(bus)) return this.popKeyEvent(bus) ? 1 : 0;
    const buttons = this.mouseButtons(bus);
    for (let i = 0, mask = buttons; i < 8; i++, mask >>= 1) {
      const down = !!(mask & 1);
      if (down && !this.ackButtons[i]) return 1;
      if (!down) this.ackButtons[i] = false;
    }
    return 0;
  }

  userInput(bus, delay) {
    if (this.checkAck(bus)) return 1;
    const timeCount = this.currentGlobals && this.currentGlobals.TimeCount;
    if (timeCount && Number.isFinite(timeCount.address)) {
      const elapsed = bus.read(timeCount.address | 0) | 0;
      return elapsed >= (delay | 0) ? 0 : 0;
    }
    return 0;
  }

  waitForAscii(bus) {
    const event = this.popKeyEvent(bus);
    return event ? ((event.ascii || 0) | 0) : 0;
  }

  waitForKey(bus) {
    const event = this.popKeyEvent(bus);
    return event ? ((event.scan || event.ascii || 0) | 0) : 0;
  }

  inputAck(bus) {
    const key = this.popKeyEvent(bus);
    const mouse = this.mouseButtons(bus);
    if (mouse) bus.write(MMIO.MOUSE + 2, 0);
    return (key || mouse) ? 1 : 0;
  }


  inputStartup(bus) {
    const mousePresent = this.readGuestGlobal('MousePresent');
    if (mousePresent) bus.write(mousePresent, 1);
    const joysPresent = this.readGuestGlobal('JoysPresent');
    if (joysPresent) {
      bus.write(joysPresent + 0, 0);
      bus.write(joysPresent + 1, 0);
    }
    this.inputSetControlType(bus, 0, 0);
    this.syncGuestInputState(bus);
    return 0;
  }

  inputShutdown(bus) {
    this.clearKeys(bus);
    const mousePresent = this.readGuestGlobal('MousePresent');
    if (mousePresent) bus.write(mousePresent, 0);
    return 0;
  }

  inputDefault(bus, gotit, type) {
    const requested = type | 0;
    const selected = requested >= 0 && requested <= 4 ? requested : 0;
    return this.inputSetControlType(bus, 0, selected);
  }

  inputSetControlType(bus, player, type) {
    const controls = this.readGuestGlobal('Controls');
    if (!controls) return 0;
    const slot = Math.max(0, Math.min(3, player | 0));
    bus.write((controls | 0) + slot, type | 0);
    return 0;
  }

  clearGuestInputState(bus) {
    const keyboard = this.readGuestGlobal('Keyboard');
    if (keyboard) {
      for (let i = 0; i < 128; i++) bus.write((keyboard | 0) + i, 0);
    }
    const lastScan = this.readGuestGlobal('LastScan');
    if (lastScan) bus.write(lastScan, 0);
    const lastAscii = this.readGuestGlobal('LastASCII');
    if (lastAscii) bus.write(lastAscii, 0);
    return 0;
  }

  applyGuestKeyEvent(bus, event, down = true) {
    if (!bus || !event) return 0;
    const keyboard = this.readGuestGlobal('Keyboard');
    if (keyboard && event.scan) bus.write((keyboard | 0) + (event.scan | 0), down ? 1 : 0);
    if (down) {
      const lastScan = this.readGuestGlobal('LastScan');
      if (lastScan && !(bus.read(lastScan) | 0) && event.scan) bus.write(lastScan, event.scan | 0);
      const lastAscii = this.readGuestGlobal('LastASCII');
      if (lastAscii && !(bus.read(lastAscii) | 0) && event.ascii) bus.write(lastAscii, event.ascii | 0);
    }
    return 0;
  }

  consumeGuestKey(bus, event) {
    if (!bus || !event) return 0;
    const lastScan = this.readGuestGlobal('LastScan');
    if (lastScan && (bus.read(lastScan) | 0) === (event.scan | 0)) bus.write(lastScan, 0);
    const lastAscii = this.readGuestGlobal('LastASCII');
    if (lastAscii && (bus.read(lastAscii) | 0) === (event.ascii | 0)) bus.write(lastAscii, 0);
    return 0;
  }

  syncGuestInputState(bus) {
    if (!bus) return 0;
    const keyboard = this.readGuestGlobal('Keyboard');
    if (keyboard) {
      for (let i = 0; i < 128; i++) bus.write((keyboard | 0) + i, 0);
      for (const scan of this.keyStateByCode.keys()) {
        if ((scan | 0) >= 0 && (scan | 0) < 128) bus.write((keyboard | 0) + (scan | 0), 1);
      }
    }
    const mousePresent = this.readGuestGlobal('MousePresent');
    if (mousePresent) bus.write(mousePresent, 1);
    if (this.keyQueue.length) {
      const peek = this.keyQueue[0];
      this.applyGuestKeyEvent(bus, peek, true);
    }
    return 0;
  }

  readGuestNumber(bus, name, fallback = 0) {
    const addr = this.readGuestGlobal(name);
    return addr ? (bus.read(addr | 0) | 0) : (fallback | 0);
  }

  writeGuestNumber(bus, name, value) {
    const addr = this.readGuestGlobal(name);
    if (!addr) return 0;
    bus.write(addr | 0, value | 0);
    return value | 0;
  }

  getCurrentWolfMap(bus) {
    const wolf = this.loadWolfData();
    if (!wolf || !wolf.maps || !wolf.maps.length) return null;
    const mapIndex = this.readGuestNumber(bus, 'mapon', 0);
    return wolf.maps.find((entry) => (entry.index | 0) === (mapIndex | 0)) || wolf.maps[0];
  }

  isWolfSolid(tile) {
    const value = tile | 0;
    if (value <= 0) return false;
    if (value >= 106 && value <= 143) return false;
    return true;
  }

  isWolfSolidAt(map, x, y) {
    if (!map || !map.planes || !map.planes[0]) return true;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= map.width || yi >= map.height) return true;
    const plane = map.planes[0];
    return this.isWolfSolid(plane[yi * map.width + xi] | 0);
  }

  stepHostAssists(bus) {
    const map = this.getCurrentWolfMap(bus);
    if (!map) return 0;
    const moved = this.applyHostNavigationAssist(bus, map);
    if (moved) this.renderWolfView(bus);
    return moved;
  }

  applyHostNavigationAssist(bus, map) {
    if (!map) return 0;
    const forward = this.hostPressedKeys.has('ArrowUp') || this.hostPressedKeys.has('w');
    const backward = this.hostPressedKeys.has('ArrowDown') || this.hostPressedKeys.has('s');
    const turnLeft = this.hostPressedKeys.has('ArrowLeft');
    const turnRight = this.hostPressedKeys.has('ArrowRight');
    const strafeLeft = this.hostPressedKeys.has('a') || this.hostPressedKeys.has('q');
    const strafeRight = this.hostPressedKeys.has('d') || this.hostPressedKeys.has('e');
    const active = forward || backward || turnLeft || turnRight || strafeLeft || strafeRight;
    const guestX = this.readGuestNumber(bus, 'viewx', 0) / 65536;
    const guestY = this.readGuestNumber(bus, 'viewy', 0) / 65536;
    let guestAngle = this.readGuestNumber(bus, 'viewangle', 0) % 360;
    if (guestAngle < 0) guestAngle += 360;
    let state = this.hostNavState.override;
    if (!state || state.mapIndex !== (map.index | 0)) {
      state = { mapIndex: map.index | 0, posX: guestX, posY: guestY, angleDeg: guestAngle };
    }
    if (!active) {
      const changed = Math.abs(state.posX - guestX) > 1e-6 || Math.abs(state.posY - guestY) > 1e-6 || (state.angleDeg | 0) !== (guestAngle | 0);
      if (!changed) return 0;
      this.writeGuestNumber(bus, 'viewangle', state.angleDeg | 0);
      this.writeGuestNumber(bus, 'viewx', Math.round(state.posX * 65536));
      this.writeGuestNumber(bus, 'viewy', Math.round(state.posY * 65536));
      this.hostNavState.override = state;
      return 1;
    }
    this.hostNavState.stepCounter = ((this.hostNavState.stepCounter | 0) + 1) | 0;
    if ((this.hostNavState.stepCounter & 1) !== 0) {
      this.hostNavState.override = state;
      return 0;
    }
    let posX = state.posX;
    let posY = state.posY;
    let angleDeg = state.angleDeg;
    let turnDelta = 0;
    if (turnLeft) turnDelta -= 4;
    if (turnRight) turnDelta += 4;
    angleDeg = (angleDeg + turnDelta + 360) % 360;
    const angle = (angleDeg * Math.PI) / 180;
    let moveX = 0;
    let moveY = 0;
    const moveStep = 0.18;
    const strafeStep = 0.14;
    if (forward) {
      moveX += Math.cos(angle) * moveStep;
      moveY += Math.sin(angle) * moveStep;
    }
    if (backward) {
      moveX -= Math.cos(angle) * moveStep;
      moveY -= Math.sin(angle) * moveStep;
    }
    if (strafeLeft) {
      moveX += Math.cos(angle - Math.PI / 2) * strafeStep;
      moveY += Math.sin(angle - Math.PI / 2) * strafeStep;
    }
    if (strafeRight) {
      moveX += Math.cos(angle + Math.PI / 2) * strafeStep;
      moveY += Math.sin(angle + Math.PI / 2) * strafeStep;
    }
    const radius = 0.2;
    const nextX = posX + moveX;
    const nextY = posY + moveY;
    if (!this.isWolfSolidAt(map, nextX + Math.sign(moveX || 0) * radius, posY) && !this.isWolfSolidAt(map, nextX, posY)) posX = nextX;
    if (!this.isWolfSolidAt(map, posX, nextY + Math.sign(moveY || 0) * radius) && !this.isWolfSolidAt(map, posX, nextY)) posY = nextY;
    state = { mapIndex: map.index | 0, posX, posY, angleDeg };
    this.hostNavState.override = state;
    this.writeGuestNumber(bus, 'viewangle', angleDeg | 0);
    this.writeGuestNumber(bus, 'viewx', Math.round(posX * 65536));
    this.writeGuestNumber(bus, 'viewy', Math.round(posY * 65536));
    return 1;
  }

  sampleWallColumn(tileValue, texX, texY) {
    const wolf = this.loadWolfData();
    const walls = (((wolf || {}).vswap || {}).walls) || [];
    if (!walls.length) return this.colorFromIndex(tileValue | 0);
    const normalized = Math.max(0, (tileValue | 0) - 1);
    const wall = walls[normalized % walls.length];
    const sx = Math.max(0, Math.min(63, texX | 0));
    const sy = Math.max(0, Math.min(63, texY | 0));
    return this.colorFromIndex(wall.data[sy * 64 + sx] | 0);
  }

  renderWolfView(bus) {
    const map = this.getCurrentWolfMap(bus);
    if (!map) {
      const wallCount = (((this.loadWolfData() || {}).vswap || {}).walls || []).length | 0;
      const wallIndex = wallCount ? ((this.uiState.wallIndex || 0) % wallCount) : 0;
      this.clearVideo(bus, 0);
      this.drawWallPreview(bus, wallIndex, 48, 24, 1);
      this.hostDrawString(bus, `WALL ${wallIndex}`, 8, 8, 0x00FFFFFF);
      this.uiState.wallIndex = (wallIndex + 1) | 0;
      return 0;
    }
    const gpu = this.getVideoDevice(bus);
    if (!gpu) return 0;
    const screenW = gpu.width | 0;
    const screenH = gpu.height | 0;
    const posX = this.readGuestNumber(bus, 'viewx', 0) / 65536;
    const posY = this.readGuestNumber(bus, 'viewy', 0) / 65536;
    const angleDeg = this.readGuestNumber(bus, 'viewangle', 0) % 360;
    const angle = (angleDeg * Math.PI) / 180;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const planeX = -dirY * 0.66;
    const planeY = dirX * 0.66;
    const ceiling = this.colorFromIndex(29);
    const floor = this.colorFromIndex(24);
    for (let y = 0; y < (screenH >> 1); y++) this.drawHLine(bus, 0, y, screenW, ceiling);
    for (let y = (screenH >> 1); y < screenH; y++) this.drawHLine(bus, 0, y, screenW, floor);
    const plane = map.planes[0];
    for (let x = 0; x < screenW; x++) {
      const cameraX = (2 * x) / screenW - 1;
      const rayDirX = dirX + planeX * cameraX;
      const rayDirY = dirY + planeY * cameraX;
      let mapX = Math.max(0, Math.min(map.width - 1, Math.floor(posX)));
      let mapY = Math.max(0, Math.min(map.height - 1, Math.floor(posY)));
      const deltaDistX = rayDirX === 0 ? 1e30 : Math.abs(1 / rayDirX);
      const deltaDistY = rayDirY === 0 ? 1e30 : Math.abs(1 / rayDirY);
      let stepX = 0, stepY = 0, sideDistX = 0, sideDistY = 0;
      if (rayDirX < 0) {
        stepX = -1;
        sideDistX = (posX - mapX) * deltaDistX;
      } else {
        stepX = 1;
        sideDistX = (mapX + 1 - posX) * deltaDistX;
      }
      if (rayDirY < 0) {
        stepY = -1;
        sideDistY = (posY - mapY) * deltaDistY;
      } else {
        stepY = 1;
        sideDistY = (mapY + 1 - posY) * deltaDistY;
      }
      let side = 0;
      let tileValue = 1;
      let hit = false;
      for (let steps = 0; steps < 128 && !hit; steps++) {
        if (sideDistX < sideDistY) {
          sideDistX += deltaDistX;
          mapX += stepX;
          side = 0;
        } else {
          sideDistY += deltaDistY;
          mapY += stepY;
          side = 1;
        }
        if (mapX < 0 || mapY < 0 || mapX >= map.width || mapY >= map.height) {
          hit = true;
          tileValue = 1;
          break;
        }
        tileValue = plane[mapY * map.width + mapX] | 0;
        if (this.isWolfSolid(tileValue)) hit = true;
      }
      const perpDist = side === 0
        ? (((mapX - posX + (1 - stepX) / 2) / (rayDirX || 1e-9)) || 1e-9)
        : (((mapY - posY + (1 - stepY) / 2) / (rayDirY || 1e-9)) || 1e-9);
      const dist = Math.max(0.05, Math.abs(perpDist));
      const lineHeight = Math.max(1, Math.floor((screenH / dist) * 0.85));
      let drawStart = Math.floor(-lineHeight / 2 + screenH / 2);
      let drawEnd = Math.floor(lineHeight / 2 + screenH / 2);
      if (drawStart < 0) drawStart = 0;
      if (drawEnd >= screenH) drawEnd = screenH - 1;
      const wallX = side === 0 ? (posY + perpDist * rayDirY) : (posX + perpDist * rayDirX);
      let texX = Math.floor((wallX - Math.floor(wallX)) * 64);
      if (side === 0 && rayDirX > 0) texX = 63 - texX;
      if (side === 1 && rayDirY < 0) texX = 63 - texX;
      for (let y = drawStart; y <= drawEnd; y++) {
        const texY = Math.floor(((y - drawStart) / Math.max(1, drawEnd - drawStart + 1)) * 63);
        let color = this.sampleWallColumn(tileValue, texX, texY);
        if (side === 1) color = ((color & 0x00FEFEFE) >>> 1) & 0x007F7F7F;
        this.plotPixel(bus, x, y, color >>> 0);
      }
    }
    const mapName = String(map.name || `MAP ${map.index}`);
    this.hostDrawString(bus, mapName.slice(0, 18), 4, 4, 0x00FFFFFF);
    this.hostDrawString(bus, `${posX.toFixed(1)},${posY.toFixed(1)} a=${angleDeg | 0}`.slice(0, 24), 4, screenH - 10, 0x00FFFFFF);
    return 0;
  }


  blitIndexedPixels(bus, pixels, width, height, x, y, masked = false) {
    const w = Math.max(0, width | 0);
    const h = Math.max(0, height | 0);
    if (!pixels || !w || !h) return 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const value = pixels[yy * w + xx] | 0;
        if (masked && ((value & 0xFF) === 0 || (value & 0xFF) === 0xFF)) continue;
        this.plotPixel(bus, (x | 0) + xx, (y | 0) + yy, this.colorFromIndex(value));
      }
    }
    return 0;
  }

  cacheWolfScreen(bus, chunk) {
    const wolf = this.loadWolfData();
    const gfx = wolf && wolf.vga;
    if (!gfx || typeof gfx.decodeScreen !== 'function') return 0;
    const screen = gfx.decodeScreen(chunk | 0, 320, 200);
    if (!screen || !screen.pixels) return 0;
    this.clearVideo(bus, 0);
    this.blitIndexedPixels(bus, screen.pixels, screen.width, screen.height, 0, 0, false);
    this.uiState.lastScreenChunk = chunk | 0;
    return 0;
  }

  drawWolfPic(bus, x, y, chunk, masked = false, opts = {}) {
    const wolf = this.loadWolfData();
    const gfx = wolf && wolf.vga;
    const pic = gfx && typeof gfx.decodePic === 'function' ? gfx.decodePic(chunk | 0) : null;
    if (pic && pic.pixels) return this.blitIndexedPixels(bus, pic.pixels, pic.width, pic.height, x, y, masked);
    const fallbackWidth = opts.fallbackWidth != null ? opts.fallbackWidth : 16;
    const fallbackHeight = opts.fallbackHeight != null ? opts.fallbackHeight : 16;
    return this.drawWolfChunk(bus, x, y, chunk, fallbackWidth, fallbackHeight, masked);
  }

  writeCursorInfo(bus, ptr) {
    const base = ptr | 0;
    if (!base) return 0;
    const mouseX = bus.read(MMIO.MOUSE) | 0;
    const mouseY = bus.read(MMIO.MOUSE + 1) | 0;
    const keyLeft = this.hostPressedKeys.has('ArrowLeft') || this.keyState.has('a');
    const keyRight = this.hostPressedKeys.has('ArrowRight') || this.keyState.has('d');
    const keyUp = this.hostPressedKeys.has('ArrowUp') || this.hostPressedKeys.has('w');
    const keyDown = this.hostPressedKeys.has('ArrowDown') || this.hostPressedKeys.has('s');
    const x = keyLeft || keyRight ? ((keyRight ? 127 : 0) - (keyLeft ? 127 : 0)) : mouseX;
    const y = keyUp || keyDown ? ((keyDown ? 127 : 0) - (keyUp ? 127 : 0)) : mouseY;
    const buttons = this.mouseButtons(bus);
    const left = x < 0 ? -1 : x > 0 ? 1 : 0;
    const up = y < 0 ? -1 : y > 0 ? 1 : 0;
    const dir = left < 0 ? (up < 0 ? 7 : up > 0 ? 5 : 6) : left > 0 ? (up < 0 ? 1 : up > 0 ? 3 : 2) : (up < 0 ? 0 : up > 0 ? 4 : 8);
    const values = [buttons & 1 ? 1 : 0, buttons & 2 ? 1 : 0, buttons & 4 ? 1 : 0, buttons & 8 ? 1 : 0, x, y, left, up, dir];
    for (let i = 0; i < values.length; i++) bus.write(base + i, values[i] | 0);
    return 0;
  }


  cacheLatch(bus, source, width, height, dest) {
    const w = Math.max(0, width | 0);
    const h = Math.max(0, height | 0);
    const pixels = new Int32Array(w * h);
    for (let i = 0; i < pixels.length; i++) pixels[i] = bus.read((source | 0) + i) | 0;
    this.latchCache.set(dest | 0, { width: w, height: h, pixels });
    return 0;
  }

  blitBuffer(bus, source, width, height, x, y, masked = false) {
    const w = Math.max(0, width | 0);
    const h = Math.max(0, height | 0);
    const base = source | 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const value = bus.read(base + yy * w + xx) | 0;
        if (masked && ((value & 0xFF) === 0 || (value & 0xFF) === 0xFF)) continue;
        this.plotPixel(bus, (x | 0) + xx, (y | 0) + yy, this.colorFromIndex(value));
      }
    }
    return 0;
  }

  blitLatch(bus, source, width, height, x, y) {
    const cached = this.latchCache.get(source | 0);
    if (!cached) return this.drawPlaceholderSprite(bus, x, y, source, width, height, false);
    const w = Math.min(Math.max(0, width | 0), cached.width);
    const h = Math.min(Math.max(0, height | 0), cached.height);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const value = cached.pixels[yy * cached.width + xx] | 0;
        this.plotPixel(bus, (x | 0) + xx, (y | 0) + yy, this.colorFromIndex(value));
      }
    }
    return 0;
  }

  drawPlaceholderSprite(bus, x, y, id, width, height, masked = false) {
    const border = this.colorFromIndex((id | 0) + 1);
    const fill = masked ? (border & 0x007F7F7F) : border;
    this.drawRect(bus, x, y, width, height, fill);
    this.drawHLine(bus, x, y, width, 0x00FFFFFF);
    this.drawHLine(bus, x, (y | 0) + (height | 0) - 1, width, 0x00000000);
    this.drawVLine(bus, x, y, height, 0x00FFFFFF);
    this.drawVLine(bus, (x | 0) + (width | 0) - 1, y, height, 0x00000000);
    return 0;
  }

  drawWolfChunk(bus, x, y, chunk, width, height, masked = false) {
    const wolf = this.loadWolfData();
    const walls = (((wolf || {}).vswap || {}).walls) || [];
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    if (!walls.length) return this.drawPlaceholderSprite(bus, x, y, chunk, w, h, masked);
    const wall = walls[Math.abs(chunk | 0) % walls.length];
    for (let yy = 0; yy < h; yy++) {
      const sy = Math.min(63, ((yy * 64) / h) | 0);
      for (let xx = 0; xx < w; xx++) {
        const sx = Math.min(63, ((xx * 64) / w) | 0);
        const value = wall.data[sy * 64 + sx] | 0;
        if (masked && ((value & 0xFF) === 0 || (value & 0xFF) === 0xFF)) continue;
        this.plotPixel(bus, (x | 0) + xx, (y | 0) + yy, this.colorFromIndex(value));
      }
    }
    return 0;
  }

  drawPicFromMemory(bus, x, y, pic, width, height, transparent = -1) {
    const w = Math.max(0, width | 0);
    const h = Math.max(0, height | 0);
    const base = pic | 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const value = bus.read(base + yy * w + xx) | 0;
        if ((transparent | 0) >= 0 && value === (transparent | 0)) continue;
        this.plotPixel(bus, (x | 0) + xx, (y | 0) + yy, this.colorFromIndex(value));
      }
    }
    return 0;
  }


  ensureWolfMapHeaders(bus) {
    if (this.mapHeaderCache && this.mapHeaderCache.ready) return this.mapHeaderCache;
    const wolf = this.loadWolfData();
    const mapHeaderSeg = this.readGuestGlobal('mapheaderseg');
    if (!wolf || !wolf.maps || !wolf.maps.length || !mapHeaderSeg) return null;
    const headerSize = 24;
    this.mapHeaderCache = { ready: true, headers: new Map() };
    for (const map of wolf.maps) {
      const headerPtr = this.alloc(headerSize);
      if (!headerPtr) break;
      for (let i = 0; i < 3; i++) bus.write(headerPtr + i, 0);
      for (let i = 0; i < 3; i++) bus.write(headerPtr + 3 + i, (((map.planes[i] || []).length || 0) * 2) | 0);
      bus.write(headerPtr + 6, map.width | 0);
      bus.write(headerPtr + 7, map.height | 0);
      this.writeCString(bus, headerPtr + 8, String(map.name || `MAP${map.index}`));
      bus.write(mapHeaderSeg + (map.index | 0), headerPtr | 0);
      this.mapHeaderCache.headers.set(map.index | 0, headerPtr | 0);
    }
    return this.mapHeaderCache;
  }

  cacheWolfMap(bus, mapnum) {
    const wolf = this.loadWolfData();
    if (!wolf || !wolf.maps || !wolf.maps.length) return 0;
    this.ensureWolfMapHeaders(bus);
    const selected = wolf.maps.find((entry) => (entry.index | 0) === (mapnum | 0)) || wolf.maps[Math.max(0, Math.min(wolf.maps.length - 1, mapnum | 0))];
    if (!selected) return 0;
    const mapSegs = this.readGuestGlobal('mapsegs');
    if (!mapSegs) return 0;
    if (!this.mapPlaneCache) this.mapPlaneCache = new Map();
    const planes = [];
    for (let planeIndex = 0; planeIndex < 2; planeIndex++) {
      const key = `${selected.index}:${planeIndex}`;
      let planePtr = this.mapPlaneCache.get(key) || 0;
      const plane = selected.planes[planeIndex] || new Uint16Array(selected.width * selected.height);
      if (!planePtr) {
        planePtr = this.alloc(plane.length || 1);
        if (!planePtr) return 0;
        for (let i = 0; i < plane.length; i++) bus.write((planePtr | 0) + i, plane[i] | 0);
        this.mapPlaneCache.set(key, planePtr | 0);
      }
      planes.push(planePtr | 0);
      bus.write((mapSegs | 0) + planeIndex, planePtr | 0);
    }
    const mapOn = this.readGuestGlobal('mapon');
    if (mapOn) bus.write(mapOn, selected.index | 0);
    return 0;
  }

  loadWolfData() {
    if (this.wolfData !== undefined) return this.wolfData;
    try {
      const mapHead = this.resolveHostPath('MAPHEAD.WL6');
      const gameMaps = this.resolveHostPath('GAMEMAPS.WL6');
      const vSwap = this.resolveHostPath('VSWAP.WL6');
      const vgaDict = this.resolveHostPath('VGADICT.WL6');
      const vgaHead = this.resolveHostPath('VGAHEAD.WL6');
      const vgaGraph = this.resolveHostPath('VGAGRAPH.WL6');
      if (!fs.existsSync(mapHead) || !fs.existsSync(gameMaps) || !fs.existsSync(vSwap)) {
        this.wolfData = null;
        return this.wolfData;
      }
      const maps = parseMaps({ mapHead, gameMaps });
      const vswap = parseVSwap({ vSwap });
      const palette = this.loadGamePalette();
      const vga = (fs.existsSync(vgaDict) && fs.existsSync(vgaHead) && fs.existsSync(vgaGraph))
        ? parseVgaGraph({ vgaDict, vgaHead, vgaGraph })
        : null;
      this.wolfData = { maps: maps.maps, rlewTag: maps.rlewTag, vswap, palette, vga };
    } catch (error) {
      this.wolfData = { error: String(error), maps: [], vswap: { walls: [] } };
    }
    return this.wolfData;
  }

  drawMapPreview(bus, mapIndex = 0, planeIndex = 0, x = 0, y = 0, scale = 2, opts = {}) {
    const wolf = this.loadWolfData();
    if (!wolf || !wolf.maps || !wolf.maps.length) {
      this.hostDrawString(bus, 'No WL6 map data', x | 0, y | 0, 0x00FFFFFF);
      return 0;
    }
    const map = wolf.maps[Math.max(0, Math.min(wolf.maps.length - 1, mapIndex | 0))];
    const plane = map.planes[Math.max(0, Math.min(2, planeIndex | 0))];
    const rowStart = Math.max(0, opts.startRow | 0);
    const rowCount = opts.rows != null ? Math.max(1, opts.rows | 0) : map.height;
    const rowEnd = Math.min(map.height, rowStart + rowCount);
    const step = Math.max(1, scale | 0);
    for (let yy = rowStart; yy < rowEnd; yy++) {
      for (let xx = 0; xx < map.width; xx++) {
        const tile = plane[yy * map.width + xx] | 0;
        const color = tile ? this.colorFromIndex(tile) : 0x00000000;
        for (let sy = 0; sy < step; sy++) {
          for (let sx = 0; sx < step; sx++) {
            this.plotPixel(bus, (x | 0) + xx * step + sx, (y | 0) + (yy - rowStart) * step + sy, color);
          }
        }
      }
    }
    return 0;
  }

  drawWallPreview(bus, wallIndex = 0, x = 0, y = 0, scale = 1) {
    const wolf = this.loadWolfData();
    if (!wolf || !wolf.vswap || !wolf.vswap.walls || !wolf.vswap.walls.length) return 0;
    const wall = wolf.vswap.walls[Math.max(0, Math.min(wolf.vswap.walls.length - 1, wallIndex | 0))];
    const step = Math.max(1, scale | 0);
    for (let yy = 0; yy < 64; yy++) {
      for (let xx = 0; xx < 64; xx++) {
        const value = wall.data[yy * 64 + xx] | 0;
        for (let sy = 0; sy < step; sy++) {
          for (let sx = 0; sx < step; sx++) {
            this.plotPixel(bus, (x | 0) + xx * step + sx, (y | 0) + yy * step + sy, this.colorFromIndex(value));
          }
        }
      }
    }
    return 0;
  }

}

const FONT5X7 = {
  ' ': [0,0,0,0,0,0,0],
  '!': [0b00100,0b00100,0b00100,0b00100,0b00100,0,0b00100],
  '-': [0,0,0,0b11111,0,0,0],
  '.': [0,0,0,0,0,0b01100,0b01100],
  '/': [0b00001,0b00010,0b00100,0b01000,0b10000,0,0],
  ':': [0,0b01100,0b01100,0,0b01100,0b01100,0],
  '?': [0b11110,0b00001,0b00010,0b00100,0,0,0b00100],
  '0': [0b01110,0b10001,0b10011,0b10101,0b11001,0b10001,0b01110],
  '1': [0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b01110],
  '2': [0b01110,0b10001,0b00001,0b00010,0b00100,0b01000,0b11111],
  '3': [0b11110,0b00001,0b00001,0b01110,0b00001,0b00001,0b11110],
  '4': [0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
  '5': [0b11111,0b10000,0b10000,0b11110,0b00001,0b00001,0b11110],
  '6': [0b01110,0b10000,0b10000,0b11110,0b10001,0b10001,0b01110],
  '7': [0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
  '8': [0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
  '9': [0b01110,0b10001,0b10001,0b01111,0b00001,0b00001,0b01110],
  'A': [0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'B': [0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
  'C': [0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
  'D': [0b11110,0b10001,0b10001,0b10001,0b10001,0b10001,0b11110],
  'E': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
  'F': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
  'G': [0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01110],
  'H': [0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'I': [0b01110,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
  'J': [0b00001,0b00001,0b00001,0b00001,0b10001,0b10001,0b01110],
  'K': [0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
  'L': [0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
  'M': [0b10001,0b11011,0b10101,0b10101,0b10001,0b10001,0b10001],
  'N': [0b10001,0b11001,0b10101,0b10011,0b10001,0b10001,0b10001],
  'O': [0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'P': [0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
  'Q': [0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
  'R': [0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
  'S': [0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110],
  'T': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
  'U': [0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'V': [0b10001,0b10001,0b10001,0b10001,0b10001,0b01010,0b00100],
  'W': [0b10001,0b10001,0b10001,0b10101,0b10101,0b10101,0b01010],
  'X': [0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
  'Y': [0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
  'Z': [0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
};
for (const ch of 'abcdefghijklmnopqrstuvwxyz') FONT5X7[ch] = FONT5X7[ch.toUpperCase()];

module.exports = TNAHostRuntime;
