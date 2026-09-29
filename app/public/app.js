import { normalizeTimeZone, localDateTimeParts, localTimeCandidates, civilDayBounds, addCivilDays } from './visit-time.mjs';
import { formatMessageDate } from './message-date.mjs';
const el = id => document.getElementById(id);
const filterIds = ['name','messageQuery','date','reply','pendingReply','children','pets','peopleMin','peopleMax','incomeMin','incomeMax','scope'];
let status = new URLSearchParams(location.search).get('status') || 'active';
if (!['active','favorites','discarded','all'].includes(status)) status = 'active';
let requestId = 0, detailRequestId = 0, debounce, toastTimer, currentDetail = null, currentItems = [], sort = null, arrivalReady=false, replyReady=false, replyFilterReady=false, pendingReady=false, pendingFilterReady=false;
let syncJob = null, syncTimer = null, syncStatusUnavailable = false, syncCompletedId = null, syncModeReady = false, syncStarting = false;
let property = null, capabilitiesReady = false, multiHousingReady=false, selectedPropertyId=null, properties=[],propertyFormMode='create';const noteDrafts=new Map();
let periodsReady=false, periods=[], selectedPeriodId=null, periodFormMode='create', periodGeneration=0, closingApplicant=null, reopeningPeriod=null;
const activePeriod=()=>periods.find(p=>p.id===selectedPeriodId)||null;
const canEditPeriod=()=>!periodsReady||activePeriod()?.status==='open';
const madridToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const periodBase=()=>`${propertyBase()}/periods/${encodeURIComponent(selectedPeriodId)}`;
const periodDate=value=>value?new Date(`${value}T12:00:00`).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'}):'fecha sin indicar';
const money = new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:2});
const collator = new Intl.Collator('es',{numeric:true,sensitivity:'base'});
const sortLabels = {favorite:'Favoritos',name:'Interesado',arrivalDate:'Fecha de llegada',hasReplied:'Respuesta',awaitingReply:'Seguimiento',people_count:'Personas',has_children:'Niños',has_pets:'Mascotas',monthly_income_eur:'Ingresos'};
const initialParams = new URLSearchParams(location.search);
const isCalendar=initialParams.get('view')==='calendar';
const isHome=!isCalendar&&!initialParams.has('propertyId');
el(isCalendar?'navCalendar':'navInterested').setAttribute('aria-current','page');
const workspaceContextKey='moradaWorkspaceContext';
function rememberWorkspaceContext(){
 if(!selectedPropertyId)return;
 const params=new URLSearchParams({propertyId:selectedPropertyId});
 if(selectedPeriodId)params.set('periodId',selectedPeriodId);
 el('navInterested').href=`/?${params}`;
 try{sessionStorage.setItem(workspaceContextKey,el('navInterested').href);}catch{}
}
if(isCalendar||isHome)try{
 const saved=sessionStorage.getItem(workspaceContextKey);
 if(saved){const url=new URL(saved,location.href);if(url.origin===location.origin&&url.pathname==='/'&&url.searchParams.has('propertyId'))
  el('navInterested').href=`${url.pathname}${url.search}`;}
}catch{}
const actionDisclosures=[el('manageDisclosure'),el('syncOptions')];
function closeActionDisclosure(details,focus=false){
 if(!details.open)return;
 details.open=false;
 if(focus)details.querySelector('summary').focus();
}
document.addEventListener('click',event=>{
 for(const details of actionDisclosures)if(!details.contains(event.target))closeActionDisclosure(details);
});
document.addEventListener('keydown',event=>{
 if(event.key!=='Escape'||document.querySelector('dialog[open]'))return;
 const details=actionDisclosures.find(item=>item.open&&item.contains(document.activeElement))||
  actionDisclosures.find(item=>item.open);
 if(details){event.preventDefault();closeActionDisclosure(details,true);}
});
for(const details of actionDisclosures)for(const button of details.querySelectorAll('button'))
 button.addEventListener('click',()=>closeActionDisclosure(details,true));
let browserZone='UTC';try{browserZone=normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);}catch{}
let viewZone=browserZone;try{const saved=localStorage.getItem('calendarTimezone');if(saved)viewZone=normalizeTimeZone(saved);}catch{}
const todayInZone=timezone=>localDateTimeParts(Date.now(),timezone).date;
function zoneOptions(select,selected) {
 const zones=new Set(['UTC','Europe/Madrid',browserZone,viewZone,selected]);
 if(Intl.supportedValuesOf)for(const zone of Intl.supportedValuesOf('timeZone'))zones.add(zone);
 select.replaceChildren(...[...zones].sort((a,b)=>a.localeCompare(b)).map(zone=>new Option(zone,zone)));
 select.value=selected;
}
let homeViewMode='grid';try{homeViewMode=localStorage.getItem('housingView')==='list'?'list':'grid';}catch{}
let homeCategory='active', homeDeleteReady=false;
let filtersVisible=true;try{filtersVisible=localStorage.getItem('filtersVisible')!=='hidden';}catch{}
function setFiltersVisible(visible){filtersVisible=visible;el('filterPanel').hidden=!visible;el('workspaceLayout').classList.toggle('filters-collapsed',!visible);el('toggleFilters').setAttribute('aria-expanded',String(visible));el('toggleFilters').textContent=visible?'Ocultar filtros':'Mostrar filtros';el('toggleFilters').title=visible?'':'Los filtros siguen aplicados';try{localStorage.setItem('filtersVisible',visible?'visible':'hidden');}catch{}}
el('toggleFilters').onclick=()=>setFiltersVisible(!filtersVisible);setFiltersVisible(filtersVisible);
let pendingInitialPeriodId=initialParams.get('periodId');
let pendingInitialApplicantId=initialParams.get('applicantId');
for (const id of filterIds.filter(id=>!['date','incomeMin','incomeMax'].includes(id))) if (initialParams.has(id)) el(id).value = initialParams.get(id);
let incomeCeiling=5000;const requestedIncomeMin=Number(initialParams.get('incomeMin'))||0,requestedIncomeMax=Number(initialParams.get('incomeMax'))||0;

