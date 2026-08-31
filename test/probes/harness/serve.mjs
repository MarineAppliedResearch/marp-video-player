/**
 * Static server for the S1/S2 decode harness.
 *
 * Rooted at the repo root, for two reasons: the browser needs to import
 * mp4box from node_modules, and lib/mp4-index.mjs then resolves through the
 * same relative path in the browser as it does under node -- so both probes
 * measure an index built by identical code.
 *
 * localhost is a secure context, which WebCodecs requires. Opening the HTML
 * over file:// is not a reliable substitute.
 *
 * Usage: npm run harness -- [port]
 *        then open http://localhost:8099/video-engine/test/probes/harness/
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2]) || 8099;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.mp4': 'video/mp4',
};

createServer((req, res) => {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path.endsWith('/')) path += 'index.html';
    const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    try {
        if (!statSync(full).isFile()) throw new Error('not a file');
    } catch {
        res.writeHead(404).end('not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream' });
    createReadStream(full).pipe(res);
}).listen(PORT, () => {
    console.log(`harness at http://localhost:${PORT}/test/probes/harness/`);
});
