import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openDatabase, listApplicants, applicantDetail, updateApplicant, createManualApplicant,
  getProperty, listProperties, createProperty, updateProperty, DEFAULT_PROPERTY_ID } from './database.mjs';
import { getPeriod, getOpenPeriod, listPeriods, createPeriod, updatePeriod, closePeriod, reopenPeriod } from './database.mjs';
import { deleteProperty, restoreProperty, purgeProperty } from './database.mjs';
import { getLastSuccessfulSync, markSyncAttentionRead } from './database.mjs';
import { createSyncController, madridToday } from './sync.mjs';
import { createVisit, updateVisit, getVisit, listVisits, listApplicantVisits,
  getCalendarSettings, updateCalendarSettings } from './visits.mjs';
import { generateVisitCalendar } from './visit-calendar.mjs';

async function readJsonBody(req, allowedHosts, limit = 64 * 1024) {
  if (req.headers.origin && !allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin))
    throw Object.assign(new Error('Origen no permitido'), { status:403 });
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw Object.assign(new Error('Se requiere JSON'), { status:415 });
  let body = '', bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error('Petición demasiado grande'), { status:413 });
    body += chunk;
  }
  let value;
  try { value = JSON.parse(body); }
  catch { throw Object.assign(new Error('JSON no válido'), { status:400 }); }
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw Object.assign(new Error('Petición no válida'), { status:400 });
  return value;
}

function applicantSummary(db, propertyId, items, periodId = getOpenPeriod(db,propertyId)?.id) {
  const counts = db.prepare(`SELECT count(*) AS total,coalesce(sum(discarded=0),0) AS active,
    coalesce(sum(discarded=0 AND favorite=1),0) AS favorites,coalesce(sum(discarded=1),0) AS discarded
    FROM applicants WHERE property_id=? AND period_id=?`).get(propertyId,periodId);
  const dates = db.prepare('SELECT DISTINCT activity_date FROM interested WHERE property_id=? AND period_id=? ORDER BY activity_date DESC')
    .all(propertyId,periodId).map(row=>row.activity_date).filter(Boolean);
  return { items,counts,dates,lastSuccessfulSync:getLastSuccessfulSync(db,periodId),
    supportsReplyFilter:true,supportsPendingReplyFilter:true };
}

function syncMode(payload) {
  const keys=Object.keys(payload);
  if(keys.length===0) return 'incremental';
  if(keys.length===1 && keys[0]==='mode' && ['incremental','full'].includes(payload.mode))
    return payload.mode;
  return null;
}