function node(tag, text, className) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
const displayDate=value=>new Date(`${value}T12:00:00`).toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'});
function error(message) {el('error').textContent=message;el('error').hidden=!message;}
function toast(message) {el('toast').textContent=message;el('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el('toast').hidden=true,3500);}
async function api(url,options) {const response=await fetch(url,options);let body={};try{body=await response.json();}catch{}if(!response.ok){const failure=new Error(body.error||'No se pudo completar la operación');Object.assign(failure,body,{status:response.status});throw failure;}return body;}
function housingUrl(id){const params=new URLSearchParams({propertyId:id});return `/?${params}`;}
function setHomeView(mode){homeViewMode=mode;el('homeProperties').dataset.view=mode;el('homeGrid').setAttribute('aria-pressed',String(mode==='grid'));el('homeList').setAttribute('aria-pressed',String(mode==='list'));try{localStorage.setItem('housingView',mode);}catch{}}
el('homeGrid').onclick=()=>setHomeView('grid');el('homeList').onclick=()=>setHomeView('list');setHomeView(homeViewMode);
function renderHomeProperties(items){const cards=items.map(item=>{const deleted=homeCategory==='deleted',closed=!item.activePeriodId&&item.lastClosedPeriod,card=node(deleted?'div':'a',undefined,'home-card');if(!deleted)card.href=housingUrl(item.id);const title=node('h2',item.title),address=node('p',item.address||'Dirección no indicada','home-address'),details=node('p',undefined,'home-details'),status=node('span',deleted?'Eliminada':item.activePeriodId?'Búsqueda activa':closed?'Búsqueda cerrada':'Sin búsqueda activa','home-status');details.append(status);if(!deleted&&closed?.chosenApplicantName)details.append(node('span',`Inquilino elegido: ${closed.chosenApplicantName}`,'home-tenant'));if(!deleted&&item.activePeriodId&&item.monthlyRentCents!=null)details.append(node('span',`${money.format(item.monthlyRentCents/100)}/mes`));card.append(title,address,details);if(deleted){const actions=node('div',undefined,'home-deleted-actions');actions.append(actionButton('Restaurar vivienda',`Restaurar ${item.title}`,b=>restoreProperty(item,b),'home-restore'),actionButton('Eliminar definitivamente',`Eliminar definitivamente ${item.title}`,()=>reviewPurgeProperty(item),'home-purge'));card.append(actions);}else card.append(node('span','Abrir vivienda →','home-open'));return card;});el('homeProperties').replaceChildren(...cards);el('homeStatus').textContent=items.length?`${items.length} ${items.length===1?'vivienda':'viviendas'} ${homeCategory==='deleted'?'eliminadas':'activas'}`:homeCategory==='deleted'?'No hay viviendas eliminadas.':'Aún no hay viviendas. Añade la primera para empezar.';}
async function loadHomeProperties(){el('homeStatus').textContent='Cargando viviendas…';el('homeError').hidden=true;el('homeRetry').hidden=true;try{const result=await api(homeCategory==='deleted'?'/api/properties?status=deleted':'/api/properties');homeDeleteReady=result.supportsDeletedProperties===true;el('homeTabs').hidden=!homeDeleteReady;if(homeCategory==='deleted'&&!homeDeleteReady){homeCategory='active';return loadHomeProperties();}properties=result.properties;multiHousingReady=true;if(homeCategory==='active'){const remembered=new URL(el('navInterested').href,location.href).searchParams.get('propertyId');if(!properties.some(item=>item.id===remembered)){el('navInterested').href=properties.length?housingUrl(properties[0].id):'/';try{sessionStorage.removeItem(workspaceContextKey);}catch{}}}renderHomeProperties(properties);}catch(e){el('homeProperties').replaceChildren();el('homeStatus').textContent=`No se han podido cargar las viviendas. ${e.message}`;el('homeRetry').hidden=false;}}
async function restoreProperty(item,button){if(!homeDeleteReady||homeCategory!=='deleted')return;el('homeError').hidden=true;button.disabled=true;try{await api(`/api/properties/${encodeURIComponent(item.id)}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});homeCategory='active';updateHomeTabs();await loadHomeProperties();el('homeActive').focus();}catch(e){el('homeError').textContent=e.message;el('homeError').hidden=false;button.disabled=false;}}
let pendingPurgeProperty=null;
function reviewPurgeProperty(item){if(!homeDeleteReady||homeCategory!=='deleted'||!item.deletedAt)return;pendingPurgeProperty=item;el('purgePropertyReview').textContent=`Vas a eliminar definitivamente ${item.title}.`;el('purgePropertyForm').querySelector('.form-error').textContent='';el('purgePropertyDialog').showModal();}
el('purgePropertyForm').onsubmit=async event=>{event.preventDefault();const item=pendingPurgeProperty,button=el('confirmPurgeProperty'),errorNode=event.currentTarget.querySelector('.form-error');if(!item||homeCategory!=='deleted'||!homeDeleteReady)return;button.disabled=true;errorNode.textContent='';try{await api(`/api/properties/${encodeURIComponent(item.id)}/permanent`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmPropertyId:item.id})});el('purgePropertyDialog').close();pendingPurgeProperty=null;await loadHomeProperties();el('homeDeleted').focus();}catch(e){errorNode.textContent=e.message;}finally{button.disabled=false;}};
function updateHomeTabs(){el('homeActive').setAttribute('aria-pressed',String(homeCategory==='active'));el('homeDeleted').setAttribute('aria-pressed',String(homeCategory==='deleted'));}
el('homeActive').onclick=()=>{homeCategory='active';updateHomeTabs();loadHomeProperties();};el('homeDeleted').onclick=()=>{if(!homeDeleteReady)return;homeCategory='deleted';updateHomeTabs();loadHomeProperties();};
async function syncApi(method,mode='incremental') {const url=periodsReady&&selectedPeriodId?`${periodBase()}/sync`:method==='POST'&&multiHousingReady?`${propertyBase()}/sync`:'/api/sync';const response=await fetch(url,method==='POST'?{method:'POST',headers:{'Content-Type':'application/json'},body:mode==='full'?JSON.stringify({mode:'full'}):'{}'}:undefined);let body={};try{body=await response.json();}catch{}if(!response.ok&&response.status!==409)throw new Error(body.error||'No se ha podido comprobar la sincronización');return {status:response.status,body};}
const phaseLabels={connecting:'Conectando con Idealista',refreshing:'Actualizando chats',discovering:'Buscando chats nuevos',exporting:'Preparando conversaciones',importing:'Importando conversaciones'};
function syncProgress(job) {const parts=[];if(Number.isFinite(job.examined)){parts.push(`${job.examined} ${job.examined===1?'revisión de chat':'revisiones de chat'}`);if(Number.isFinite(job.candidates))parts.push(`${job.candidates} ${job.candidates===1?'candidato':'candidatos'} en el listado`);}else{if(Number.isFinite(job.candidates))parts.push(`${job.candidates} ${job.candidates===1?'candidato':'candidatos'}`);if(Number.isFinite(job.exported))parts.push(`${job.exported} ${job.exported===1?'exportado':'exportados'}`);}return parts.join(' · ');}
function syncSince(job) {if(!job.sinceDate||!/^\d{4}-\d\d-\d\d$/.test(job.sinceDate))return '';return `Desde ${new Date(`${job.sinceDate}T12:00:00`).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})}`;}
function renderSync() {
 const region=el('syncRegion'),button=el('sync'),full=el('syncFull'),summaryNode=el('syncSummary'),
  statusNode=el('syncStatus'),errorNode=el('syncError'),job=syncJob;
 const canSync=periodsReady?canEditPeriod()&&!!activePeriod()?.syncEnabled:!multiHousingReady||!!property?.syncEnabled;
 el('syncOptions').hidden=!periodsReady||!syncModeReady;
 if(el('syncOptions').hidden)el('syncOptions').open=false;
 full.hidden=!periodsReady||!syncModeReady;
 full.disabled=!canSync||syncStarting||syncStatusUnavailable||job?.state==='running';
 region.hidden=false;errorNode.hidden=true;errorNode.textContent='';
 if(syncStarting){button.disabled=true;full.disabled=true;button.textContent='Iniciando…';summaryNode.textContent='Iniciando sincronización…';statusNode.textContent='Iniciando sincronización…';return;}
 if(syncStatusUnavailable){summaryNode.textContent='Estado de sincronización no disponible.';statusNode.textContent='No se ha podido actualizar el estado de la sincronización.';errorNode.textContent='Comprueba la conexión y vuelve a intentarlo.';errorNode.hidden=false;button.disabled=!canSync;button.textContent='Reintentar comprobación';return;}
 if(!job||job.state==='idle'){region.hidden=true;summaryNode.textContent='';button.disabled=!canSync;button.textContent='Sincronizar';return;}
 const since=syncSince(job);
 if(job.state==='running'){const progress=syncProgress(job),target=job.propertyId&&properties.find(p=>p.id===job.propertyId)?.title;summaryNode.textContent=`${phaseLabels[job.phase]||'Sincronizando'}${progress?` · ${progress}`:''}`;statusNode.textContent=`${phaseLabels[job.phase]||'Sincronizando'}${target?` · ${target}`:''}${since?` · ${since}`:''}${progress?` · ${progress}`:''}`;button.disabled=true;button.textContent='Sincronizando…';return;}
 button.disabled=!canSync;button.textContent='Sincronizar';
 if(job.state==='succeeded'){
  const changes=[];if(job.imported)changes.push(`${job.imported} ${job.imported===1?'nueva importada':'nuevas importadas'}`);if(job.updated)changes.push(`${job.updated} ${job.updated===1?'historial actualizado':'historiales actualizados'}`);
  if(job.newIncomingApplicants)changes.push(`${job.newIncomingApplicants} ${job.newIncomingApplicants===1?'interesado con mensajes recibidos nuevos':'interesados con mensajes recibidos nuevos'}`);
  if(job.newIncomingMessages)changes.push(`${job.newIncomingMessages} ${job.newIncomingMessages===1?'mensaje recibido nuevo':'mensajes recibidos nuevos'}`);
  const modern=job.requestedMode==='incremental'||job.requestedMode==='full';
  if(modern){const title=job.earlyStopped?'Revisión rápida finalizada':job.effectiveMode==='full'&&job.fullCoverage!==false?'Revisión completa finalizada':'Sincronización finalizada',progress=syncProgress(job),threshold=Number.isSafeInteger(job.unchangedThreshold)&&job.unchangedThreshold>0?job.unchangedThreshold:5,stopped=job.earlyStopped&&job.stopReason==='unchanged_streak'?`Detenido tras ${threshold} chats consecutivos sin novedades.`:'';summaryNode.textContent=title;statusNode.textContent=[`${title}.`,progress?`${progress}.`:'',changes.length?`${changes.join(' · ')}.`:'',stopped,since?`${since}.`:''].filter(Boolean).join(' ');}
  else{summaryNode.textContent='Sincronización completada';statusNode.textContent=`Sincronización completada${changes.length?`: ${changes.join(' · ')}.`:'.'}${since?` ${since}.`:''}`;}
 }else{summaryNode.textContent='La sincronización no se ha completado.';statusNode.textContent='La sincronización no se ha completado.';errorNode.textContent=job.error||'Revisa Chrome e inténtalo de nuevo.';errorNode.hidden=false;}
}
function stopSyncPolling(){if(syncTimer){clearTimeout(syncTimer);syncTimer=null;}}
function scheduleSyncPoll(){stopSyncPolling();if(syncJob?.state==='running'&&!syncStatusUnavailable)syncTimer=setTimeout(checkSync,1000);}
function adoptSyncJob(job,{reloadOnSuccess=false}={}) {syncJob=job;syncStatusUnavailable=false;renderSync();if(job?.state==='running'){scheduleSyncPoll();return;}stopSyncPolling();if(reloadOnSuccess&&job?.state==='succeeded'&&job.id!==syncCompletedId){syncCompletedId=job.id;if(!periodsReady||job.periodId===selectedPeriodId)load();}}
async function checkSync() {const generation=periodGeneration;try{const {body}=await syncApi('GET');if(generation!==periodGeneration)return;syncModeReady=periodsReady&&body.supportsSyncModes===true;adoptSyncJob(body.job,{reloadOnSuccess:true});}catch(e){if(generation!==periodGeneration)return;stopSyncPolling();syncStatusUnavailable=true;renderSync();}}
async function startSync(mode='incremental') {if(syncStarting||(mode==='full'&&!syncModeReady)||(periodsReady?!canEditPeriod()||!activePeriod()?.syncEnabled:multiHousingReady&&!property?.syncEnabled))return;if(syncStatusUnavailable||syncJob?.state==='running'){checkSync();return;}const generation=periodGeneration;syncStarting=true;renderSync();try{const {body}=await syncApi('POST',mode);if(generation!==periodGeneration)return;syncStarting=false;adoptSyncJob(body.job,{reloadOnSuccess:true});}catch(e){if(generation!==periodGeneration)return;syncStarting=false;syncStatusUnavailable=true;syncJob={state:'failed'};renderSync();el('syncStatus').textContent='No se ha podido iniciar la sincronización.';el('syncError').textContent=e.message;el('syncError').hidden=false;}finally{if(syncStarting){syncStarting=false;renderSync();}}}
function propertyBase(){return multiHousingReady?`/api/properties/${encodeURIComponent(selectedPropertyId)}`:'/api/property';}
function applicantBase(){return periodsReady?`${periodBase()}/applicants`:multiHousingReady?`${propertyBase()}/applicants`:'/api/applicants';}
async function loadProperty(){const id=selectedPropertyId,scoped=multiHousingReady;try{const result=await api(scoped?`/api/properties/${encodeURIComponent(id)}`:'/api/property');if(scoped!==multiHousingReady||id!==selectedPropertyId)return;property=result.property;capabilitiesReady=true;el('rentalSince').value=property.rentalSince||'';el('rentalSince').max=madridToday();el('propertyTitle').textContent='Interesados';el('editProperty').disabled=false;el('propertySettings').hidden=periodsReady;el('messageFilter').hidden=false;el('capabilityNotice').hidden=true;if(periodsReady)renderPeriod();else{el('propertyAddress').textContent=[property.title,property.address,property.monthlyRentCents?`${money.format(property.monthlyRentCents/100)}/mes`:null].filter(Boolean).join(' · ');el('syncHelper').textContent=multiHousingReady&&!property.syncEnabled?'Añade la URL de Idealista para sincronizar.':'Chats de este alquiler · Chrome abierto';renderSync();}}catch(e){if(scoped!==multiHousingReady||id!==selectedPropertyId)return;capabilitiesReady=false;property=null;el('editProperty').disabled=true;el('propertySettings').hidden=true;el('messageFilter').hidden=true;el('capabilityNotice').hidden=false;renderSync();}}
async function loadProperties(){try{const result=await api('/api/properties');properties=result.properties;multiHousingReady=true;const requested=initialParams.get('propertyId');selectedPropertyId=properties.some(p=>p.id===requested)?requested:properties[0]?.id;if(!selectedPropertyId){try{sessionStorage.removeItem(workspaceContextKey);}catch{}location.replace('/');return;}el('propertySelect').replaceChildren(...properties.map(p=>new Option(p.title,p.id)));el('propertySelect').value=selectedPropertyId;el('housingControls').hidden=false;await loadProperty();await loadPeriods();load();refreshIncomeBounds();checkSync();}catch{multiHousingReady=false;}}
async function loadPeriods(preferredId){if(!multiHousingReady)return;const propertyId=selectedPropertyId,generation=++periodGeneration;try{const response=await fetch(`${propertyBase()}/periods`);if(response.status===404){if(generation!==periodGeneration||propertyId!==selectedPropertyId)return;periodsReady=false;periods=[];selectedPeriodId=null;el('periodControls').hidden=true;el('managePeriodGroup').hidden=true;el('propertySettings').hidden=!capabilitiesReady;el('addApplicant').hidden=false;renderSync();return;}const result=await response.json();if(!response.ok)throw new Error(result.error||'No se han podido cargar las búsquedas');if(generation!==periodGeneration||propertyId!==selectedPropertyId)return;periodsReady=true;periods=result.periods;const requested=preferredId||pendingInitialPeriodId;pendingInitialPeriodId=null;selectedPeriodId=periods.some(p=>p.id===requested)?requested:(periods.find(p=>p.status==='open')?.id||periods[0]?.id||null);renderPeriod();}catch(e){if(generation!==periodGeneration||propertyId!==selectedPropertyId)return;periodsReady=true;periods=[];selectedPeriodId=null;el('periodControls').hidden=false;el('periodSelect').hidden=true;el('newPeriod').hidden=true;el('editPeriod').hidden=true;el('managePeriodGroup').hidden=true;el('addApplicant').hidden=true;el('periodSummary').textContent='No se han podido cargar las búsquedas. Actualiza la página para reintentar.';el('propertySettings').hidden=true;error(e.message);renderSync();}}
function canReopenPeriod(){const period=activePeriod();return periodsReady&&period?.status==='closed'&&periods[0]?.id===period.id&&!periods.some(p=>p.status==='open');}
function renderPeriod(){if(!periodsReady)return;const period=activePeriod(),open=period?.status==='open',canCreate=!periods.some(p=>p.status==='open');el('periodControls').hidden=false;el('propertySettings').hidden=true;el('periodSelect').replaceChildren(...periods.map(p=>new Option(`${p.status==='open'?'Activa':'Cerrada'} · ${periodDate(p.rentalSince)} · ${money.format((p.monthlyRentCents||0)/100)}/mes`,p.id)));el('periodSelect').hidden=!periods.length;el('periodSelect').value=selectedPeriodId||'';el('newPeriod').hidden=!canCreate;el('reopenPeriod').hidden=!canReopenPeriod();el('editPeriod').hidden=!open;el('managePeriodGroup').hidden=!canCreate&&!open;el('addApplicant').hidden=!open;el('propertyAddress').textContent=[property?.title,property?.address,period?`${money.format((period.monthlyRentCents||0)/100)}/mes`:null].filter(Boolean).join(' · ');el('periodSummary').textContent=period?`${open?'Búsqueda activa':'Búsqueda cerrada'} · Alquiler desde ${periodDate(period.rentalSince)} · ${money.format((period.monthlyRentCents||0)/100)}/mes${period.url?' · Anuncio de Idealista':''}${!open&&period.chosenApplicantId?` · Inquilino elegido: ${period.chosenApplicant?.name||period.chosenApplicantName||period.chosenApplicantId}`:''}${!open&&period.closedAt?` · Cerrada el ${periodDate(period.closedAt.slice(0,10))}`:''}`:'No hay búsquedas todavía. Crea una para añadir interesados.';if(!open&&period?.chosenApplicantId)el('periodSummary').append(' · ',actionButton('Ver ficha del inquilino elegido','Ver ficha del inquilino elegido',()=>detail(period.chosenApplicantId),'text-button'));el('syncHelper').textContent=!period?'Crea una búsqueda para empezar.':!open?'Esta búsqueda cerrada es de solo lectura.':!period.syncEnabled?'Añade la URL de Idealista para sincronizar.':'Chats de esta búsqueda · Chrome abierto';rememberWorkspaceContext();renderSync();}
el('propertySettings').onsubmit=async event=>{event.preventDefault();const date=el('rentalSince').value,button=el('propertySettings').querySelector('button');if(!/^\d{4}-\d\d-\d\d$/.test(date)||date>new Date().toISOString().slice(0,10)){el('propertyFeedback').textContent='Indica una fecha válida.';return;}button.disabled=true;el('propertyFeedback').textContent='';try{const result=await api(propertyBase(),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({rentalSince:date})});property=result.property;el('rentalSince').value=property.rentalSince;el('propertyFeedback').textContent='Fecha guardada.';}catch(e){el('propertyFeedback').textContent=e.message;}finally{button.disabled=false;}};
function updateIncomeBounds(values=[]) {const currentMin=Number(el('incomeMin').value)||0,currentMax=Number(el('incomeMax').value)||incomeCeiling,known=Math.max(0,...values.filter(Number.isFinite),requestedIncomeMin,requestedIncomeMax,currentMin,currentMax);let needed=Math.max(5000,Math.ceil(known/500)*500);if(requestedIncomeMax&&requestedIncomeMax>=needed)needed=Math.ceil((requestedIncomeMax+1)/500)*500;if(needed>incomeCeiling)incomeCeiling=needed;for(const id of ['incomeMin','incomeMax'])el(id).max=String(incomeCeiling);const min=initialParams.has('incomeMin')&&currentMin===0?requestedIncomeMin:Math.min(currentMin,incomeCeiling),max=initialParams.has('incomeMax')&&currentMax===5000?requestedIncomeMax:currentMax;el('incomeMin').value=String(Math.min(min,incomeCeiling));el('incomeMax').value=String(Math.max(Number(el('incomeMin').value),Math.min(max||incomeCeiling,incomeCeiling)));renderIncomeValues();}
function renderIncomeValues(){const min=Number(el('incomeMin').value),max=Number(el('incomeMax').value);el('incomeMinValue').textContent=`Desde ${money.format(min)}/mes`;el('incomeMaxValue').textContent=max>=incomeCeiling?'Sin límite':`Hasta ${money.format(max)}/mes`;}
async function refreshIncomeBounds(){const id=selectedPropertyId,periodId=selectedPeriodId,scoped=multiHousingReady;if(periodsReady&&!periodId)return;try{const result=await api(`${applicantBase()}?status=all`);if(id!==selectedPropertyId||periodId!==selectedPeriodId||scoped!==multiHousingReady)return;updateIncomeBounds(result.items.map(item=>item.monthly_income_eur).filter(value=>value!==null));}catch{if(id===selectedPropertyId&&periodId===selectedPeriodId)renderIncomeValues();}}
function query() {const q=new URLSearchParams({status});for(const id of filterIds){const value=el(id).value;if(!value||(id==='messageQuery'&&!capabilitiesReady)||(id==='reply'&&!replyFilterReady)||(id==='pendingReply'&&!pendingFilterReady)||(id==='incomeMin'&&Number(value)===0)||(id==='incomeMax'&&Number(value)>=incomeCeiling))continue;q.set(id,value);}return q;}
function updateSortHeaders() {
 for (const th of document.querySelectorAll('th[data-sort]')) {
  const key=th.dataset.sort, button=th.querySelector('button'), active=sort?.key===key;
  th.removeAttribute('aria-sort');
  if(active) th.setAttribute('aria-sort',sort.direction==='asc'?'ascending':'descending');
  button.dataset.direction=active?sort.direction:'';
  button.setAttribute('aria-label',`Ordenar por ${sortLabels[key]}${active?`, actualmente ${sort.direction==='asc'?'ascendente':'descendente'}`:''}`);
 }
 el('sortSummary').textContent=!sort?'Actividad más reciente primero':sort.key==='arrivalDate'?`Fecha de llegada: ${sort.direction==='asc'?'más antiguos primero':'más recientes primero'}`:sort.key==='hasReplied'?`Respuesta: ${sort.direction==='asc'?'Has respondido primero':'Sin respuesta primero'}`:sort.key==='awaitingReply'?`Seguimiento: ${sort.direction==='asc'?'Pendientes primero':'Esperando respuesta primero'}`:sort.key==='name'?`Interesado: ${sort.direction==='asc'?'A a Z':'Z a A'}`:`${sortLabels[sort.key]}: ${sort.direction==='asc'?'de menor a mayor':'de mayor a menor'}`;
}
function sortedItems(items) {
 if(!sort)return items;
 return items.map((item,index)=>({item,index})).sort((a,b)=>{
  if(sort.key==='hasReplied'||sort.key==='awaitingReply'){
   const left=a.item[sort.key],right=b.item[sort.key],knownLeft=typeof left==='boolean',knownRight=typeof right==='boolean';
   if(!knownLeft||!knownRight){if(!knownLeft&&!knownRight)return a.index-b.index;return knownLeft?-1:1;}
   if(left===right)return a.index-b.index;
   return sort.direction==='asc'?(left?-1:1):(left?1:-1);
  }
  if(sort.key==='arrivalDate'){
   const left=a.item.arrivalDate,right=b.item.arrivalDate;
   if(!left||!right){if(!left&&!right)return a.index-b.index;return left? -1:1;}
   const day=left.localeCompare(right);if(day)return sort.direction==='asc'?day:-day;
   const leftAt=a.item.arrivalAt,rightAt=b.item.arrivalAt;
   if(!leftAt||!rightAt){if(!leftAt&&!rightAt)return a.index-b.index;return leftAt?-1:1;}
   const instant=Date.parse(leftAt)-Date.parse(rightAt);return instant?(sort.direction==='asc'?instant:-instant):a.index-b.index;
  }
  const left=a.item[sort.key],right=b.item[sort.key],leftUnknown=left===null||left===undefined,rightUnknown=right===null||right===undefined;
  if(leftUnknown||rightUnknown){if(leftUnknown&&rightUnknown)return a.index-b.index;return leftUnknown?1:-1;}
  const compared=sort.key==='name'?collator.compare(left,right):Number(left)-Number(right);
  return compared?(sort.direction==='asc'?compared:-compared):a.index-b.index;
 }).map(({item})=>item);
}
function renderItems() {const items=sortedItems(currentItems);el('rows').replaceChildren(...items.map(renderRow));el('empty').hidden=!!items.length;updateSortHeaders();}
function validate() {
 for(const [min,max] of [['peopleMin','peopleMax'],['incomeMin','incomeMax']])if(el(min).value!==''&&el(max).value!==''&&Number(el(min).value)>Number(el(max).value))return 'El mínimo no puede ser mayor que el máximo.';
 if(!el('filters').checkValidity())return 'Revisa los rangos: personas enteras e importes no negativos.';
 return null;
}
let datesInitialized=false;
async function load() {
 const seq=++requestId;
 const invalid=validate();
 if(invalid){error(invalid);el('rows').replaceChildren();el('count').textContent='Revisa los filtros';el('empty').hidden=true;return;}
 error('');
 const q=query();
 if(!datesInitialized&&initialParams.has('date'))q.set('date',initialParams.get('date'));
 if(multiHousingReady)q.set('propertyId',selectedPropertyId);else if(initialParams.has('propertyId'))q.set('propertyId',initialParams.get('propertyId'));if(periodsReady&&selectedPeriodId)q.set('periodId',selectedPeriodId);history.replaceState(null,'',`?${q}`);
 rememberWorkspaceContext();
 for(const tab of document.querySelectorAll('[data-status]'))tab.setAttribute('aria-pressed',String(tab.dataset.status===status));
 el('count').textContent='Cargando interesados…';
 try {
  if(periodsReady&&!selectedPeriodId){currentItems=[];el('rows').replaceChildren();el('count').textContent='0 interesados';for(const id of ['total','favoriteCount','discardedCount','activeBadge','favoriteBadge','discardedBadge'])el(id).textContent='0';el('empty').hidden=false;return;}
  const result=await api(`${applicantBase()}?${q}`);
  if(seq!==requestId)return;
  let replayBookmark=false;
  if(result.supportsReplyFilter===true&&!replyFilterReady){replyFilterReady=true;el('replyFilter').hidden=false;replayBookmark=!!el('reply').value;}
  if(result.supportsPendingReplyFilter===true&&!pendingFilterReady){pendingFilterReady=true;el('pendingReplyFilter').hidden=false;replayBookmark=replayBookmark||!!el('pendingReply').value;}
  if(replayBookmark){load();return;}
  const date=q.get('date')||'';el('date').replaceChildren(new Option('Todas las fechas importadas',''),...result.dates.map(d=>new Option(new Date(`${d}T12:00:00`).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'}),d)));
  el('date').value=date;datesInitialized=true;
  for(const [id,key] of [['total','total'],['favoriteCount','favorites'],['discardedCount','discarded'],['activeBadge','active'],['favoriteBadge','favorites'],['discardedBadge','discarded']])el(id).textContent=result.counts[key];
  el('count').textContent=`${result.items.length} ${result.items.length===1?'interesado':'interesados'}${filterIds.some(id=>(id!=='reply'||replyFilterReady)&&(id!=='pendingReply'||pendingFilterReady)&&el(id).value)?' con estos filtros':''}`;
  currentItems=result.items;if(!arrivalReady&&result.items.some(item=>Object.hasOwn(item,'arrivalDate')))arrivalReady=true;if(!replyReady&&result.items.some(item=>Object.hasOwn(item,'hasReplied')))replyReady=true;if(!pendingReady&&result.items.some(item=>Object.hasOwn(item,'awaitingReply')))pendingReady=true;document.querySelector('th[data-sort="arrivalDate"]').hidden=!arrivalReady;el('replyHeading').hidden=!replyReady;el('pendingReplyHeading').hidden=!pendingReady;renderItems();if(pendingInitialApplicantId){const id=pendingInitialApplicantId;pendingInitialApplicantId=null;detail(id);}
 } catch(e){if(seq===requestId){error(e.message);el('count').textContent='No se ha podido cargar el listado';el('rows').replaceChildren();}}
}
function triCell(value) {return value===null?node('span','No indicado','unknown'):node('span',value?'Sí':'No',`pill${value?'':' no'}`);}
function actionButton(text,label,handler,className='') {const button=node('button',text,className);button.type='button';button.setAttribute('aria-label',label);button.onclick=()=>handler(button);return button;}
function renderRow(item) {
 const tr=node('tr');const recordId=item.applicant_id||item.conversation_id;tr.dataset.id=recordId;
 const attention=periodsReady&&activePeriod()?.status==='open'?item.syncAttention:null;if(attention==='new'||attention==='message')tr.classList.add('attention-row');
 const star=node('td');if(canEditPeriod()){const favorite=actionButton(item.favorite?'★':'☆',`${item.favorite?'Quitar de':'Añadir a'} favoritos: ${item.name}`,b=>change(item,{favorite:!item.favorite},b),'favorite-button');favorite.setAttribute('aria-pressed',String(!!item.favorite));star.append(favorite);}else star.append(node('span',item.favorite?'★':'☆','favorite-readonly'));tr.append(star);
 const name=node('td'),person=node('div',undefined,'person'),avatar=node('span',item.name.trim().split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase(),'avatar'),info=node('div');
 const hasMessageCount=Number.isSafeInteger(item.messageCount)&&item.messageCount>=0;
 info.append(actionButton(hasMessageCount?`${item.name} (${item.messageCount})`:item.name,`Ver ficha de ${item.name}${hasMessageCount?`, ${item.messageCount} ${item.messageCount===1?'mensaje':'mensajes'}`:''}`,()=>detail(recordId),'person-button'),node('span',item.source==='manual'?'Añadido manualmente':`Última actividad: ${item.activity_date}${item.listed_time?` · ${item.listed_time}`:''}${item.discarded?' · Descartado':''}`,'person-meta'));
 if(attention==='new'||attention==='message')info.append(node('span',attention==='new'?'Nuevo':`Nuevo mensaje${item.newIncomingCount>1?` (${item.newIncomingCount})`:''}`,'attention-badge'));
 if(item.messageMatch){const match=node('span',`${item.messageMatch.author} · ${item.messageMatch.snippet}`,'message-match');info.append(match);}if(item.notes)info.append(node('span','Nota privada','note-indicator'));
 person.append(avatar,info);name.append(person);tr.append(name);
 if(arrivalReady){const arrival=node('td');if(item.arrivalDate){const stamp=item.arrivalAt?new Date(item.arrivalAt).toLocaleTimeString('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}):null;arrival.append(node('span',`${displayDate(item.arrivalDate)}${stamp?` · ${stamp}`:''}`,'arrival-date'));arrival.title=item.source==='manual'?'Fecha de alta manual':'Primer mensaje recibido';}else arrival.append(node('span','No indicada','unknown'));tr.append(arrival);}
 if(replyReady){const reply=node('td'),known=item.hasReplied===true||item.hasReplied===false,manual=item.source==='manual';const text=item.hasReplied===true?'✓ Has respondido':item.hasReplied===false?'Sin respuesta':manual?'Sin chat':'No confirmado';const status=node('span',text,`reply-status${item.hasReplied===true?' replied':''}${known?'':' unknown'}`);if(item.hasReplied===true)status.title='Hay al menos un mensaje tuyo en este periodo';else if(item.hasReplied===false)status.title='No hay mensajes tuyos en el historial de este periodo';else if(!manual)status.title='El historial no permite confirmar si has respondido';reply.append(status);tr.append(reply);}
 if(pendingReady){const pending=node('td'),known=typeof item.awaitingReply==='boolean',manual=item.source==='manual';const text=item.awaitingReply===true?'↩ Pendiente de responder':item.awaitingReply===false?'Esperando respuesta':manual?'Sin chat':'No confirmado';const state=node('span',text,`pending-status${item.awaitingReply===true?' pending':''}${known?'':' unknown'}`);if(item.awaitingReply===true)state.title='El último mensaje verificable de este periodo lo envió el interesado';else if(item.awaitingReply===false)state.title='El último mensaje verificable de este periodo lo enviaste tú';else if(!manual)state.title='El historial no permite confirmar quién envió el último mensaje';pending.append(state);tr.append(pending);}
 const people=node('td');people.append(node('span',item.people_count??'No indicado',item.people_count===null?'unknown':''));tr.append(people);
 for(const field of ['has_children','has_pets']){const td=node('td');td.append(triCell(item[field]));tr.append(td);}
 const income=node('td');if(item.monthly_income_eur===null)income.append(node('span','No indicado','unknown'));else{income.append(node('span',money.format(item.monthly_income_eur),'income'),node('span',item.income_scope==='grupo'?'Del grupo':'Individual','income-scope'));}tr.append(income);
 const actions=node('td'),group=node('div',undefined,'row-actions');group.append(actionButton('Ver ficha',`Ver detalle de ${item.name}`,()=>detail(recordId)));if(canEditPeriod())group.append(actionButton(item.discarded?'Recuperar':'Descartar',`${item.discarded?'Recuperar':'Descartar'} a ${item.name}`,b=>change(item,{discarded:!item.discarded},b),'discard'));actions.append(group);tr.append(actions);
 return tr;
}
async function change(item,changes,button) {
 if(!canEditPeriod())return;
 button.disabled=true;error('');
 try {
  const recordId=item.applicant_id||item.conversation_id,selectedAtStart=selectedPropertyId,periodAtStart=selectedPeriodId,base=applicantBase();
  await api(`${base}/${encodeURIComponent(recordId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(changes)});
  if(selectedAtStart!==selectedPropertyId||periodAtStart!==selectedPeriodId)return;
  toast('discarded' in changes?(changes.discarded?'Interesado descartado. Puedes recuperarlo en Descartados.':'Interesado recuperado.'):(changes.favorite?'Guardado en favoritos.':'Eliminado de favoritos.'));
  if(currentDetail===recordId&&el('detail').open)await detail(recordId);
  await load();
 }catch(e){error(e.message);toast('No se ha guardado el cambio.');button.disabled=false;}
}
async function detail(id) {
 currentDetail=id;const detailSeq=++detailRequestId,propertyAtStart=selectedPropertyId,periodAtStart=selectedPeriodId,base=applicantBase();
 const dialog=el('detail');el('detailName').textContent='Cargando…';el('detailBody').replaceChildren();el('detailActions').replaceChildren();if(!dialog.open){dialog.showModal();dialog.scrollTop=0;}
 try{
  const item=await api(`${base}/${encodeURIComponent(id)}`);if(currentDetail!==id||detailSeq!==detailRequestId||propertyAtStart!==selectedPropertyId||periodAtStart!==selectedPeriodId)return;
  el('detailName').textContent=item.name;
  if(canEditPeriod())el('detailActions').append(actionButton(item.favorite?'★ Favorito':'☆ Guardar favorito','Cambiar favorito',b=>change(item,{favorite:!item.favorite},b)),actionButton(item.discarded?'Recuperar interesado':'Descartar interesado','Cambiar descartado',b=>change(item,{discarded:!item.discarded},b)),actionButton('Elegir inquilino y cerrar búsqueda',`Elegir a ${item.name} y cerrar búsqueda`,()=>reviewClose(item)));
  const body=el('detailBody');body.append(node('p',item.source==='manual'?'Interesado añadido manualmente':`Chat ${id} · Ficha: ${item.profile_status} · Historial: ${item.history_status}`,'integrity'));if(item.phone||item.email)body.append(node('p',[item.phone,item.email].filter(Boolean).join(' · '),'integrity'));
  if(capabilitiesReady){body.append(node('h3','Notas privadas','detail-label'));if(!canEditPeriod())body.append(node('div',item.notes||'Sin notas.','profile-text'));else{const notes=node('textarea',undefined,'notes-input');notes.id='detailNotes';notes.maxLength=10000;notes.setAttribute('aria-label','Notas privadas');const draftKey=`${propertyAtStart||'legacy'}:${periodAtStart||'legacy'}:${id}`;notes.value=noteDrafts.has(draftKey)?noteDrafts.get(draftKey):(item.notes||'');const saveNotes=actionButton('Guardar notas','Guardar notas',async button=>{button.disabled=true;const value=notes.value;try{await api(`${base}/${encodeURIComponent(item.applicant_id||id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:value})});if(propertyAtStart!==selectedPropertyId||periodAtStart!==selectedPeriodId)return;noteDrafts.delete(draftKey);noteFeedback.textContent='Notas guardadas.';await load();}catch(e){if(propertyAtStart===selectedPropertyId&&periodAtStart===selectedPeriodId){noteFeedback.textContent=e.message;button.disabled=false;}}});const noteFeedback=node('p','','note-feedback');notes.oninput=()=>{noteDrafts.set(draftKey,notes.value);noteFeedback.textContent='Cambios sin guardar.';};body.append(notes,saveNotes,noteFeedback);}}
  renderApplicantVisits(item,id,body,{propertyId:propertyAtStart,periodId:periodAtStart,applicantId:item.applicant_id||id,editable:canEditPeriod()});
  body.append(node('h3','Ficha original','detail-label'),node('div',item.profile?.text??'Este interesado no tiene una ficha disponible.','profile-text'));
  const messages=[...(item.messages||[])].reverse();if(messages.length)body.append(node('h3',`Conversación · ${messages.length} mensajes`,'detail-label'));
  for(const m of messages){const article=node('article',undefined,`message ${m.direction}`);article.append(node('p',`${m.author} · ${formatMessageDate(m,item)} · ${m.time??''}`,'message-meta'),node('pre',m.rawText));body.append(article);}
  if(item.integrity?.notes?.length)body.append(node('p',item.integrity.notes.join(' '),'integrity'));
  if(periodsReady&&activePeriod()?.status==='open'&&item.attentionRevision&&item.syncAttention&&currentDetail===id&&detailSeq===detailRequestId&&propertyAtStart===selectedPropertyId&&periodAtStart===selectedPeriodId)ackAttention(id,item.attentionRevision,{propertyId:propertyAtStart,periodId:periodAtStart,detailSeq});
 }catch(e){if(detailSeq===detailRequestId&&propertyAtStart===selectedPropertyId&&periodAtStart===selectedPeriodId){el('detailName').textContent='No se pudo cargar la ficha';el('detailBody').append(node('p',e.message,'error'));}}
}
async function ackAttention(id,revision,context){const url=`/api/properties/${encodeURIComponent(context.propertyId)}/periods/${encodeURIComponent(context.periodId)}/applicants/${encodeURIComponent(id)}/attention/read`;try{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision})});if(context.propertyId!==selectedPropertyId||context.periodId!==selectedPeriodId)return;if(response.ok){load();return;}if(response.status===409){load();if(currentDetail===id&&detailRequestId===context.detailSeq&&el('detail').open)el('detailBody').append(node('p','Han llegado mensajes nuevos. Cierra y vuelve a abrir esta ficha para verlos.','attention-notice'));}}catch{}}
const visitStatus={pending_confirmation:'Pendiente de confirmar',confirmed:'Confirmada',completed:'Realizada',cancelled:'Cancelada'};
let visitEditing=null,visitContext=null,visitFormZone=null;
const visitUrl=(propertyId,periodId,applicantId)=>`/api/properties/${encodeURIComponent(propertyId)}/periods/${encodeURIComponent(periodId)}/applicants/${encodeURIComponent(applicantId)}/visits`;
const localVisitValue=(value,timezone=viewZone)=>{const parts=localDateTimeParts(value,timezone);return `${parts.date}T${parts.time}`;};
const visitWhen=(value,timezone=viewZone)=>new Intl.DateTimeFormat('es-ES',{timeZone:timezone,weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const offsetLabel=minutes=>`UTC${minutes<0?'-':'+'}${String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')}:${String(Math.abs(minutes)%60).padStart(2,'0')}`;
function updateVisitOffsets(preferredInstant=null){
 const form=el('visitForm'),local=form.elements.startLocal.value,timezone=form.elements.timezone.value;
 let candidates=[];try{if(local)candidates=localTimeCandidates(local,timezone);}catch{}
 const select=form.elements.utcOffsetMinutes,previous=select.value;
 el('visitOffsetLabel').hidden=candidates.length<2;
 select.replaceChildren(...candidates.map((candidate,index)=>new Option(`${index===0?'Primera':'Segunda'} ocurrencia (${offsetLabel(candidate.utcOffsetMinutes)})`,String(candidate.utcOffsetMinutes))));
 const matching=candidates.find(candidate=>candidate.instant===preferredInstant);
 if(matching)select.value=String(matching.utcOffsetMinutes);
 else if(candidates.some(candidate=>String(candidate.utcOffsetMinutes)===previous))select.value=previous;
 return candidates;
}
let visitPreviewKey=null,visitPreviewRows=null,visitPreviewMargin=0,visitPreviewPending=false,visitPreviewGeneration=0;
const blockingVisit=visit=>visit.status==='pending_confirmation'||visit.status==='confirmed';
function visitPreviewCandidate(){
 const fields=el('visitForm').elements;
 let candidates=[];try{candidates=localTimeCandidates(fields.startLocal.value,fields.timezone.value);}catch{}
 const selected=candidates.length===1?candidates[0]:
  candidates.find(item=>String(item.utcOffsetMinutes)===fields.utcOffsetMinutes.value);
 const duration=Number(fields.durationMinutes.value);
 if(!selected||!Number.isInteger(duration)||duration<5||duration>480||!blockingVisit({status:fields.status.value}))return null;
 const start=Date.parse(selected.instant);
 return {start,end:start+duration*60000};
}
function renderVisitPreview(){
 const form=el('visitForm'),day=form.elements.startLocal.value.slice(0,10),timezone=form.elements.timezone.value;
 const container=el('visitAgendaPreview'),state=el('visitAgendaState'),warning=el('visitPreviewConflict');
 container.replaceChildren();warning.textContent='';
 if(!visitPreviewRows)return;
 const candidate=visitPreviewCandidate(),bounds=civilDayBounds(day,timezone),margin=visitPreviewMargin*60000;
 const active=visitPreviewRows.filter(visit=>blockingVisit(visit)&&visit.id!==visitEditing?.id);
 const overlap=visit=>Date.parse(visit.startsAt)<candidate.end&&Date.parse(visit.endsAt)>candidate.start;
 const collision=visit=>candidate&&(visit.propertyId===visitContext.propertyId?overlap(visit):
  Date.parse(visit.startsAt)<candidate.end+margin&&Date.parse(visit.endsAt)>candidate.start-margin);
 const onDay=visit=>bounds.startsAt<bounds.endsAt&&visit.startsAt<bounds.endsAt&&visit.endsAt>bounds.startsAt;
 const displayed=active.filter(visit=>onDay(visit)||collision(visit));
 const time=new Intl.DateTimeFormat('es-ES',{timeZone:timezone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
 for(const visit of displayed){
  const conflict=collision(visit),travel=conflict&&!overlap(visit);
  const row=node('div',undefined,`visit-preview-blocker${conflict?travel?' is-travel-margin':' is-conflict':''}`);
  row.dataset.visitId=visit.id;
  row.append(node('strong',visit.propertyTitle),node('p',`${time.format(new Date(visit.startsAt))} – ${time.format(new Date(visit.endsAt))}`,'visit-preview-time'),
   node('span',visitStatus[visit.status]||visit.status,'visit-status'));
  if(!onDay(visit))row.append(node('p','Cita cercana fuera de este día','visit-preview-nearby'));
  if(travel)row.append(node('p',`Coincide con el margen de ${visitPreviewMargin} min entre viviendas`,'visit-preview-nearby'));
  container.append(row);
 }
 const dayCount=active.filter(onDay).length;
 state.textContent=dayCount?`${dayCount} ${dayCount===1?'cita':'citas'} en este día.`:'No hay otras citas en este día.';
 if(!candidate){warning.textContent='Elige una fecha y hora válidas para comprobar coincidencias.';return;}
 const conflicts=active.filter(collision),overlaps=conflicts.filter(overlap).length,travel=conflicts.length-overlaps;
 warning.textContent=conflicts.length?`${overlaps?`${overlaps} ${overlaps===1?'cita coincide':'citas coinciden'} con este horario. `:''}${travel?`${travel} ${travel===1?'cita afecta':'citas afectan'} al margen entre viviendas.`:''}`:
  'Sin coincidencias detectadas. Se comprobará de nuevo al guardar.';
}
function refreshVisitPreview(){
 if(!el('visitDialog').open)return;
 const fields=el('visitForm').elements,timezone=fields.timezone.value,day=fields.startLocal.value.slice(0,10);
 el('visitAgendaZone').textContent=day&&timezone?`${day} · ${timezone}`:timezone;
 let from,to;try{from=addCivilDays(day,-1);to=addCivilDays(day,1);}catch{}
 if(!from||!to){visitPreviewGeneration++;visitPreviewKey=null;visitPreviewRows=null;visitPreviewPending=false;
  el('visitAgendaPreview').replaceChildren();el('visitAgendaState').textContent='Elige una fecha válida para ver las citas.';
  el('visitPreviewConflict').textContent='';el('visitTravelMargin').textContent='';return;}
 const key=`${day}|${timezone}`;
 if(key===visitPreviewKey){if(visitPreviewRows){renderVisitPreview();return;}if(visitPreviewPending)return;}
 visitPreviewKey=key;visitPreviewRows=null;visitPreviewPending=true;
 const generation=++visitPreviewGeneration;
 el('visitAgendaPreview').replaceChildren();el('visitAgendaState').textContent='Cargando citas de todas las viviendas…';
 el('visitPreviewConflict').textContent='';el('visitTravelMargin').textContent='Comprobando margen entre viviendas…';
 const query=new URLSearchParams({from,to,timezone});
 Promise.all([api(`/api/visits?${query}`),api('/api/calendar/settings')]).then(([result,settings])=>{
  if(!el('visitDialog').open||generation!==visitPreviewGeneration||key!==visitPreviewKey)return;
  visitPreviewPending=false;visitPreviewRows=result.visits||[];visitPreviewMargin=settings.travelBufferMinutes;
  el('visitTravelMargin').textContent=`Margen entre viviendas: ${visitPreviewMargin} min.`;
  renderVisitPreview();
 }).catch(error=>{
  if(!el('visitDialog').open||generation!==visitPreviewGeneration||key!==visitPreviewKey)return;
  visitPreviewPending=false;visitPreviewRows=null;el('visitAgendaPreview').replaceChildren();
  el('visitAgendaState').textContent=`No se pudieron consultar las citas: ${error.message}`;
  el('visitPreviewConflict').textContent='La disponibilidad no está comprobada. Se verificará al guardar.';
  el('visitTravelMargin').textContent='Margen no disponible.';
 });
}
function openVisitDialog(context,visit=null){
 if(!context.editable)return;
 visitContext=context;visitEditing=visit;
 const form=el('visitForm'),timezone=visit?.timezone||viewZone;
 form.reset();zoneOptions(el('visitTimezone'),timezone);visitFormZone=timezone;
 form.querySelector('.form-error').textContent='';
 el('visitDialogTitle').textContent=visit?'Reprogramar visita':'Programar visita';
 el('visitDialogContext').textContent=`${context.name} · ${context.propertyTitle} · ${timezone}`;
 form.elements.startLocal.value=visit?localVisitValue(visit.startsAt,timezone):`${todayInZone(timezone)}T10:00`;
 form.elements.durationMinutes.value=String(visit?.durationMinutes||30);
 form.elements.status.value=visit?.status==='confirmed'?'confirmed':'pending_confirmation';
 el('visitCancel').hidden=!visit;
 updateVisitOffsets(visit?.startsAt);
 el('visitDialog').showModal();
 visitPreviewKey=null;visitPreviewRows=null;visitPreviewPending=false;refreshVisitPreview();
}
async function renderApplicantVisits(item,id,body,context){if(!context.propertyId||!context.periodId)return;const section=node('section',undefined,'applicant-visits');section.append(node('h3','Visitas','detail-label'));const list=node('div',undefined,'visit-list');section.append(list);if(context.editable)section.append(actionButton('Programar visita','Programar visita',()=>openVisitDialog({...context,name:item.name,propertyTitle:property?.title||''})));
 body.append(section);try{const result=await api(visitUrl(context.propertyId,context.periodId,item.applicant_id||id));if(currentDetail!==id||!el('detail').open)return;const visits=result.visits||[];if(!visits.length)list.append(node('p','Aún no hay visitas programadas.','integrity'));for(const visit of visits){const row=node('div',undefined,'visit-row');const description=node('div');description.append(node('strong',`${visitWhen(visit.startsAt,viewZone)} (${viewZone})`),node('span',visitStatus[visit.status]||visit.status,'visit-status'));row.append(description);if(context.editable&&visit.status!=='cancelled'&&visit.status!=='completed'){const actions=node('div');actions.append(actionButton('Editar',`Editar visita del ${visitWhen(visit.startsAt,viewZone)}`,()=>openVisitDialog({...context,name:item.name,propertyTitle:property?.title||''},visit)),actionButton('Realizada',`Marcar realizada la visita del ${visitWhen(visit.startsAt,viewZone)}`,async()=>{await api(`/api/visits/${encodeURIComponent(visit.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'completed'})});detail(id);toast('Visita marcada como realizada.');}));row.append(actions);}list.append(row);}}catch(e){list.append(node('p',e.message,'integrity'));}}
el('visitForm').elements.startLocal.oninput=()=>updateVisitOffsets();
el('visitDialog').addEventListener('close',()=>{visitPreviewGeneration++;visitPreviewKey=null;visitPreviewRows=null;visitPreviewPending=false;});
el('visitForm').addEventListener('input',event=>{if(event.target!==el('visitTimezone'))refreshVisitPreview();});
el('visitForm').addEventListener('change',event=>{if(event.target!==el('visitTimezone'))refreshVisitPreview();});
el('visitTimezone').onchange=()=>{
 const form=el('visitForm'),newZone=form.elements.timezone.value,oldZone=visitFormZone;
 let instant=null;
 try{
  const candidates=localTimeCandidates(form.elements.startLocal.value,oldZone);
  instant=candidates.find(item=>String(item.utcOffsetMinutes)===form.elements.utcOffsetMinutes.value)?.instant||
    (candidates.length===1?candidates[0].instant:null);
 }catch{}
 visitFormZone=newZone;
 if(instant)form.elements.startLocal.value=localVisitValue(instant,newZone);
 else form.elements.startLocal.value='';
 updateVisitOffsets(instant);
 el('visitDialogContext').textContent=`${visitContext.name} · ${visitContext.propertyTitle} · ${newZone}`;
 form.querySelector('.form-error').textContent=instant?'':'Elige una fecha y hora válida para esta zona.';
 refreshVisitPreview();
};
el('visitCancel').onclick=async()=>{if(!visitEditing)return;try{await api(`/api/visits/${encodeURIComponent(visitEditing.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'cancelled'})});el('visitDialog').close();if(currentDetail)detail(currentDetail);toast('Visita cancelada.');}catch(e){el('visitForm').querySelector('.form-error').textContent=e.message;}};
async function saveVisitPayload(payload){
 const url=visitEditing?`/api/visits/${encodeURIComponent(visitEditing.id)}`:
  visitUrl(visitContext.propertyId,visitContext.periodId,visitContext.applicantId);
 await api(url,{method:visitEditing?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 el('visitDialog').close();
 if(currentDetail)detail(currentDetail);
 toast('Visita guardada.');
}
function showVisitConflict(error,payload){
 if(!el('visitDialog').open||!visitFormStillMatches(payload))return;
 const message=el('visitForm').querySelector('.form-error'),timezone=payload.timezone;
 message.textContent=`${error.message}. ${error.conflicts.map(conflict=>`${conflict.propertyTitle} · ${visitWhen(conflict.startsAt,timezone)} (${timezone})`).join(' · ')}`;
 const override=actionButton('Guardar de todos modos','Guardar de todos modos',async button=>{
  button.disabled=true;
  try{await saveVisitPayload({...payload,acknowledgeConflicts:error.conflictFingerprint});}
  catch(retryError){
   if(!el('visitDialog').open||!visitFormStillMatches(payload))return;
   if(retryError.code==='VISIT_CONFLICT')showVisitConflict(retryError,payload);
   else message.textContent=retryError.message;
  }
 });
 message.append(document.createElement('br'),override);
}
function visitFormStillMatches(payload){
 const fields=el('visitForm').elements;
 return fields.startLocal.value===payload.startLocal&&fields.timezone.value===payload.timezone&&
  Number(fields.durationMinutes.value)===payload.durationMinutes&&fields.status.value===payload.status&&
  Number(fields.utcOffsetMinutes.value)===payload.utcOffsetMinutes;
}
function clearVisitConflict(event){
 if(['startLocal','timezone','durationMinutes','status','utcOffsetMinutes'].includes(event.target.name))
  el('visitForm').querySelector('.form-error').replaceChildren();
}
el('visitForm').addEventListener('input',clearVisitConflict);
el('visitForm').addEventListener('change',clearVisitConflict);
el('visitForm').onsubmit=async event=>{
 event.preventDefault();if(!visitContext)return;
 const form=event.currentTarget,button=el('visitSubmit'),message=form.querySelector('.form-error');
 message.textContent='';
 const timezone=form.elements.timezone.value,startLocal=form.elements.startLocal.value;
 let candidates=[];try{candidates=localTimeCandidates(startLocal,timezone);}catch{}
 if(!candidates.length){message.textContent='Esta fecha y hora no existe en la zona elegida.';return;}
 const selected=candidates.length===1?candidates[0]:
  candidates.find(candidate=>String(candidate.utcOffsetMinutes)===form.elements.utcOffsetMinutes.value);
 if(!selected){message.textContent='Elige una de las dos ocurrencias de esta hora.';return;}
 const payload={startLocal,timezone,utcOffsetMinutes:selected.utcOffsetMinutes,
  durationMinutes:Number(form.elements.durationMinutes.value),status:form.elements.status.value};
 button.disabled=true;
 try{await saveVisitPayload(payload);}
 catch(error){
  if(error.code==='VISIT_CONFLICT'){
   if(visitFormStillMatches(payload))showVisitConflict(error,payload);
   else message.textContent='El formulario cambió. Vuelve a guardar para revisar el horario actual.';
  }else message.textContent=error.message;
 }
 finally{button.disabled=false;}
};
function reviewClose(item){if(!periodsReady||!canEditPeriod())return;closingApplicant={id:item.applicant_id||item.conversation_id,name:item.name,propertyId:selectedPropertyId,periodId:selectedPeriodId};el('closePeriodReview').textContent=`Vas a elegir a ${item.name} para la búsqueda que comenzó el ${periodDate(activePeriod().rentalSince)}.`;el('closePeriodForm').querySelector('.form-error').textContent='';el('closePeriodDialog').showModal();}
el('closePeriodForm').onsubmit=async event=>{event.preventDefault();const selected=closingApplicant,form=event.currentTarget,button=form.querySelector('.sync-button'),errorNode=form.querySelector('.form-error');if(!selected||selected.propertyId!==selectedPropertyId||selected.periodId!==selectedPeriodId||!canEditPeriod())return;button.disabled=true;errorNode.textContent='';try{const result=await api(`${periodBase()}/close`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chosenApplicantId:selected.id})});if(selected.propertyId!==selectedPropertyId||selected.periodId!==selectedPeriodId)return;const index=periods.findIndex(p=>p.id===result.period.id);if(index!==-1)periods[index]=result.period;el('closePeriodDialog').close();if(el('detail').open)el('detail').close();renderPeriod();renderItems();toast('Búsqueda cerrada. Se conserva en el histórico.');}catch(e){if(selected.propertyId===selectedPropertyId&&selected.periodId===selectedPeriodId)errorNode.textContent=e.message;}finally{button.disabled=false;}};
function switchPeriod(id){if(!periods.some(p=>p.id===id))return;periodGeneration++;selectedPeriodId=id;requestId++;detailRequestId++;currentDetail=null;if(el('detail').open)el('detail').close();for(const dialogId of ['applicantDialog','periodDialog','closePeriodDialog','reopenPeriodDialog'])if(el(dialogId).open)el(dialogId).close();datesInitialized=false;el('filters').reset();syncCompletedId=null;syncStatusUnavailable=false;syncModeReady=false;renderPeriod();load();refreshIncomeBounds();checkSync();}
el('periodSelect').onchange=()=>switchPeriod(el('periodSelect').value);
el('reopenPeriod').onclick=()=>{
 if(!canReopenPeriod())return;
 const period=activePeriod();reopeningPeriod={propertyId:selectedPropertyId,periodId:period.id};
 el('reopenPeriodReview').textContent=`Vas a reabrir la búsqueda que comenzó el ${periodDate(period.rentalSince)}${period.chosenApplicantName?` y retirar la elección de ${period.chosenApplicantName}`:''}.`;
 el('reopenPeriodForm').querySelector('.form-error').textContent='';el('reopenPeriodDialog').showModal();
};
el('reopenPeriodForm').onsubmit=async event=>{
 event.preventDefault();const selected=reopeningPeriod,form=event.currentTarget,button=form.querySelector('.sync-button'),message=form.querySelector('.form-error');
 if(!selected||selected.propertyId!==selectedPropertyId||selected.periodId!==selectedPeriodId||!canReopenPeriod())return;
 button.disabled=true;message.textContent='';
 try{
  const result=await api(`${periodBase()}/reopen`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  if(selected.propertyId!==selectedPropertyId||selected.periodId!==selectedPeriodId)return;
  const index=periods.findIndex(p=>p.id===result.period.id);if(index!==-1)periods[index]=result.period;
  el('reopenPeriodDialog').close();switchPeriod(result.period.id);await loadProperty();
  if(selected.propertyId===selectedPropertyId&&selected.periodId===selectedPeriodId)toast('Búsqueda reabierta. Se conservan los interesados y sus conversaciones.');
 }catch(e){if(selected.propertyId===selectedPropertyId&&selected.periodId===selectedPeriodId)message.textContent=e.message;}
 finally{button.disabled=false;}
};
el('newPeriod').onclick=()=>{if(!periodsReady||periods.some(p=>p.status==='open'))return;periodFormMode='create';const form=el('periodForm'),latest=periods[0];form.reset();form.querySelector('.form-error').textContent='';form.elements.rentalSince.value=madridToday();form.elements.monthlyRent.value=latest?.monthlyRentCents==null?'':String(latest.monthlyRentCents/100);form.elements.idealistaUrl.value=property?.canEditIdealistaUrl===true?(property.defaultIdealistaUrl||''):(latest?.url||'');el('periodFormTitle').textContent='Nueva búsqueda';el('periodFormHelp').textContent='La nueva búsqueda empieza sin interesados. Puedes ajustar el alquiler y reutilizar o cambiar el anuncio.';el('periodSubmit').textContent='Crear búsqueda';el('periodDialog').showModal();};
el('editPeriod').onclick=()=>{const period=activePeriod();if(!period||period.status!=='open')return;periodFormMode='edit';const form=el('periodForm');form.reset();form.querySelector('.form-error').textContent='';form.elements.rentalSince.value=period.rentalSince;form.elements.monthlyRent.value=String(period.monthlyRentCents/100);form.elements.idealistaUrl.value=period.url||'';el('periodFormTitle').textContent='Editar búsqueda';el('periodFormHelp').textContent='Cambia la fecha, el alquiler o el enlace de esta búsqueda activa.';el('periodSubmit').textContent='Guardar búsqueda';el('periodDialog').showModal();};
el('periodForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,data=new FormData(form),errorNode=form.querySelector('.form-error'),editing=periodFormMode==='edit',propertyAtStart=selectedPropertyId,periodAtStart=selectedPeriodId,button=el('periodSubmit');errorNode.textContent='';const payload={rentalSince:data.get('rentalSince'),monthlyRentCents:Math.round(Number(data.get('monthlyRent'))*100),idealistaUrl:data.get('idealistaUrl')||null};button.disabled=true;try{const result=await api(editing?periodBase():`${propertyBase()}/periods`,{method:editing?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(propertyAtStart!==selectedPropertyId||periodAtStart!==selectedPeriodId)return;if(editing){const index=periods.findIndex(p=>p.id===result.period.id);if(index!==-1)periods[index]=result.period;renderPeriod();await loadProperty();}else{periods.unshift(result.period);switchPeriod(result.period.id);}form.reset();if(el('periodDialog').open)el('periodDialog').close();}catch(e){if(propertyAtStart===selectedPropertyId&&periodAtStart===selectedPeriodId)errorNode.textContent=e.message;}finally{button.disabled=false;}};
function closeDetail(){const dialog=el('detail');if(dialog.open)dialog.close();}
const detailDialog=el('detail');el('close').onclick=closeDetail;detailDialog.addEventListener('cancel',event=>{event.preventDefault();closeDetail();});detailDialog.addEventListener('click',event=>{if(event.target!==detailDialog)return;const rect=detailDialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDetail();});detailDialog.addEventListener('close',()=>{currentDetail=null;detailRequestId++;});
for(const button of document.querySelectorAll('[data-status]'))button.onclick=()=>{status=button.dataset.status;load();};
for(const button of document.querySelectorAll('.sort-button'))button.onclick=()=>{const key=button.dataset.sort;sort=sort?.key===key?{key,direction:sort.direction==='asc'?'desc':'asc'}:{key,direction:'asc'};renderItems();};
el('filters').onsubmit=e=>e.preventDefault();
for(const id of ['incomeMin','incomeMax'])el(id).addEventListener('input',()=>{const min=Number(el('incomeMin').value),max=Number(el('incomeMax').value);if(min>max){if(id==='incomeMin')el('incomeMax').value=String(min);else el('incomeMin').value=String(max);}renderIncomeValues();clearTimeout(debounce);debounce=setTimeout(load,200);});
el('filters').oninput=event=>{if(['incomeMin','incomeMax'].includes(event.target.id))return;clearTimeout(debounce);debounce=setTimeout(load,200);};
el('filters').onreset=()=>{clearTimeout(debounce);setTimeout(()=>{el('incomeMin').value='0';el('incomeMax').value=String(incomeCeiling);renderIncomeValues();load();},0);};
el('propertySelect').onchange=async()=>{selectedPropertyId=el('propertySelect').value;const id=selectedPropertyId;periodGeneration++;property=null;periods=[];selectedPeriodId=null;requestId++;detailRequestId++;currentDetail=null;if(el('detail').open)el('detail').close();for(const dialogId of ['applicantDialog','periodDialog','closePeriodDialog','reopenPeriodDialog','propertyDialog'])if(el(dialogId).open)el(dialogId).close();datesInitialized=false;el('filters').reset();syncModeReady=false;updateIncomeBounds();renderSync();await loadProperty();if(id!==selectedPropertyId)return;await loadPeriods();if(id!==selectedPropertyId)return;load();refreshIncomeBounds();checkSync();};
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>el(button.dataset.close).close();
function openAddProperty(){propertyFormMode='create';const form=el('newPropertyForm');form.reset();form.querySelector('.form-error').textContent='';form.elements.rentalSince.value=madridToday();form.elements.idealistaUrl.readOnly=false;for(const name of ['monthlyRent','rentalSince','idealistaUrl'])form.elements[name].closest('label').hidden=false;el('propertyUrlHelp').hidden=true;el('deleteProperty').hidden=true;el('propertyFormTitle').textContent='Añadir vivienda';el('propertySubmit').textContent='Guardar vivienda';el('propertyDialog').showModal();}
el('addProperty').onclick=openAddProperty;el('homeAddProperty').onclick=openAddProperty;el('homeRetry').onclick=loadHomeProperties;
el('editProperty').onclick=()=>{if(!property)return;propertyFormMode='edit';const form=el('newPropertyForm'),urlEditable=property.canEditIdealistaUrl===true;form.reset();form.querySelector('.form-error').textContent='';form.elements.title.value=property.title;form.elements.address.value=property.address??'';form.elements.monthlyRent.value=property.monthlyRentCents===null?'':String(property.monthlyRentCents/100);form.elements.rentalSince.value=property.rentalSince??'';form.elements.idealistaUrl.value=urlEditable?property.defaultIdealistaUrl??'':property.url??'';form.elements.idealistaUrl.readOnly=!urlEditable&&!!property.idealistaId;for(const name of ['monthlyRent','rentalSince'])form.elements[name].closest('label').hidden=periodsReady;form.elements.idealistaUrl.closest('label').hidden=periodsReady&&!urlEditable;el('propertyUrlHelp').hidden=!urlEditable&&!property.idealistaId;el('propertyUrlHelp').textContent=urlEditable?'El enlace se guarda para futuras búsquedas y para la búsqueda activa. El histórico cerrado conserva su anuncio. Déjalo vacío para quitarlo.':'El anuncio vinculado a esta vivienda no se puede cambiar aquí.';el('deleteProperty').hidden=property.canDeleteProperty!==true;el('propertyFormTitle').textContent='Editar vivienda';el('propertySubmit').textContent='Guardar cambios';el('propertyDialog').showModal();};
let pendingDeletePropertyId=null;
el('deleteProperty').onclick=()=>{if(property?.canDeleteProperty!==true)return;pendingDeletePropertyId=selectedPropertyId;el('deletePropertyReview').textContent=`Vas a eliminar ${property.title}.`;el('deletePropertyForm').querySelector('.form-error').textContent='';el('deletePropertyDialog').showModal();};
el('deletePropertyForm').onsubmit=async event=>{event.preventDefault();const id=pendingDeletePropertyId,button=el('confirmDeleteProperty'),errorNode=event.currentTarget.querySelector('.form-error');if(!id||id!==selectedPropertyId||property?.canDeleteProperty!==true)return;button.disabled=true;errorNode.textContent='';try{await api(`/api/properties/${encodeURIComponent(id)}`,{method:'DELETE'});location.assign('/');}catch(e){errorNode.textContent=e.message;button.disabled=false;}};
el('newPropertyForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,data=new FormData(form),errorNode=form.querySelector('.form-error'),editing=propertyFormMode==='edit',propertyAtStart=selectedPropertyId,urlEditable=property?.canEditIdealistaUrl===true,previousUrl=property?.defaultIdealistaUrl??null,button=el('propertySubmit');errorNode.textContent='';const payload={title:data.get('title')};if(editing){payload.address=data.get('address')||null;if(urlEditable)payload.idealistaUrl=data.get('idealistaUrl')||null;if(!periodsReady){payload.rentalSince=data.get('rentalSince');payload.monthlyRentCents=data.get('monthlyRent')===''?null:Math.round(Number(data.get('monthlyRent'))*100);if(!urlEditable&&!property?.idealistaId&&data.get('idealistaUrl'))payload.idealistaUrl=data.get('idealistaUrl');}}else{payload.rentalSince=data.get('rentalSince');if(data.get('address'))payload.address=data.get('address');if(data.get('idealistaUrl'))payload.idealistaUrl=data.get('idealistaUrl');if(data.get('monthlyRent')!=='')payload.monthlyRentCents=Math.round(Number(data.get('monthlyRent'))*100);}button.disabled=true;try{const result=await api(editing?`/api/properties/${encodeURIComponent(propertyAtStart)}`:'/api/properties',{method:editing?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(editing&&propertyAtStart!==selectedPropertyId)return;form.reset();el('propertyDialog').close();if(editing){const index=properties.findIndex(p=>p.id===result.property.id);if(index!==-1)properties[index]=result.property;const option=[...el('propertySelect').options].find(o=>o.value===result.property.id);if(option)option.textContent=result.property.title;if(propertyAtStart===selectedPropertyId){await loadProperty();if(urlEditable&&previousUrl!==payload.idealistaUrl)await loadPeriods(selectedPeriodId);}}else if(isHome){location.assign(housingUrl(result.property.id));}else{properties.push(result.property);el('propertySelect').append(new Option(result.property.title,result.property.id));el('propertySelect').value=result.property.id;el('propertySelect').dispatchEvent(new Event('change'));}}catch(e){errorNode.textContent=e.message;}finally{button.disabled=false;}};
el('addApplicant').onclick=()=>{if(canEditPeriod())el('applicantDialog').showModal();};
el('newApplicantForm').onsubmit=async event=>{event.preventDefault();if(!canEditPeriod())return;const form=event.currentTarget,data=new FormData(form),errorNode=form.querySelector('.form-error'),propertyAtStart=selectedPropertyId,periodAtStart=selectedPeriodId,base=applicantBase(),button=form.querySelector('.sync-button');errorNode.textContent='';const tri=value=>value==='unknown'?null:value==='1';const payload={name:data.get('name'),hasChildren:tri(data.get('hasChildren')),hasPets:tri(data.get('hasPets')),incomeScope:data.get('incomeScope')==='unknown'?null:data.get('incomeScope')};for(const key of ['phone','email','notes'])if(data.get(key))payload[key]=data.get(key);if(data.get('peopleCount'))payload.peopleCount=Number(data.get('peopleCount'));if(data.get('monthlyIncome'))payload.monthlyIncomeCents=Math.round(Number(data.get('monthlyIncome'))*100);button.disabled=true;try{await api(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(propertyAtStart!==selectedPropertyId||periodAtStart!==selectedPeriodId)return;form.reset();el('applicantDialog').close();el('filters').reset();load();refreshIncomeBounds();}catch(e){if(propertyAtStart===selectedPropertyId&&periodAtStart===selectedPeriodId)errorNode.textContent=e.message;}finally{button.disabled=false;}};
let calendarMonth=todayInZone(viewZone).slice(0,8)+'01',calendarDay=todayInZone(viewZone),calendarVisits=[],calendarRequest=0;
const civilDate=(year,month,day)=>new Date(Date.UTC(year,month-1,day)).toISOString().slice(0,10);
const civilParts=value=>value.split('-').map(Number);
const monthBounds=value=>{const [year,month]=civilParts(value),end=new Date(Date.UTC(year,month,0)).getUTCDate();return {from:value.slice(0,8)+'01',to:civilDate(year,month,end)};};
const civilMonthName=value=>new Intl.DateTimeFormat('es-ES',{timeZone:'UTC',month:'long',year:'numeric'}).format(new Date(value+'T12:00:00Z'));
const civilDayName=value=>new Intl.DateTimeFormat('es-ES',{timeZone:'UTC',weekday:'long',day:'numeric',month:'long'}).format(new Date(value+'T12:00:00Z'));
const dayBoundsCache=new Map();
function dayBounds(day){
 const key=viewZone+':'+day;
 if(!dayBoundsCache.has(key))dayBoundsCache.set(key,civilDayBounds(day,viewZone));
 return dayBoundsCache.get(key);
}
function calendarQuery(halo=0){
 const bounds=monthBounds(calendarMonth);
 return new URLSearchParams({from:addCivilDays(bounds.from,-halo),to:addCivilDays(bounds.to,halo),timezone:viewZone});
}
function calendarVisible(){
 const propertyId=el('calendarProperty').value,statusValue=el('calendarStatus').value;
 return calendarVisits.filter(visit=>(!propertyId||visit.propertyId===propertyId)&&
  (statusValue==='not_cancelled'?visit.status!=='cancelled':!statusValue||visit.status===statusValue));
}
function visitOnDay(visit,day){
 const bounds=dayBounds(day);
 return bounds.startsAt<bounds.endsAt&&visit.startsAt<bounds.endsAt&&visit.endsAt>bounds.startsAt;
}
function calendarConflict(visit){
 if(!['pending_confirmation','confirmed'].includes(visit.status))return false;
 const buffer=Number(el('calendarBuffer').value)||0,from=Date.parse(visit.startsAt),until=Date.parse(visit.endsAt);
 return calendarVisits.some(other=>other.id!==visit.id&&['pending_confirmation','confirmed'].includes(other.status)&&
  Date.parse(other.startsAt)<until+(other.propertyId===visit.propertyId?0:buffer)*60000&&
  Date.parse(other.endsAt)>from-(other.propertyId===visit.propertyId?0:buffer)*60000);
}
function renderAgenda(){
 const selected=calendarVisible().filter(visit=>visitOnDay(visit,calendarDay))
  .sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt));
 el('agendaTitle').textContent=`Agenda · ${civilDayName(calendarDay)} · ${viewZone}`;
 const container=el('agendaItems');container.replaceChildren();
 if(!selected.length){container.append(node('p','No hay visitas este día.','integrity'));return;}
 const clockFormat=new Intl.DateTimeFormat('es-ES',{timeZone:viewZone,hour:'2-digit',minute:'2-digit'});
 const dateFormat=new Intl.DateTimeFormat('es-ES',{timeZone:viewZone,day:'numeric',month:'short'});
 for(const visit of selected){
  const startsDay=localDateTimeParts(visit.startsAt,viewZone).date,clock=clockFormat.format(new Date(visit.startsAt));
  const timeText=startsDay===calendarDay?clock:`${dateFormat.format(new Date(visit.startsAt))} · ${clock} (en curso)`;
  const card=node('article',undefined,`agenda-visit${visit.status==='confirmed'?' is-confirmed':''}${calendarConflict(visit)?' has-conflict':''}`);
  const name=node('a',visit.applicantName);
  name.href=`/?${new URLSearchParams({propertyId:visit.propertyId,periodId:visit.periodId,applicantId:visit.applicantId})}`;
  card.append(node('p',timeText,'agenda-time'),node('h3',visit.propertyTitle),name,
   node('p',visitStatus[visit.status]||visit.status,'visit-status'));
  if(calendarConflict(visit))card.append(node('p','Coincide con otra visita','conflict-note'));
  const exportLink=node('a','Descargar .ics','visit-export');
  exportLink.href=`/api/visits/${encodeURIComponent(visit.id)}.ics`;exportLink.download='visita.ics';
  card.append(exportLink);container.append(card);
 }
}
function renderCalendar(){
 const visible=calendarVisible(),bounds=monthBounds(calendarMonth),[year,month]=civilParts(calendarMonth);
 const monthEnd=new Date(Date.UTC(year,month,0)).getUTCDate();
 const leading=(new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7,days=el('calendarDays');
 el('calendarMonth').textContent=civilMonthName(calendarMonth);days.replaceChildren();
 for(let i=0;i<leading;i++)days.append(node('div',undefined,'calendar-day muted-day'));
 const clock=new Intl.DateTimeFormat('es-ES',{timeZone:viewZone,hour:'2-digit',minute:'2-digit'});
 for(let number=1;number<=monthEnd;number++){
  const value=civilDate(year,month,number),button=node('button',undefined,
   `calendar-day${value===calendarDay?' selected':''}`);
  button.type='button';button.setAttribute('aria-label',`${number} de ${el('calendarMonth').textContent}`);
  button.append(node('span',String(number),'calendar-date'));
  const events=visible.filter(visit=>visitOnDay(visit,value));
  for(const visit of events.slice(0,3)){
   const tag=node('span',`${clock.format(new Date(visit.startsAt))} ${visit.propertyTitle}`,
    `calendar-event${visit.status==='confirmed'?' is-confirmed':''}`);
   if(calendarConflict(visit))tag.classList.add('has-conflict');
   button.append(tag);
  }
  if(events.length>3)button.append(node('span',`+${events.length-3} más`,'calendar-more'));
  button.onclick=()=>{calendarDay=value;renderCalendar();};days.append(button);
 }
 const exportQuery=calendarQuery();
 if(el('calendarProperty').value)exportQuery.set('propertyId',el('calendarProperty').value);
 if(el('calendarStatus').value)exportQuery.set('status',el('calendarStatus').value);
 el('calendarExport').href=`/api/visits.ics?${exportQuery}`;
 el('calendarExport').download=`visitas-${bounds.from}-${bounds.to}.ics`;
 renderAgenda();
}
async function loadCalendar(){
 const request=++calendarRequest,query=calendarQuery(1);
 el('calendarError').hidden=true;
 try{
  const result=await api(`/api/visits?${query}`);
  if(request!==calendarRequest)return;
  calendarVisits=result.visits||[];dayBoundsCache.clear();renderCalendar();
 }catch(error){
  if(request!==calendarRequest)return;
  el('calendarError').textContent=error.message;el('calendarError').hidden=false;
 }
}
function moveCalendarMonth(amount){
 const [year,month]=civilParts(calendarMonth),next=new Date(Date.UTC(year,month-1+amount,1));
 calendarMonth=civilDate(next.getUTCFullYear(),next.getUTCMonth()+1,1);
 calendarDay=monthBounds(calendarMonth).from;loadCalendar();
}
async function initCalendar(){
 document.title='Calendario de visitas · Morada';el('calendarView').hidden=false;
 zoneOptions(el('calendarTimezone'),viewZone);
 el('calendarTimezone').onchange=()=>{
 viewZone=el('calendarTimezone').value;
 try{localStorage.setItem('calendarTimezone',viewZone);}catch{}
  dayBoundsCache.clear();renderCalendar();loadCalendar();
 };
 try{
  const result=await api('/api/properties');
  el('calendarProperty').append(...(result.properties||[]).map(item=>new Option(item.title,item.id)));
 }catch{}
 for(const id of ['calendarProperty','calendarStatus'])el(id).onchange=renderCalendar;
 el('calendarBuffer').onchange=async()=>{
  try{
   const settings=await api('/api/calendar/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({travelBufferMinutes:Number(el('calendarBuffer').value)})});
   el('calendarBuffer').value=String(settings.travelBufferMinutes);
  }catch(error){el('calendarError').textContent=error.message;el('calendarError').hidden=false;}
  renderCalendar();
 };
 try{
  const settings=await api('/api/calendar/settings');
  el('calendarBuffer').value=String(settings.travelBufferMinutes);
 }catch{}
 el('calendarPrevious').onclick=()=>moveCalendarMonth(-1);
 el('calendarNext').onclick=()=>moveCalendarMonth(1);
 el('calendarToday').onclick=()=>{
  calendarMonth=todayInZone(viewZone).slice(0,8)+'01';
  calendarDay=todayInZone(viewZone);loadCalendar();
 };
 loadCalendar();
}
el('refresh').onclick=load;el('sync').onclick=()=>startSync();el('syncFull').onclick=()=>startSync('full');el('sync').disabled=true;el('syncFull').disabled=true;if(isCalendar){initCalendar();}else if(isHome){document.title='Mis viviendas · Morada';el('homeView').hidden=false;loadHomeProperties();}else{el('workspaceView').hidden=false;updateIncomeBounds();loadProperties().then(()=>{if(!multiHousingReady){loadProperty();load();refreshIncomeBounds();checkSync();}});}
