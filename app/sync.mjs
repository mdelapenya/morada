import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { importConversation, validIsoDate, getProperty, getOpenPeriod,
  assertOpenPeriod, periodActivityStartsAt, matchesConversationProperty, recordSyncAttention,
  recordSuccessfulSync, hasSourceBaseline, recordSourceBaseline } from './database.mjs';
import { countNewIncomingMessages } from './sync-attention.mjs';
import { fingerprintMessageHistory } from '../scripts/message-history.mjs';

const defaultWorker = fileURLToPath(new URL('../scripts/sync-worker.mjs', import.meta.url));
const defaultExports = fileURLToPath(new URL('../.local/exports/', import.meta.url));
const phases = new Set(['connecting', 'refreshing', 'discovering', 'exporting']);
const unchangedThreshold = 5;
const failure = (code, message) => Object.assign(new Error(message), { code });
const emptyJob = () => ({ id: null, state: 'idle', phase: null, propertyId: null, sinceDate: null,
  periodId:null, idealistaPropertyId: null, untilDate: null, startedAt: null, endedAt: null,
  discovered: 0, candidates: 0, exported: 0,
  imported: 0, updated: 0, newIncomingApplicants: 0, newIncomingMessages: 0,
  requestedMode:null,effectiveMode:null,examined:0,earlyStopped:false,stopReason:null,
  unchangedStreak:0,unchangedThreshold,fullCoverage:false,headRechecked:false,
  error: null, errorCode: null });

export function madridToday() {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateExport(data, id) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || String(data.id) !== id ||
    !data.id || typeof data.name !== 'string' || !data.name.trim() ||
    typeof data.exportedAt !== 'string' || !Number.isFinite(Date.parse(data.exportedAt)) ||
    !data.integrity || typeof data.integrity.profile !== 'string' ||
    typeof data.integrity.history !== 'string' || !Array.isArray(data.messages) ||
    (data.profile != null && (!Array.isArray(data.profile.fields) ||
      data.profile.fields.some(field => typeof field !== 'string'))) ||
    data.messages.some(m => !m || !Number.isSafeInteger(m.sequence) || m.sequence < 1 ||
      typeof m.rawText !== 'string')) {
    throw failure('INVALID_EXPORT', `El archivo del chat ${id} no es válido. Vuelve a sincronizar.`);
  }
}

function verifyRefresh(db, file, periodId, sourceIdealistaId) {
  const stored = db.prepare(`SELECT history_status,id FROM conversations
    WHERE period_id=? AND source_idealista_id=? AND external_chat_id=?`)
    .get(periodId,sourceIdealistaId,file.id);
  if (!stored) return false;
  const previousCount = db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(stored.id).n;
  const notes = Array.isArray(file.data.integrity.notes) ? file.data.integrity.notes : [];
  const uncertain = notes.some(note => typeof note === 'string' &&
    /virtualiz|contenido cambió|controles en el historial|estabiliz|historial.*carg/i.test(note));
  const attachmentOnlyPartial = file.data.integrity.history === 'parcial' &&
    notes.some(note => typeof note === 'string' && /adjuntos detectados/i.test(note));
  if ((file.data.periodMessages ?? file.data.messages).length < previousCount || uncertain ||
    (file.data.integrity.history !== 'completo' && !attachmentOnlyPartial)) {
    throw failure('INCOMPLETE_HISTORY',
      `El historial del chat ${file.id} parece incompleto. Se conservaron los datos anteriores; revisa Chrome y reintenta.`);
  }
  return true;
}

