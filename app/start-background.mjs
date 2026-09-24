import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.resolve(process.env.IDEALISTA_RUNTIME_DIR || path.join(root, '.local'));
const port = Number(process.env.PORT || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Puerto no válido.');
const pidFile = path.join(runtime, 'server.pid');
const logFile = path.join(runtime, 'server.log');

function running(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function portOpen() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

mkdirSync(runtime, { recursive: true, mode: 0o700 });
if (existsSync(pidFile) && running(Number(readFileSync(pidFile, 'utf8').trim())))
  throw new Error(`El servidor ya está en ejecución (PID en ${pidFile}).`);
if (await portOpen()) throw new Error(`El puerto ${port} ya está ocupado. No se inició otro servidor.`);

const log = openSync(logFile, 'a', 0o600);
let child;
try {
  child = spawn(process.execPath, ['--experimental-sqlite', path.join(root, 'app/server.mjs')], {
    cwd: root, detached: true, stdio: ['ignore', log, log], env: { ...process.env, PORT: String(port) },
  });
} finally { closeSync(log); }
let exit = null;
let spawnError = null;
child.once('exit', (code, signal) => { exit = { code, signal }; });
child.once('error', error => { spawnError = error; });
child.unref();

let ready = false;
for (let attempt = 0; attempt < 50; attempt++) {
  if (spawnError || exit) break;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sync`, { signal: AbortSignal.timeout(1000) });
    if (response.ok && (await response.json()).job) { ready = true; break; }
  } catch { /* Child may still be starting. */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) throw new Error(`El servidor no pudo iniciarse. Revisa ${logFile}.`);
writeFileSync(`${pidFile}.tmp`, `${child.pid}\n`, { mode: 0o600 });
renameSync(`${pidFile}.tmp`, pidFile);
console.log(`Idealista · http://127.0.0.1:${port} · PID ${child.pid} · log ${logFile}`);
