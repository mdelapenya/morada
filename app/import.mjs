import { fileURLToPath } from 'node:url';
import { openDatabase, importExports } from './database.mjs';
process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--period-id' || !args[1]))
  throw new Error('Uso: npm run db:build -- [--period-id ID]');
const db = openDatabase(process.env.IDEALISTA_DB || `${root}.local/idealista.sqlite`);
try {
  if (args[1] && !db.prepare('SELECT 1 FROM search_periods WHERE id=?').get(args[1]))
    throw new Error('Periodo de destino no encontrado');
  console.log(JSON.stringify(importExports(db, `${root}.local/exports`,{periodId:args[1]})));
}
finally { db.close(); }
