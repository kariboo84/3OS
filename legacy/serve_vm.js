const path = require('path');
process.chdir(path.resolve(__dirname));
const { createVMHttpServer } = require('./src/web/vm_http_server');

const port = Number(process.env.PORT || process.argv[2] || 8080);
const { server } = createVMHttpServer();
server.listen(port, () => {
  console.log(`VM web UI: http://127.0.0.1:${port}`);
});
