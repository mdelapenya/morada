import { exportToday } from './exporter.mjs';

const emit=event=>process.stdout.write(JSON.stringify(event)+'\n');
try{
  let input='';
  for await(const chunk of process.stdin){input+=chunk;if(input.length>1024*1024)throw new Error('La solicitud de sincronización es demasiado grande.');}
  const payload=JSON.parse(input);
  if(!Array.isArray(payload.knownIds)||!payload.knownIds.every(id=>typeof id==='string'&&/^\d+$/.test(id)))throw new Error('La lista de chats existentes no es válida.');
  if(payload.sinceDate!==undefined && (typeof payload.sinceDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(payload.sinceDate)))throw new Error('La fecha inicial de sincronización no es válida.');
  if(payload.untilDate!==undefined && (typeof payload.untilDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(payload.untilDate)))throw new Error('La fecha final de sincronización no es válida.');
  if(payload.refreshExisting!==undefined && typeof payload.refreshExisting!=='boolean')throw new Error('La opción de actualización no es válida.');
  if(payload.propertyId!==undefined && (typeof payload.propertyId!=='string'||!/^\d+$/.test(payload.propertyId)))throw new Error('La referencia del anuncio no es válida.');
  if(payload.periodId!==undefined && (typeof payload.periodId!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.periodId)||/^initial:[A-Za-z0-9_-]{1,100}$/.test(payload.periodId))))throw new Error('El identificador del periodo no es válido.');
  if(payload.activityStartsAt!==undefined && (typeof payload.activityStartsAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(payload.activityStartsAt)||!Number.isFinite(Date.parse(payload.activityStartsAt))))throw new Error('El inicio de actividad del periodo no es válido.');
  if(payload.includeLegacyHistory!==undefined && typeof payload.includeLegacyHistory!=='boolean')throw new Error('La opción de historial heredado no es válida.');
  if(payload.periodId!==undefined && (!payload.propertyId||!payload.sinceDate||!payload.untilDate||!payload.activityStartsAt||!payload.refreshExisting))throw new Error('Faltan datos del periodo de sincronización.');
  if(payload.periodId===undefined && (payload.activityStartsAt!==undefined||payload.includeLegacyHistory!==undefined))throw new Error('Faltan datos del periodo de sincronización.');
  if(payload.refreshExisting && (!payload.propertyId||!payload.sinceDate||!payload.untilDate))throw new Error('Falta la referencia del anuncio o el periodo de sincronización.');
  if(payload.scanMode!==undefined&&!['full','incremental'].includes(payload.scanMode))throw new Error('El modo de sincronización no es válido.');
  if(payload.canEarlyStop!==undefined&&typeof payload.canEarlyStop!=='boolean')throw new Error('La opción de parada anticipada no es válida.');
  if(payload.baselineById!==undefined&&(!payload.baselineById||typeof payload.baselineById!=='object'||Array.isArray(payload.baselineById)||!Object.entries(payload.baselineById).every(([id,hash])=>/^\d+$/.test(id)&&(hash===null||typeof hash==='string'&&/^[0-9a-f]{64}$/.test(hash)))))throw new Error('La referencia de mensajes existentes no es válida.');
  if(payload.unchangedThreshold!==undefined&&payload.unchangedThreshold!==5)throw new Error('El umbral de parada anticipada no es válido.');
  const result=await exportToday({knownIds:payload.knownIds,sinceDate:payload.sinceDate,untilDate:payload.untilDate,propertyId:payload.propertyId,periodId:payload.periodId,activityStartsAt:payload.activityStartsAt,includeLegacyHistory:payload.includeLegacyHistory,refreshExisting:payload.refreshExisting,scanMode:payload.scanMode,canEarlyStop:payload.canEarlyStop,baselineById:payload.baselineById,unchangedThreshold:payload.unchangedThreshold,sync:true,onProgress:event=>emit({type:'progress',...event})});
  emit({type:'result',date:result.date,periodId:result.periodId,propertyId:result.propertyId,sinceDate:result.sinceDate,untilDate:result.untilDate,activityStartsAt:result.activityStartsAt,includeLegacyHistory:result.includeLegacyHistory,files:result.files,discovered:result.discovered,candidates:result.candidates,exported:result.exported,skippedProperty:result.skippedProperty,skippedUnverified:result.skippedUnverified,skippedNoPeriodActivity:result.skippedNoPeriodActivity,requestedMode:result.requestedMode,effectiveMode:result.effectiveMode,examined:result.examined,earlyStopped:result.earlyStopped,stopReason:result.stopReason,unchangedStreak:result.unchangedStreak,unchangedThreshold:result.unchangedThreshold,fullCoverage:result.fullCoverage,headRechecked:result.headRechecked});
}catch(error){
  const message=error instanceof SyntaxError?'La solicitud de sincronización no es válida.':error.message;
  const code=typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'SYNC_FAILED';
  emit({type:'error',code,message});
  process.exitCode=1;
}
