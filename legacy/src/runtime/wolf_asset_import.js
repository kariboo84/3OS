const fs = require('fs');

function carmackExpand(buffer) {
  const expandedBytes = buffer.readUInt16LE(0);
  const words = [];
  let src = 2;
  while ((words.length * 2) < expandedBytes && src < buffer.length) {
    const count = buffer[src];
    const tag = buffer[src + 1];
    if (tag === 0xA7 || tag === 0xA8) {
      src += 2;
      if (count === 0) {
        const low = buffer[src++];
        words.push((tag << 8) | low);
        continue;
      }
      let copyStart;
      if (tag === 0xA7) {
        const back = buffer[src++];
        copyStart = words.length - back;
      } else {
        copyStart = buffer.readUInt16LE(src);
        src += 2;
      }
      for (let i = 0; i < count; i++) words.push(words[copyStart + i] | 0);
      continue;
    }
    words.push(buffer.readUInt16LE(src));
    src += 2;
  }
  const out = Buffer.alloc(words.length * 2);
  for (let i = 0; i < words.length; i++) out.writeUInt16LE(words[i] & 0xFFFF, i * 2);
  return out;
}

function rlewExpand(buffer, tag) {
  const expandedBytes = buffer.readUInt16LE(0);
  const words = [];
  let src = 2;
  while ((words.length * 2) < expandedBytes && src < buffer.length) {
    const word = buffer.readUInt16LE(src);
    src += 2;
    if (word === tag) {
      const count = buffer.readUInt16LE(src);
      const value = buffer.readUInt16LE(src + 2);
      src += 4;
      for (let i = 0; i < count; i++) words.push(value);
    } else {
      words.push(word);
    }
  }
  const out = Buffer.alloc(words.length * 2);
  for (let i = 0; i < words.length; i++) out.writeUInt16LE(words[i] & 0xFFFF, i * 2);
  return out;
}

function decodeMapPlane(compBuffer, width, height, rlewTag) {
  const expectedBytes = width * height * 2;
  let stage1 = compBuffer;
  const firstWord = compBuffer.readUInt16LE(0);
  if (firstWord !== expectedBytes) stage1 = carmackExpand(compBuffer);
  const stage2 = rlewExpand(stage1, rlewTag);
  const out = new Uint16Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = stage2.readUInt16LE(i * 2);
  return out;
}

function parseMaps(files) {
  const mapHead = fs.readFileSync(files.mapHead);
  const gameMaps = fs.readFileSync(files.gameMaps);
  const rlewTag = mapHead.readUInt16LE(0);
  const pointers = [];
  for (let i = 0; i < 100; i++) pointers.push(mapHead.readInt32LE(2 + i * 4));
  const maps = [];
  for (let mapIndex = 0; mapIndex < pointers.length; mapIndex++) {
    const ptr = pointers[mapIndex];
    if (ptr <= 0) continue;
    const off0 = gameMaps.readInt32LE(ptr + 0);
    const off1 = gameMaps.readInt32LE(ptr + 4);
    const off2 = gameMaps.readInt32LE(ptr + 8);
    const len0 = gameMaps.readUInt16LE(ptr + 12);
    const len1 = gameMaps.readUInt16LE(ptr + 14);
    const len2 = gameMaps.readUInt16LE(ptr + 16);
    const width = gameMaps.readUInt16LE(ptr + 18);
    const height = gameMaps.readUInt16LE(ptr + 20);
    const rawName = gameMaps.slice(ptr + 22, ptr + 38);
    const zeroAt = rawName.indexOf(0);
    const slice = zeroAt >= 0 ? rawName.slice(0, zeroAt) : rawName;
    const name = slice.toString('ascii').replace(/[^ -~]+/g, '').trim() || `MAP${String(mapIndex).padStart(2, '0')}`;
    const plane0 = decodeMapPlane(gameMaps.slice(off0, off0 + len0), width, height, rlewTag);
    const plane1 = decodeMapPlane(gameMaps.slice(off1, off1 + len1), width, height, rlewTag);
    const plane2 = len2 > 0 && off2 > 0 ? decodeMapPlane(gameMaps.slice(off2, off2 + len2), width, height, rlewTag) : new Uint16Array(width * height);
    maps.push({ index: mapIndex, name, width, height, planes: [plane0, plane1, plane2] });
  }
  return { rlewTag, maps };
}

function parseVSwap(files) {
  const buffer = fs.readFileSync(files.vSwap);
  const chunksInFile = buffer.readUInt16LE(0);
  const spriteStart = buffer.readUInt16LE(2);
  const soundStart = buffer.readUInt16LE(4);
  const offsets = [];
  const lengths = [];
  let off = 6;
  for (let i = 0; i < chunksInFile; i++) { offsets.push(buffer.readUInt32LE(off)); off += 4; }
  for (let i = 0; i < chunksInFile; i++) { lengths.push(buffer.readUInt16LE(off)); off += 2; }
  const walls = [];
  for (let i = 0; i < spriteStart; i++) {
    const start = offsets[i];
    const length = lengths[i];
    if (!start || !length) continue;
    const raw = buffer.slice(start, start + length);
    const rowMajor = Buffer.alloc(64 * 64);
    for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) rowMajor[y * 64 + x] = raw[x * 64 + y];
    walls.push({ index: i, data: rowMajor });
  }
  return {
    chunksInFile,
    spriteStart,
    soundStart,
    walls,
    wallCount: spriteStart,
    spriteCount: Math.max(0, soundStart - spriteStart),
    soundCount: Math.max(0, chunksInFile - soundStart),
  };
}

function parseVgaOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i + 2 < buffer.length; i += 3) {
    const value = buffer[i] | (buffer[i + 1] << 8) | (buffer[i + 2] << 16);
    offsets.push(value === 0xFFFFFF ? -1 : value);
  }
  return offsets;
}

function parseVgaDict(buffer) {
  const nodes = [];
  for (let i = 0; i < 255 && (i * 4 + 3) < buffer.length; i++) {
    nodes.push({
      bit0: buffer.readUInt16LE(i * 4),
      bit1: buffer.readUInt16LE(i * 4 + 2),
    });
  }
  return nodes;
}

function huffExpand(buffer, expandedLength, nodes) {
  const out = Buffer.alloc(Math.max(0, expandedLength | 0));
  let nodeIndex = 254;
  let src = 0;
  let mask = 1;
  let current = buffer.length ? buffer[0] : 0;
  for (let dst = 0; dst < out.length; dst++) {
    while (true) {
      const node = nodes[nodeIndex] || nodes[254];
      const code = (current & mask) ? node.bit1 : node.bit0;
      mask <<= 1;
      if (mask === 0x100) {
        mask = 1;
        src += 1;
        current = src < buffer.length ? buffer[src] : 0;
      }
      if (code < 256) {
        out[dst] = code & 0xFF;
        nodeIndex = 254;
        break;
      }
      nodeIndex = (code - 256) | 0;
      if (nodeIndex < 0 || nodeIndex >= nodes.length) {
        out[dst] = 0;
        nodeIndex = 254;
        break;
      }
    }
  }
  return out;
}

function planarToChunky(planar, width, height) {
  const planeWidth = width >> 2;
  const planeSize = planeWidth * height;
  const out = Buffer.alloc(width * height);
  for (let plane = 0; plane < 4; plane++) {
    const planeOff = plane * planeSize;
    for (let y = 0; y < height; y++) {
      for (let bx = 0; bx < planeWidth; bx++) {
        const value = planar[planeOff + y * planeWidth + bx] || 0;
        out[y * width + bx * 4 + plane] = value;
      }
    }
  }
  return out;
}

function parseVgaGraph(files) {
  const dictBuffer = fs.readFileSync(files.vgaDict);
  const headBuffer = fs.readFileSync(files.vgaHead);
  const graphBuffer = fs.readFileSync(files.vgaGraph);
  const nodes = parseVgaDict(dictBuffer);
  const offsets = parseVgaOffsets(headBuffer);
  const chunkCache = new Map();
  let pictable = null;

  const decodeChunk = (chunk) => {
    const index = chunk | 0;
    if (chunkCache.has(index)) return chunkCache.get(index);
    const start = offsets[index];
    if (!Number.isFinite(start) || start < 0 || start >= graphBuffer.length) {
      chunkCache.set(index, null);
      return null;
    }
    let next = index + 1;
    while (next < offsets.length && offsets[next] < 0) next += 1;
    const end = next < offsets.length && offsets[next] >= 0 ? offsets[next] : graphBuffer.length;
    const compressed = graphBuffer.slice(start, end);
    if (!compressed.length) {
      chunkCache.set(index, null);
      return null;
    }
    let expandedLength = 0;
    let payload = compressed;
    if (index === 0) {
      expandedLength = 132 * 4;
    } else if (index >= 3) {
      expandedLength = compressed.readUInt32LE(0);
      payload = compressed.slice(4);
    }
    const expanded = huffExpand(payload, expandedLength, nodes);
    const info = { index, expandedLength, expanded };
    chunkCache.set(index, info);
    return info;
  };

  const getPictable = () => {
    if (pictable) return pictable;
    const info = decodeChunk(0);
    const table = [];
    if (info && info.expanded && info.expanded.length >= 4) {
      for (let i = 0; i + 3 < info.expanded.length; i += 4) {
        table.push({ width: info.expanded.readUInt16LE(i), height: info.expanded.readUInt16LE(i + 2) });
      }
    }
    pictable = table;
    return pictable;
  };

  const decodePic = (chunk) => {
    const info = decodeChunk(chunk);
    const table = getPictable();
    const picIndex = (chunk | 0) - 3;
    const dims = table[picIndex];
    if (!info || !dims || !dims.width || !dims.height) return null;
    return {
      chunk: chunk | 0,
      width: dims.width | 0,
      height: dims.height | 0,
      pixels: planarToChunky(info.expanded, dims.width | 0, dims.height | 0),
    };
  };

  const decodeScreen = (chunk, width = 320, height = 200) => {
    const info = decodeChunk(chunk);
    if (!info || !info.expandedLength) return null;
    return {
      chunk: chunk | 0,
      width: width | 0,
      height: height | 0,
      pixels: planarToChunky(info.expanded, width | 0, height | 0),
    };
  };

  return { nodes, offsets, decodeChunk, getPictable, decodePic, decodeScreen };
}

module.exports = { parseMaps, parseVSwap, parseVgaGraph, planarToChunky, huffExpand, carmackExpand, rlewExpand };
