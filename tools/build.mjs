import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const files = [
  'package.json',
  'package-lock.json',
  'README.md',
  'DEVELOPMENT.md',
  'app/arrival.mjs',
  'app/database.mjs',
  'app/import.mjs',
  'app/legacy-property.mjs',
  'app/reply.mjs',
  'app/server.mjs',
  'app/start-background.mjs',
  'app/sync-attention.mjs',
  'app/sync.mjs',
  'app/public/app.js',
  'app/public/index.html',
  'app/public/morada-logo.svg',
  'app/public/morada-mark.svg',
  'app/public/style.css',
  'scripts/browser.mjs',
  'scripts/current-chrome.mjs',
  'scripts/export-today.mjs',
  'scripts/exporter.mjs',
  'scripts/message-history.mjs',
  'scripts/probe-cookies.mjs',
  'scripts/sync-worker.mjs',
];

const temporary = await mkdtemp(path.join(root, '.dist-'));
try {
  const hashes = {};
  for (const file of files) {
    const source = path.join(root, file);
    if (!(await lstat(source)).isFile()) throw new Error(`Build source is not a regular file: ${file}`);
    const destination = path.join(temporary, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    hashes[file] = createHash('sha256').update(await readFile(destination)).digest('hex');
  }
  await writeFile(path.join(temporary, 'build-manifest.json'), `${JSON.stringify(hashes, null, 2)}\n`);
  await rm(output, { recursive: true, force: true });
  await rename(temporary, output);
  console.log(`Built ${files.length} public application files in dist/`);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
