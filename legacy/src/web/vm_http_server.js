const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { VMWebController } = require('./vm_controller');

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function createVMHttpServer(options = {}) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const webRoot = options.webRoot || path.join(projectRoot, 'web');
  const controller = options.controller || new VMWebController();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(res, 200, controller.getState());
      }
      if (req.method === 'POST' && url.pathname === '/api/start') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, controller.startVM(body));
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        return sendJson(res, 200, controller.stopVM());
      }
      if (req.method === 'POST' && url.pathname === '/api/boot-3os') {
        return sendJson(res, 200, controller.boot3OS());
      }
      if (req.method === 'POST' && url.pathname === '/api/reset-3os') {
        return sendJson(res, 200, controller.reset3OS());
      }
      if (req.method === 'POST' && url.pathname === '/api/launch-wolf3d') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, controller.loadWolfTarget(body.target || 'auto', body.key || ''));
      }
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, controller.runCommand(body.command || ''));
      }
      if (req.method === 'POST' && url.pathname === '/api/key') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, controller.injectKey(body.key || '', body.down !== false));
      }
      if (req.method === 'POST' && url.pathname === '/api/mouse') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, controller.injectMouse(body.x | 0, body.y | 0, body.buttons | 0));
      }
      if (req.method === 'POST' && url.pathname === '/api/beep') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, controller.beep(body.freq || 523, body.dur || 180));
      }

      if (req.method === 'GET') {
        const safePath = url.pathname === '/' ? '/index.html' : url.pathname;
        const filePath = path.join(webRoot, safePath.replace(/^\/+/, ''));
        if (!filePath.startsWith(webRoot)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
          return fs.createReadStream(filePath).pipe(res);
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  return { server, controller };
}

module.exports = { createVMHttpServer };
