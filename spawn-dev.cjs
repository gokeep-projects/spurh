const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const out = fs.openSync('dev-out.log', 'a');
const err = fs.openSync('dev-err.log', 'a');
const child = spawn('node', ['node_modules/vite/bin/vite.js'], {
  cwd: 'D:/work/spurh',
  detached: true,
  stdio: ['ignore', out, err],
  windowsHide: true
});
child.unref();
console.log('spawned vite pid', child.pid);
