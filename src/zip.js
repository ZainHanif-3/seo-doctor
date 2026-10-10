'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function zipDirectory(srcDir, outPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve({ path: outPath, bytes: archive.pointer() });
    });
    archive.on('error', fail);
    archive.on('warning', (err) => { if (err && err.code === 'ENOENT') return; fail(err); });
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize().catch(fail);
  });
}

module.exports = { zipDirectory };
