const fs = require('fs');

const MAGIC = Buffer.from('TNA0');
const VERSION = 2;

function toInt32Array(data) {
  if (!data) return new Int32Array(0);
  if (data instanceof Int32Array) return data;
  if (Array.isArray(data)) return Int32Array.from(data);
  return new Int32Array(data);
}

function packExecutable(executable) {
  const abi = Buffer.from(String(executable.abi || 'tna-cdecl-v1'), 'utf8');
  const metaBuf = Buffer.from(JSON.stringify(executable.meta || { link: executable.link || null }), 'utf8');
  const text = toInt32Array(executable.text);
  const dataImage = toInt32Array(executable.dataImage);
  const header = Buffer.alloc(36);

  MAGIC.copy(header, 0);
  header.writeUInt32LE(VERSION, 4);
  header.writeInt32LE(executable.entry | 0, 8);
  header.writeInt32LE(executable.textBase | 0, 12);
  header.writeUInt32LE(text.length >>> 0, 16);
  header.writeInt32LE(executable.dataBase | 0, 20);
  header.writeUInt32LE(dataImage.length >>> 0, 24);
  header.writeUInt32LE(abi.length >>> 0, 28);
  header.writeUInt32LE(metaBuf.length >>> 0, 32);

  const body = Buffer.alloc((text.length + dataImage.length) * 4);
  for (let i = 0; i < text.length; i++) body.writeInt32LE(text[i] | 0, i * 4);
  const dataOffset = text.length * 4;
  for (let i = 0; i < dataImage.length; i++) body.writeInt32LE(dataImage[i] | 0, dataOffset + i * 4);

  return Buffer.concat([header, abi, metaBuf, body]);
}

function unpackExecutable(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 36) throw new Error('Exécutable TNA trop court');
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Magic TNA0 invalide');
  const version = buf.readUInt32LE(4);
  if (version !== 1 && version !== VERSION) throw new Error(`Version exécutable non supportée: ${version}`);

  const entry = buf.readInt32LE(8);
  const textBase = buf.readInt32LE(12);
  const textWords = buf.readUInt32LE(16);
  const dataBase = buf.readInt32LE(20);
  const dataWords = buf.readUInt32LE(24);
  const abiLength = buf.readUInt32LE(28);
  const metaLength = version >= 2 ? buf.readUInt32LE(32) : 0;
  const abiStart = 36;
  const abiEnd = abiStart + abiLength;
  const metaStart = abiEnd;
  const metaEnd = metaStart + metaLength;
  const bodyStart = metaEnd;
  const bodyExpected = bodyStart + (textWords + dataWords) * 4;
  if (buf.length < bodyExpected) throw new Error('Exécutable TNA tronqué');

  const abi = buf.subarray(abiStart, abiEnd).toString('utf8') || 'tna-cdecl-v1';
  let meta = {};
  if (metaLength) {
    try { meta = JSON.parse(buf.subarray(metaStart, metaEnd).toString('utf8')); }
    catch { meta = {}; }
  }
  const text = new Int32Array(textWords);
  const dataImage = new Int32Array(dataWords);
  for (let i = 0; i < textWords; i++) text[i] = buf.readInt32LE(bodyStart + i * 4);
  const dataOffset = bodyStart + textWords * 4;
  for (let i = 0; i < dataWords; i++) dataImage[i] = buf.readInt32LE(dataOffset + i * 4);

  return {
    kind: 'tna-executable',
    abi,
    entry,
    textBase,
    text,
    dataBase,
    dataImage,
    meta,
    link: meta.link || undefined,
    globals: meta.globals || undefined,
  };
}

function writeExecutableFile(filename, executable) {
  fs.writeFileSync(filename, packExecutable(executable));
}

function readExecutableFile(filename) {
  return unpackExecutable(fs.readFileSync(filename));
}

module.exports = {
  MAGIC: MAGIC.toString('utf8'),
  VERSION,
  packExecutable,
  unpackExecutable,
  writeExecutableFile,
  readExecutableFile,
};