export function createServer(db, options = {}) {
  const sync = createSyncController(db, options);
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type='application/json; charset=utf-8', extra={}) => {
      res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra,
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"});
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const host = req.headers.host;
      const allowedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
      if (!allowedHosts.includes(host)) return send(403,{error:'Acceso local requerido'});
      const url = new URL(req.url, `http://${host}`);
      const visitError=error=>send(error.status||400,{error:error.message,
        ...(error.code?{code:error.code}:{}),
        ...(error.conflicts?{conflicts:error.conflicts,conflictFingerprint:error.conflictFingerprint}:{})});
      const scopedVisits=url.pathname.match(/^\/api\/properties\/([^/]+)\/periods\/([^/]+)\/applicants\/([^/]+)\/visits$/);
      if(scopedVisits && ['GET','POST'].includes(req.method)) {
        const [propertyId,periodId,applicantId]=scopedVisits.slice(1).map(decodeURIComponent);
        try {
          if(req.method==='GET') return send(200,{visits:listApplicantVisits(db,propertyId,periodId,applicantId)});
          return send(201,createVisit(db,propertyId,periodId,applicantId,
            await readJsonBody(req,allowedHosts)));
        } catch(error) { return visitError(error); }
      }
      if(url.pathname==='/api/calendar/settings' && ['GET','PATCH'].includes(req.method)) {
        try { return send(200,req.method==='GET'?getCalendarSettings(db):
          updateCalendarSettings(db,await readJsonBody(req,allowedHosts,1024))); }
        catch(error) { return visitError(error); }
      }
      if(url.pathname==='/api/visits' && req.method==='GET') {
        try { return send(200,{visits:listVisits(db,url.searchParams)}); }
        catch(error) { return visitError(error); }
      }
      if(url.pathname==='/api/visits.ics' && req.method==='GET') {
        try { return send(200,generateVisitCalendar(listVisits(db,url.searchParams)),
          'text/calendar; charset=utf-8',{'Content-Disposition':'attachment; filename="visitas.ics"'}); }
        catch(error) { return visitError(error); }
      }
      const visitPath=url.pathname.match(/^\/api\/visits\/([^/]+?)(\.ics)?$/);
      if(visitPath && ['GET','PATCH'].includes(req.method)) {
        const visitId=decodeURIComponent(visitPath[1]);
        if(visitPath[2] && req.method!=='GET') return send(404,{error:'No encontrado'});
        try {
          const item=req.method==='PATCH'?updateVisit(db,visitId,await readJsonBody(req,allowedHosts)):getVisit(db,visitId);
          if(!item) return send(404,{error:'Visita no encontrada'});
          if(visitPath[2]) return send(200,generateVisitCalendar([item]),
            'text/calendar; charset=utf-8',{'Content-Disposition':'attachment; filename="visita.ics"'});
          return send(200,item);
        } catch(error) { return visitError(error); }
      }
      const periodPath = url.pathname.match(/^\/api\/properties\/([^/]+)\/periods(?:\/([^/]+))?(?:\/(applicants|sync))?(?:\/([^/]+))?$/);
      if (periodPath) {
        const propertyId = decodeURIComponent(periodPath[1]);
        const periodId = periodPath[2] && decodeURIComponent(periodPath[2]);
        const section = periodPath[3];
        const applicantId = periodPath[4] && decodeURIComponent(periodPath[4]);
        if (!getProperty(db,propertyId)) return send(404,{error:'Vivienda no encontrada'});
        if (!periodId && !section) {
          if (req.method==='GET') return send(200,{periods:listPeriods(db,propertyId)});
          if (req.method==='POST') {
            try { return send(201,{period:createPeriod(db,propertyId,await readJsonBody(req,allowedHosts),
              (options.today ?? madridToday)())}); }
            catch(error) { return send(['PERIOD_OPEN','DUPLICATE_PROPERTY'].includes(error.code)?409:error.status||400,{error:error.message}); }
          }
        }
        if (!periodId) return send(404,{error:'Periodo no encontrado'});
        const period = getPeriod(db,propertyId,periodId);
        if (!period) return send(404,{error:'Periodo no encontrado'});
        if (!section) {
          if (req.method==='GET') return send(200,{period});
          if (req.method==='PATCH') {
            if (period.status==='closed') return send(409,{error:'El periodo está cerrado'});
            if (sync.snapshot().state==='running' && sync.snapshot().periodId===periodId)
              return send(409,{error:'Espera a que termine la sincronización'});
            try { return send(200,{period:updatePeriod(db,propertyId,periodId,await readJsonBody(req,allowedHosts),
              (options.today ?? madridToday)())}); }
            catch(error) { return send(error.code==='PERIOD_CLOSED'?409:error.status||400,{error:error.message}); }
          }
        }
        if (section==='applicants' && ['GET','PATCH','POST'].includes(req.method)) {
          if (applicantId) {
            if (req.method==='GET') {
              const item=applicantDetail(db,applicantId,propertyId,periodId);
              return send(item?200:404,item||{error:'Interesado no encontrado'});
            }
            if (req.method==='PATCH') {
              if (period.status==='closed') return send(409,{error:'El periodo está cerrado'});
              try { const changes=await readJsonBody(req,allowedHosts);
                const updated=updateApplicant(db,applicantId,changes,propertyId,periodId);
                return send(updated?200:404,updated?{ok:true,...changes}:{error:'Interesado no encontrado'});
              } catch(error) { return send(error.status||400,{error:error.message}); }
            }
          } else if (req.method==='GET') {
            try { return send(200,applicantSummary(db,propertyId,
              listApplicants(db,url.searchParams,propertyId,periodId),periodId)); }
            catch(error) { return send(400,{error:error.message}); }
          } else if (req.method==='POST') {
            if (period.status==='closed') return send(409,{error:'El periodo está cerrado'});
            try { return send(201,{applicant:createManualApplicant(db,propertyId,
              await readJsonBody(req,allowedHosts),periodId)}); }
            catch(error) { return send(error.status||400,{error:error.message}); }
          }
        }
        if (section==='sync' && !applicantId && ['GET','POST'].includes(req.method)) {
          if (req.method==='GET') return send(200,{job:sync.snapshot(),supportsSyncModes:true,
            lastSuccessfulSync:getLastSuccessfulSync(db,periodId)});
          if (period.status==='closed') return send(409,{error:'El periodo está cerrado'});
          try { const payload=await readJsonBody(req,allowedHosts,1024);
            const mode=syncMode(payload);
            if (!mode) return send(400,{error:'Petición no válida'});
            if (!period.syncEnabled) return send(422,{error:'Añade el enlace de Idealista para sincronizar este periodo'});
            const started=sync.start(propertyId,periodId,mode);
            return send(started.accepted?202:409,started.accepted?{job:started.job}:
              {error:'Ya hay una sincronización en curso',job:started.job});
          } catch(error) { return send(error.status||400,{error:error.message}); }
        }
      }
      const attentionPath=url.pathname.match(/^\/api\/properties\/([^/]+)\/periods\/([^/]+)\/applicants\/([^/]+)\/attention\/read$/);
      if (attentionPath && req.method==='POST') {
        const propertyId=decodeURIComponent(attentionPath[1]);
        const periodId=decodeURIComponent(attentionPath[2]);
        const applicantId=decodeURIComponent(attentionPath[3]);
        if (!getProperty(db,propertyId)) return send(404,{error:'Vivienda no encontrada'});
        const period=getPeriod(db,propertyId,periodId);
        if (!period) return send(404,{error:'Periodo no encontrado'});
        if (period.status==='closed') return send(409,{error:'El periodo está cerrado'});
        try {
          const payload=await readJsonBody(req,allowedHosts,1024);
          if (Object.keys(payload).length!==1 || typeof payload.revision!=='string' ||
            !/^[a-f0-9-]{36}$/i.test(payload.revision))
            return send(400,{error:'Revisión no válida'});
          const result=markSyncAttentionRead(db,propertyId,periodId,applicantId,payload.revision);
          if (!result) return send(404,{error:'Interesado no encontrado'});
          if (!result.acknowledged) return send(409,{error:'Hay mensajes nuevos sin leer',
            syncAttention:result.syncAttention,newIncomingCount:result.newIncomingCount,
            attentionRevision:result.attentionRevision});
          return send(200,{syncAttention:result.syncAttention,
            newIncomingCount:result.newIncomingCount,attentionRevision:result.attentionRevision});
        } catch(error) { return send(error.status||400,{error:error.message}); }
      }
      const reopenPath=url.pathname.match(/^\/api\/properties\/([^/]+)\/periods\/([^/]+)\/reopen$/);
      if (reopenPath && req.method==='POST') {
        const propertyId=decodeURIComponent(reopenPath[1]),periodId=decodeURIComponent(reopenPath[2]);
        if (!getProperty(db,propertyId)) return send(404,{error:'Vivienda no encontrada'});
        if (!getPeriod(db,propertyId,periodId)) return send(404,{error:'Periodo no encontrado'});
        if (sync.snapshot().state==='running' && sync.snapshot().propertyId===propertyId)
          return send(409,{error:'Espera a que termine la sincronización'});
        try {
          const payload=await readJsonBody(req,allowedHosts,1024);
          if (Object.keys(payload).length) return send(400,{error:'Petición no válida'});
          return send(200,{period:reopenPeriod(db,propertyId,periodId)});
        } catch(error) { return send(error.status||409,{error:error.message,...(error.code?{code:error.code}:{})}); }
      }
      const closePath=url.pathname.match(/^\/api\/properties\/([^/]+)\/periods\/([^/]+)\/close$/);
      if (closePath && req.method==='POST') {
        const propertyId=decodeURIComponent(closePath[1]), periodId=decodeURIComponent(closePath[2]);
        const period=getPeriod(db,propertyId,periodId);
        if (!period) return send(404,{error:'Periodo no encontrado'});
        if (period.status==='closed') return send(409,{error:'El periodo está cerrado'});
        if (sync.snapshot().state==='running' && sync.snapshot().periodId===periodId)
          return send(409,{error:'Espera a que termine la sincronización'});
        try { const payload=await readJsonBody(req,allowedHosts,1024);
          if (Object.keys(payload).length!==1) return send(400,{error:'Petición no válida'});
          return send(200,{period:closePeriod(db,propertyId,periodId,payload.chosenApplicantId)});
        } catch(error) { return send(['PERIOD_CLOSED','UPCOMING_VISITS'].includes(error.code)?409:error.status||400,
          {error:error.message,...(error.code?{code:error.code}:{})}); }
      }
      if (url.pathname === '/api/properties') {
        if (req.method === 'GET') {
          try { return send(200,{properties:listProperties(db,url.searchParams.get('status')||'active'),
            supportsDeletedProperties:true}); }
          catch(error) { return send(400,{error:error.message}); }
        }
        if (req.method === 'POST') {
          try { return send(201,{property:createProperty(db,await readJsonBody(req,allowedHosts),
            (options.today ?? madridToday)())}); }
          catch (error) { return send(error.code === 'DUPLICATE_PROPERTY' ? 409 : error.status || 400,{error:error.message}); }
        }
      }
      const restorePath=url.pathname.match(/^\/api\/properties\/([^/]+)\/restore$/);
      if (restorePath && req.method==='POST') {
        const propertyId=decodeURIComponent(restorePath[1]);
        if (!getProperty(db,propertyId,true)) return send(404,{error:'Vivienda no encontrada'});
        try { const payload=await readJsonBody(req,allowedHosts,1024);
          if (Object.keys(payload).length) return send(400,{error:'Petición no válida'});
          return send(200,{property:restoreProperty(db,propertyId)});
        } catch(error) { return send(error.code==='DUPLICATE_PROPERTY'?409:error.status||400,
          {error:error.message}); }
      }
      const purgePath=url.pathname.match(/^\/api\/properties\/([^/]+)\/permanent$/);
      if (purgePath && req.method==='DELETE') {
        const propertyId=decodeURIComponent(purgePath[1]);
        if (!getProperty(db,propertyId,true)) return send(404,{error:'Vivienda no encontrada'});
        if (sync.snapshot().state==='running' && sync.snapshot().propertyId===propertyId)
          return send(409,{error:'Espera a que termine la sincronización'});
        try {
          const payload=await readJsonBody(req,allowedHosts,1024);
          if (Object.keys(payload).length!==1 || payload.confirmPropertyId!==propertyId)
            return send(400,{error:'Confirmación no válida'});
          return send(200,purgeProperty(db,propertyId));
        } catch(error) { return send(error.code==='PROPERTY_ACTIVE'?409:error.status||400,
          {error:error.message}); }
      }
      const scopedSync = url.pathname.match(/^\/api\/properties\/([^/]+)\/sync$/);
      if (scopedSync && ['GET','POST'].includes(req.method)) {
        const propertyId = decodeURIComponent(scopedSync[1]);
        const property = getProperty(db,propertyId);
        if (!property) return send(404,{error:'Vivienda no encontrada'});
        if (req.method === 'GET') return send(200,{job:sync.snapshot(),supportsSyncModes:true,
          lastSuccessfulSync:getLastSuccessfulSync(db,property.activePeriodId)});
        try {
          const payload = await readJsonBody(req,allowedHosts,1024);
          const mode=syncMode(payload);
          if (!mode) return send(400,{error:'Petición no válida'});
          if (!property.syncEnabled) return send(422,{error:'Añade el enlace de Idealista para sincronizar esta vivienda'});
          const started = sync.start(propertyId,undefined,mode);
          return send(started.accepted ? 202 : 409,
            started.accepted ? {job:started.job} : {error:'Ya hay una sincronización en curso',job:started.job});
        } catch (error) { return send(error.status || 400,{error:error.message}); }
      }
      const scopedApplicant = url.pathname.match(/^\/api\/properties\/([^/]+)\/applicants\/([^/]+)$/);
      if (scopedApplicant && ['GET','PATCH'].includes(req.method)) {
        const propertyId = decodeURIComponent(scopedApplicant[1]);
        const applicantId = decodeURIComponent(scopedApplicant[2]);
        if (!getProperty(db,propertyId)) return send(404,{error:'Vivienda no encontrada'});
        if (req.method === 'GET') {
          const item = applicantDetail(db,applicantId,propertyId);
          return send(item ? 200 : 404,item || {error:'Interesado no encontrado'});
        }
        try {
          const changes = await readJsonBody(req,allowedHosts);
          const updated = updateApplicant(db,applicantId,changes,propertyId);
          return send(updated ? 200 : 404,updated ? {ok:true,...changes} : {error:'Interesado no encontrado'});
        } catch (error) { return send(error.status || 400,{error:error.message}); }
      }
      const scopedApplicants = url.pathname.match(/^\/api\/properties\/([^/]+)\/applicants$/);
      if (scopedApplicants && ['GET','POST'].includes(req.method)) {
        const propertyId = decodeURIComponent(scopedApplicants[1]);
        if (!getProperty(db,propertyId)) return send(404,{error:'Vivienda no encontrada'});
        if (req.method === 'GET') {
          try { return send(200,applicantSummary(db,propertyId,listApplicants(db,url.searchParams,propertyId))); }
          catch (error) { return send(400,{error:error.message}); }
        }
        try { return send(201,{applicant:createManualApplicant(db,propertyId,await readJsonBody(req,allowedHosts))}); }
        catch (error) { return send(error.status || 400,{error:error.message}); }
      }
      const scopedProperty = url.pathname.match(/^\/api\/properties\/([^/]+)$/);
      if (scopedProperty && ['GET','PATCH','DELETE'].includes(req.method)) {
        const propertyId = decodeURIComponent(scopedProperty[1]);
        const property = getProperty(db,propertyId,req.method==='DELETE');
        if (!property) return send(404,{error:'Vivienda no encontrada'});
        if (req.method === 'GET') return send(200,{property});
        if (req.method==='DELETE') {
          if (req.headers.origin && !allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin))
            return send(403,{error:'Origen no permitido'});
          if (sync.snapshot().state==='running' && sync.snapshot().propertyId===propertyId)
            return send(409,{error:'Espera a que termine la sincronización'});
          return send(200,deleteProperty(db,propertyId));
        }
        try { const payload=await readJsonBody(req,allowedHosts);
          if (sync.snapshot().state==='running' && sync.snapshot().periodId===property.activePeriodId &&
            ['rentalSince','idealistaUrl','monthlyRentCents'].some(k=>Object.hasOwn(payload,k)))
            return send(409,{error:'Espera a que termine la sincronización'});
          return send(200,{property:updateProperty(db,propertyId,payload,
          (options.today ?? madridToday)())}); }
        catch (error) { return send(['DUPLICATE_PROPERTY','PROPERTY_BOUND','PERIOD_CLOSED','PERIOD_DATE'].includes(error.code) ? 409 :
          error.status || 400,{error:error.message}); }
      }
      if (url.pathname === '/api/sync' && req.method === 'GET') return send(200, { job: sync.snapshot(),
        supportsSyncModes:true });
      if (url.pathname === '/api/property' && req.method === 'GET') {
        const property=getProperty(db);
        return send(property?200:404,property?{property}:{error:'Vivienda no encontrada'});
      }
      if (url.pathname === '/api/property' && req.method === 'PATCH') {
        if (!getProperty(db)) return send(404,{error:'Vivienda no encontrada'});
        if (req.headers.origin && !allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin)) return send(403,{error:'Origen no permitido'});
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415,{error:'Se requiere JSON'});
        let body = '', bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024) return send(413,{error:'Petición demasiado grande'});
          body += chunk;
        }
        let payload;
        try { payload = JSON.parse(body); }
        catch { return send(400,{error:'Fecha de inicio no válida'}); }
        if (!payload || Array.isArray(payload) || typeof payload !== 'object' ||
          Object.keys(payload).length !== 1 || typeof payload.rentalSince !== 'string')
          return send(400,{error:'Fecha de inicio no válida'});
        if (sync.snapshot().state==='running' && sync.snapshot().periodId===getOpenPeriod(db,DEFAULT_PROPERTY_ID)?.id)
          return send(409,{error:'Espera a que termine la sincronización'});
        try { return send(200, { property: updateProperty(db, DEFAULT_PROPERTY_ID,
          {rentalSince:payload.rentalSince}, (options.today ?? madridToday)()) }); }
        catch { return send(400,{error:'Fecha de inicio no válida'}); }
      }
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        if (!getProperty(db)) return send(404,{error:'Vivienda no encontrada'});
        if (req.headers.origin && !allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin)) return send(403,{error:'Origen no permitido'});
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415,{error:'Se requiere JSON'});
        let body = '', bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024) return send(413,{error:'Petición demasiado grande'});
          body += chunk;
        }
        let payload;
        try { payload = JSON.parse(body); }
        catch { return send(400,{error:'Petición no válida'}); }
        if (!payload || Array.isArray(payload) || typeof payload !== 'object' || !syncMode(payload))
          return send(400,{error:'Petición no válida'});
        const started = sync.start(DEFAULT_PROPERTY_ID,undefined,syncMode(payload));
        return send(started.accepted ? 202 : 409,
          started.accepted ? {job:started.job} : {error:'Ya hay una sincronización en curso',job:started.job});
      }
      if (req.method === 'GET' && url.pathname === '/api/applicants') {
        if (!getProperty(db)) return send(404,{error:'Vivienda no encontrada'});
        let items;
        try { items = listApplicants(db, url.searchParams); } catch(error) { return send(400,{error:error.message}); }
        return send(200,applicantSummary(db,DEFAULT_PROPERTY_ID,items));
      }
      const match = url.pathname.match(/^\/api\/applicants\/(\d+)$/);
      if (match && req.method === 'GET') {
        if (!getProperty(db)) return send(404,{error:'Vivienda no encontrada'});
        const item = applicantDetail(db, match[1]);
        return send(item ? 200 : 404, item || {error:'Interesado no encontrado'});
      }
      if (match && req.method === 'PATCH') {
        if (!getProperty(db)) return send(404,{error:'Vivienda no encontrada'});
        if (req.headers.origin && !allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin)) return send(403,{error:'Origen no permitido'});
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415,{error:'Se requiere JSON'});
        let body = '', bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 64 * 1024) return send(413,{error:'Petición demasiado grande'});
          body += chunk;
        }
        let changes;
        try {
          changes = JSON.parse(body);
          if (!changes || Array.isArray(changes) || typeof changes !== 'object') throw new Error();
          const updated = updateApplicant(db, match[1], changes);
          return send(updated ? 200 : 404, updated ? {ok:true,...changes} : {error:'Interesado no encontrado'});
        } catch { return send(400,{error:'Cambios no válidos'}); }
      }
      const assets = {'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],
        '/message-date.mjs':['message-date.mjs','text/javascript; charset=utf-8'],
        '/visit-time.mjs':['visit-time.mjs','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],
        '/morada-mark.svg':['morada-mark.svg','image/svg+xml; charset=utf-8'],'/morada-logo.svg':['morada-logo.svg','image/svg+xml; charset=utf-8']};
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file,type] = assets[url.pathname];
        return send(200,await readFile(new URL(`./public/${file}`,import.meta.url)),type);
      }
      send(404,{error:'No encontrado'});
    } catch (error) { console.error(error.message); if (!res.headersSent) send(500,{error:'No se pudo completar la operación'}); }
  });
  server.on('close', () => sync.stop());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const database = process.env.IDEALISTA_DB || fileURLToPath(new URL('../.local/idealista.sqlite',import.meta.url));
  const db = openDatabase(database);
  const port = Number(process.env.PORT || 8765);
  const server = createServer(db);
  server.listen(port,'127.0.0.1',()=>console.log(`Idealista · http://127.0.0.1:${port}`));
  const close = () => server.close(()=>{db.close();process.exit(0)});
  process.on('SIGINT',close);process.on('SIGTERM',close);
}