async function loadResult(db, result, exportsRoot, sinceDate, untilDate, idealistaPropertyId, periodId,
  activityStartsAt,requestedMode,effectiveMode,canEarlyStop,baselineById) {
  if (!result || result.type !== 'result' || !validIsoDate(result.date) || result.date < untilDate ||
    (result.sinceDate !== undefined && result.sinceDate !== sinceDate) ||
    (result.untilDate !== undefined && result.untilDate !== untilDate) ||
    result.propertyId !== idealistaPropertyId ||
    (result.periodId !== undefined && result.periodId !== periodId) ||
    (result.periodId === undefined && !periodId.startsWith('initial:')) ||
    (result.activityStartsAt !== undefined && result.activityStartsAt !== activityStartsAt) ||
    !Array.isArray(result.files) || result.files.length > 10000 ||
    ![result.discovered, result.candidates, result.exported].every(validCount) ||
    result.exported !== result.files.length) {
    throw failure('INVALID_RESULT', 'La extracción terminó con un resultado no válido. Vuelve a sincronizar.');
  }
  const hasScanMetadata=['requestedMode','effectiveMode','examined','earlyStopped','stopReason',
    'unchangedStreak','unchangedThreshold','fullCoverage','headRechecked']
    .some(key=>result[key]!==undefined);
  let scan;
  if(!hasScanMetadata){
    if(canEarlyStop) throw failure('INVALID_RESULT','La extracción no confirmó el resultado incremental. Vuelve a sincronizar.');
    scan={requestedMode,effectiveMode:'full',examined:result.candidates,
      earlyStopped:false,stopReason:null,unchangedStreak:0,unchangedThreshold,
      fullCoverage:false,headRechecked:false,verifiedCoverage:false};
  }else{
    const fallbackToFull=canEarlyStop && requestedMode==='incremental' &&
      effectiveMode==='incremental' && result.effectiveMode==='full' &&
      result.fullCoverage===true && result.headRechecked===true &&
      result.earlyStopped===false;
    if(result.requestedMode!==requestedMode ||
      (result.effectiveMode!==effectiveMode && !fallbackToFull) ||
      !validCount(result.examined) || result.examined>20000 ||
      result.exported>result.examined || typeof result.earlyStopped!=='boolean' ||
      typeof result.fullCoverage!=='boolean' || typeof result.headRechecked!=='boolean' ||
      !validCount(result.unchangedStreak) || result.unchangedStreak>unchangedThreshold ||
      result.unchangedThreshold!==unchangedThreshold ||
      (result.earlyStopped ? (!canEarlyStop || effectiveMode!=='incremental' ||
        result.stopReason!=='unchanged_streak' || result.unchangedStreak!==unchangedThreshold ||
        result.fullCoverage || !result.headRechecked) :
        (result.stopReason!==null || !result.fullCoverage)))
      throw failure('INVALID_RESULT','La extracción no confirmó el alcance de la sincronización. Vuelve a sincronizar.');
    scan={requestedMode,effectiveMode:result.effectiveMode,examined:result.examined,
      earlyStopped:result.earlyStopped,stopReason:result.stopReason,
      unchangedStreak:result.unchangedStreak,unchangedThreshold,
      fullCoverage:result.fullCoverage,headRechecked:result.headRechecked,
      verifiedCoverage:result.fullCoverage};
  }
  const dateDir = path.resolve(exportsRoot, result.date, `property-${idealistaPropertyId}`,
    ...(result.periodId ? [`period-${encodeURIComponent(periodId)}`] : []));
  let actualDateDir;
  try { actualDateDir = result.files.length ? await realpath(dateDir) : null; }
  catch { throw failure('INVALID_RESULT', 'No se encontró la carpeta de los chats exportados. Vuelve a sincronizar.'); }
  const files = [];
  const seen = new Set();
  for (const source of result.files) {
    if (typeof source !== 'string' || !path.isAbsolute(source))
      throw failure('INVALID_RESULT', 'La extracción devolvió una ruta no válida. Vuelve a sincronizar.');
    const resolved = path.resolve(source);
    const match = path.basename(resolved).match(/^(\d+)\.json$/);
    let actualSource;
    try { actualSource = await realpath(resolved); }
    catch { throw failure('INVALID_RESULT', 'No se encontró un archivo exportado. Vuelve a sincronizar.'); }
    if (path.dirname(resolved) !== dateDir || !match || seen.has(match[1]) ||
      path.dirname(actualSource) !== actualDateDir) {
      throw failure('INVALID_RESULT', 'La extracción devolvió un archivo no válido. Vuelve a sincronizar.');
    }
    seen.add(match[1]);
    if ((await stat(resolved)).size > 25 * 1024 * 1024)
      throw failure('INVALID_EXPORT', `El archivo del chat ${match[1]} es demasiado grande.`);
    let data;
    try { data = JSON.parse(await readFile(resolved, 'utf8')); }
    catch { throw failure('INVALID_EXPORT', `No se pudo leer el archivo del chat ${match[1]}. Vuelve a sincronizar.`); }
    validateExport(data, match[1]);
    if (data.periodId !== undefined && data.periodId !== periodId)
      throw failure('INVALID_EXPORT', `El chat ${match[1]} pertenece a otro periodo.`);
    if (data.periodId && (data.propertyId!==idealistaPropertyId || data.sinceDate!==sinceDate ||
      data.untilDate!==untilDate || data.activityStartsAt!==activityStartsAt ||
      data.includeLegacyHistory!==(periodId.startsWith('initial:'))))
      throw failure('INVALID_EXPORT', `La ventana del chat ${match[1]} no corresponde al periodo.`);
    const activityDate = data.activityDate === undefined ? result.date : data.activityDate;
    if (!validIsoDate(activityDate) || activityDate < sinceDate || activityDate > untilDate)
      throw failure('INVALID_EXPORT', `La fecha de actividad del chat ${match[1]} no es válida. Vuelve a sincronizar.`);
    if (!matchesConversationProperty(db, data, idealistaPropertyId, periodId))
      throw failure('INVALID_EXPORT', `El chat ${match[1]} no corresponde al anuncio configurado. Vuelve a sincronizar.`);
    files.push({ source: resolved, id: match[1], data });
  }
  if(scan.earlyStopped){
    const trailing=files.slice(-unchangedThreshold);
    if(trailing.length!==unchangedThreshold || trailing.some(file=>{
      const before=baselineById[file.id];
      const after=fingerprintMessageHistory(file.data.periodMessages??file.data.messages);
      return !before || !after || before!==after;
    })) throw failure('INVALID_RESULT','La extracción parcial no confirmó cinco chats sin cambios. Vuelve a sincronizar.');
  }
  return { date: result.date, files,scan };
}

