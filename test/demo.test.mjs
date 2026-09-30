import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
test('demo allocates independent synthetic databases and cannot load runtime data or launch Chrome', async t => {
  const trap = await mkdtemp(path.join(os.tmpdir(), 'morada-demo-isolation-'));
  t.after(() => rm(trap, { recursive: true, force: true }));
  const sentinel = path.join(trap, 'do-not-open.sqlite');
  await writeFile(sentinel, 'NO LEER NI MODIFICAR');
  const module = new URL('../tools/demo-data.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {rm} from 'node:fs/promises';
    const originalRead=fs.readFileSync;
    fs.readFileSync=(source,...args)=>{
      assert.ok(!String(source).includes('/.local/'),'demo must not read the real local directory');
      assert.notEqual(String(source),process.env.IDEALISTA_DB,'demo must not read the runtime database');
      return originalRead(source,...args);
    };
    childProcess.spawn=()=>{throw new Error('No child process may run in the demo');};
    childProcess.execFileSync=()=>{throw new Error('No Chrome or Apple Events calls may run in the demo');};
    syncBuiltinESMExports();
    const {createDemo}=await import(${JSON.stringify(module)});
    const first=await createDemo(),second=await createDemo();
    try {
      assert.notEqual(first.filename,second.filename);
      assert.notEqual(first.url,second.url);
      for(const demo of [first,second]){
        assert.ok(demo.filename.includes('/.demo/session-'));
        assert.equal(demo.db.prepare('SELECT count(*) AS n FROM properties').get().n,5);
        assert.equal(demo.db.prepare('SELECT count(*) AS n FROM applicants').get().n,11);
        assert.equal(demo.db.prepare('SELECT count(*) AS n FROM visits').get().n,6);
        assert.equal(demo.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
        assert.deepEqual(demo.db.prepare('PRAGMA foreign_key_check').all(),[]);
        const response=await fetch(demo.url+'/api/properties/'+demo.homes.garden.id+'/sync',{
          method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        assert.equal(response.status,202);
        const state=await fetch(demo.url+'/api/sync').then(r=>r.json());
        assert.equal(state.job.state,'failed');
        assert.match(state.job.error,/desactivada/);
      }
      first.db.prepare('UPDATE applicants SET notes=?').run('Cambio solo en la primera demo');
      assert.equal(second.db.prepare('SELECT count(*) AS n FROM applicants WHERE notes=?').get('Cambio solo en la primera demo').n,0);
    } finally {
      await first.close();await second.close();
      await rm(first.directory,{recursive:true});await rm(second.directory,{recursive:true});
    }
  `;
  await execute(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], {
    env: { ...process.env, IDEALISTA_DB: sentinel, IDEALISTA_LEGACY_PROPERTY_FILE: sentinel,
      IDEALISTA_RUNTIME_DIR: trap, PORT: 'not-a-valid-port' }, timeout: 30000,
  });
  assert.equal(await readFile(sentinel, 'utf8'), 'NO LEER NI MODIFICAR');
});
