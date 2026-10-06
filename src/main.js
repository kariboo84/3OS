const fs = require('fs');
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
const { ThreeOS } = require('../3OS');

function parseArgs(argv) {
  const options = {
    backend: process.env.TNA_BACKEND || 'interpreter',
    bootTarget: 'auto',
    key: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--backend' && argv[i + 1]) {
      options.backend = argv[++i];
    } else if (arg === '--bridge' && argv[i + 1]) {
      options.bridgeCommand = argv[++i];
    } else if (arg === '--boot' && argv[i + 1]) {
      options.bootTarget = argv[++i];
    } else if (arg === '--key' && argv[i + 1]) {
      options.key = argv[++i];
    } else if (!options.key) {
      options.key = arg;
    }
  }
  return options;
}

function runWolf3DFromArgs(os, args) {
  const named = new Set(['auto', 'bridge', 'linked', 'historical', 'official', 'ingame', 'screens', 'source', 'preview', 'raycaster', 'toy', 'c']);
  if (named.has(String(args.bootTarget || 'auto').toLowerCase())) {
    const suffix = `${args.bootTarget || 'auto'}${args.key ? ` ${args.key}` : ''}`.trim();
    return os.runCommand(`wolf3d ${suffix}`.trim());
  }
  const booted = os.runCommand(`boot ${args.bootTarget}`);
  const ran = os.runCommand(args.key ? `run ${args.key}` : 'run');
  return [booted, ran].filter(Boolean).join('\n');
}

const args = parseArgs(process.argv.slice(2));
console.log('=== 3OS + TNA VM + Wolf3D historical loader ===');
const os = new ThreeOS({
  memorySize: 1 << 22,
  videoWidth: 160,
  videoHeight: 120,
  backend: args.backend,
  bridgeCommand: args.bridgeCommand,
});
os.boot();
console.log(runWolf3DFromArgs(os, args));

fs.mkdirSync('frames', { recursive: true });
os.vm.saveFrame(path.join('frames', 'wolf3d_frame_000.ppm'));
console.log(`Backend: ${os.vm.backend.kind}`);
console.log(`Mode: ${os.mode}`);
console.log('Frame saved to frames/wolf3d_frame_000.ppm');
console.log('Registers:', os.snapshot().registers);