export function createSyncController(db, options = {}) {
  const exportsRoot = options.exportsRoot ?? defaultExports;
  const workerPath = options.workerPath ?? defaultWorker;
  const today = options.today ?? madridToday;
  const spawnWorker = options.spawnWorker ?? ((knownIds, sinceDate, untilDate, propertyId, context) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ knownIds, sinceDate, untilDate, propertyId,
      periodId:context.periodId,activityStartsAt:context.activityStartsAt,
      includeLegacyHistory:context.includeLegacyHistory,refreshExisting: true,
      scanMode:context.requestedMode,canEarlyStop:context.canEarlyStop,
      baselineById:context.baselineById,unchangedThreshold }) + '\n');
    return child;
  });
  let job = emptyJob();
  let child = null;
  let stopped = false;
  let serial = 0;
  const snapshot = () => ({ ...job });

  function start(propertyId, periodId = getOpenPeriod(db,propertyId)?.id, requestedMode='incremental') {
    if (job.state === 'running') return { accepted: false, job: snapshot() };
    if (stopped) throw failure('SERVER_STOPPING', 'El servidor se está cerrando.');
    if (!['incremental','full'].includes(requestedMode))
      throw failure('INVALID_MODE','Modo de sincronización no válido');
    const current = ++serial;
    const property = getProperty(db,propertyId);
    if (!property) throw failure('PROPERTY_NOT_FOUND','Vivienda no encontrada');
    const period = assertOpenPeriod(db,propertyId,periodId);
    if (!period.idealistaId) throw failure('NO_IDEALISTA_LINK','Añade el enlace de Idealista para sincronizar esta vivienda');
    const knownRows = db.prepare(`SELECT external_chat_id,raw_json,history_status FROM conversations
      WHERE period_id=? AND source_idealista_id=?`)
      .all(periodId,period.idealistaId);
    const knownIds=knownRows.map(row=>row.external_chat_id);
    const baselineById=Object.fromEntries(knownRows.map(row=>{
      let fingerprint=null;
      if(row.history_status==='completo'){
        try { fingerprint=fingerprintMessageHistory(JSON.parse(row.raw_json).messages); }
        catch { /* Incomplete old snapshots cannot establish an unchanged chat. */ }
      }
      return [row.external_chat_id,fingerprint];
    }));
    const sinceDate = period.rentalSince;
    const untilDate = today();
    if (!validIsoDate(sinceDate) || !validIsoDate(untilDate) || sinceDate > untilDate)
      throw failure('INVALID_DATE', 'La fecha de inicio del anuncio no es válida.');
    const activityStartsAt=periodActivityStartsAt(db,period);
    const includeLegacyHistory=periodId===`initial:${propertyId}`;
    const canEarlyStop=requestedMode==='incremental' && hasSourceBaseline(db,periodId,
      period.idealistaId,sinceDate,activityStartsAt,includeLegacyHistory);
    const effectiveMode=canEarlyStop?'incremental':'full';
    job = { ...emptyJob(), id: randomUUID(), state: 'running', phase: 'connecting',
      propertyId: property.id, periodId:period.id, idealistaPropertyId: period.idealistaId,
      sinceDate, untilDate, startedAt: new Date().toISOString(),requestedMode,effectiveMode };
    // Completion runs independently of the HTTP request and never blocks the server event loop.
    void run(current, knownIds, baselineById, canEarlyStop, requestedMode,effectiveMode,
      sinceDate, untilDate, property.id, period.id, period.idealistaId,activityStartsAt,includeLegacyHistory);
    return { accepted: true, job: snapshot() };
  }

  async function run(current, knownIds, baselineById, canEarlyStop, requestedMode,effectiveMode,
    sinceDate, untilDate, propertyId, periodId, idealistaPropertyId,activityStartsAt,includeLegacyHistory) {
    let result = null;
    let output = '';
    let stdoutBytes = 0;
    let protocolError = null;
    let workerError = null;
    let exitCode = null;
    let exitSignal = null;
    const active = () => current === serial && !stopped;
    const fail = error => {
      if (!active()) return;
      job = { ...job, state: 'failed', phase: null, endedAt: new Date().toISOString(),
        error: String(error.message || 'No se pudo sincronizar. Vuelve a intentarlo.').slice(0, 300),
        errorCode: typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'SYNC_FAILED' };
    };
    try {
      child = spawnWorker(knownIds, sinceDate, untilDate, idealistaPropertyId,
        {periodId,activityStartsAt,includeLegacyHistory,requestedMode,effectiveMode,
          canEarlyStop,baselineById,unchangedThreshold});
      const runningChild = child;
      if (!runningChild?.stdout || !runningChild?.stderr || typeof runningChild.on !== 'function')
        throw failure('WORKER_START', 'No se pudo iniciar la sincronización. Vuelve a intentarlo.');
      const finished = new Promise(resolve => {
        runningChild.on('error', error => { workerError = error; });
        runningChild.on('close', (code, signal) => { exitCode = code; exitSignal = signal; resolve(); });
      });
      runningChild.stdout.on('data', chunk => {
        if (protocolError) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > 2 * 1024 * 1024) {
          protocolError = failure('WORKER_OUTPUT', 'La extracción devolvió demasiados datos. Vuelve a sincronizar.');
          runningChild.kill();
          return;
        }
        output += chunk.toString('utf8');
        if (output.length > 64 * 1024) {
          protocolError = failure('WORKER_OUTPUT', 'La extracción devolvió un mensaje demasiado largo.');
          runningChild.kill();
          return;
        }
        let newline;
        while ((newline = output.indexOf('\n')) !== -1) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'progress' && phases.has(event.phase) &&
              ['discovered', 'candidates', 'exported','examined'].every(key =>
                event[key] === undefined || validCount(event[key]))) {
              if (active()) Object.assign(job, { phase: event.phase,
                ...Object.fromEntries(['discovered', 'candidates', 'exported','examined']
                  .filter(key => event[key] !== undefined).map(key => [key, event[key]])) });
            } else if (event.type === 'result' && !result) {
              result = event;
            } else if (event.type === 'error' && typeof event.message === 'string') {
              workerError = failure(typeof event.code === 'string' ? event.code : 'WORKER_FAILED', event.message);
            } else throw new Error('bad event');
          } catch {
            protocolError = failure('WORKER_OUTPUT', 'La extracción devolvió datos no válidos. Vuelve a sincronizar.');
            runningChild.kill();
            break;
          }
        }
      });
      runningChild.stderr.on('data', () => {});
      await finished;
      if (!active()) return;
      if (output.trim()) throw failure('WORKER_OUTPUT', 'La extracción devolvió datos incompletos. Vuelve a sincronizar.');
      if (protocolError) throw protocolError;
      if (workerError) throw workerError.code ? workerError : failure('WORKER_START', 'No se pudo iniciar la sincronización. Vuelve a intentarlo.');
      if (exitCode !== 0 || exitSignal) throw failure('WORKER_FAILED', 'No se pudo completar la lectura de Chrome. Vuelve a intentarlo.');
      if (!result) throw failure('INVALID_RESULT', 'La extracción terminó sin resultados. Vuelve a sincronizar.');
      job.phase = 'importing';
      const { date, files,scan } = await loadResult(db, result, exportsRoot, sinceDate, untilDate,
        idealistaPropertyId,periodId,activityStartsAt,requestedMode,effectiveMode,
        canEarlyStop,baselineById);
      if (!active()) return;
      db.exec('BEGIN');
      let imported = 0;
      let updated = 0;
      let newIncomingApplicants = 0;
      let newIncomingMessages = 0;
      const completedAt=new Date().toISOString();
      try {
        if (!getProperty(db,propertyId)) throw failure('PROPERTY_DELETED','La vivienda fue eliminada durante la sincronización');
        const frozen = assertOpenPeriod(db,propertyId,periodId);
        if (frozen.rentalSince!==sinceDate || frozen.idealistaId!==idealistaPropertyId ||
          periodActivityStartsAt(db,frozen)!==activityStartsAt)
          throw failure('PERIOD_CHANGED','El periodo cambió durante la sincronización');
        const exists = db.prepare(`SELECT applicant_id,raw_json FROM conversations
          WHERE period_id=? AND source_idealista_id=? AND external_chat_id=?`);
        const saved = db.prepare(`SELECT applicant_id FROM conversations
          WHERE period_id=? AND source_idealista_id=? AND external_chat_id=?`);
        for (const file of files) {
          const previous = exists.get(periodId,idealistaPropertyId,file.id);
          if (previous) verifyRefresh(db, file,periodId,idealistaPropertyId);
          const addedIncoming=previous ? countNewIncomingMessages(JSON.parse(previous.raw_json),file.data) : 0;
          if (importConversation(db, file.data, file.source, date, propertyId,periodId,untilDate)) {
            const applicantId=saved.get(periodId,idealistaPropertyId,file.id).applicant_id;
            if (previous) {
              updated++;
              if (addedIncoming) {
                newIncomingApplicants++;
                newIncomingMessages+=addedIncoming;
                recordSyncAttention(db,applicantId,periodId,'message',addedIncoming);
              }
            } else {
              imported++;
              recordSyncAttention(db,applicantId,periodId,'new');
            }
          }
        }
        recordSuccessfulSync(db,periodId,{id:job.id,completedAt,newCount:imported,
          incomingApplicantCount:newIncomingApplicants,incomingMessageCount:newIncomingMessages,
          refreshedCount:updated,...scan,candidates:result.candidates});
        if(scan.verifiedCoverage) recordSourceBaseline(db,periodId,idealistaPropertyId,
          sinceDate,activityStartsAt,includeLegacyHistory,completedAt,job.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error.code === 'INCOMPLETE_HISTORY' ? error :
          failure('IMPORT_FAILED', 'No se pudieron guardar los chats. Vuelve a sincronizar.');
      }
      job = { ...job, state: 'succeeded', phase: null, endedAt: completedAt,
        discovered: result.discovered, candidates: result.candidates, exported: result.exported,
        imported, updated, newIncomingApplicants, newIncomingMessages,
        requestedMode:scan.requestedMode,effectiveMode:scan.effectiveMode,
        examined:scan.examined,earlyStopped:scan.earlyStopped,stopReason:scan.stopReason,
        unchangedStreak:scan.unchangedStreak,unchangedThreshold:scan.unchangedThreshold,
        fullCoverage:scan.fullCoverage,headRechecked:scan.headRechecked };
    } catch (error) {
      fail(error);
    } finally {
      if (current === serial) child = null;
    }
  }

  function stop() {
    stopped = true;
    serial++;
    if (child) child.kill();
    child = null;
    if (job.state === 'running') job = { ...job, state: 'failed', phase: null,
      endedAt: new Date().toISOString(), error: 'El servidor se ha cerrado durante la sincronización.',
      errorCode: 'SERVER_STOPPING' };
  }

  return { start, snapshot, stop };
}
