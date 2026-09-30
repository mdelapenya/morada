import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, pause } from './current-chrome.mjs';
import { fingerprintMessageHistory } from './message-history.mjs';
import { legacyProperty, DEFAULT_PROPERTY_ID } from '../app/legacy-property.mjs';

const ROOT = fileURLToPath(new URL('../.local/', import.meta.url));
const PROPERTY = legacyProperty?.listingLabel ?? null;
const sleep = pause;
const isoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0,10) === value;
};
const previousDay = day => new Date(Date.parse(`${day}T00:00:00.000Z`) - 86400000).toISOString().slice(0,10);
const spanishMonths = new Map(['ene','feb','mar','abr','may','jun','jul','ago','sept','oct','nov','dic'].map((name,index)=>[name,index+1]));
export function parseActivityDate(label, browserDay) {
  if (!isoDate(browserDay)) throw new Error('No se pudo determinar la fecha local del navegador.');
  const text = String(label ?? '').trim();
  const time = text.match(/^(\d{1,2}):(\d{2})$/);
  if (time && Number(time[1]) <= 23 && Number(time[2]) <= 59) return browserDay;
  if (/^hoy$/i.test(text)) return browserDay;
  if (/^ayer$/i.test(text)) return previousDay(browserDay);
  const dated = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dated) {
    const day = `${dated[3]}-${dated[2]}-${dated[1]}`;
    if (isoDate(day)) return day;
  }
  const spanish = text.toLocaleLowerCase('es-ES').match(/^(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sept|oct|nov|dic)\.?(?:\s+(\d{4}))?$/);
  if (spanish) {
    const month=String(spanishMonths.get(spanish[2])).padStart(2,'0');
    const date=String(spanish[1]).padStart(2,'0');
    const currentYear=Number(browserDay.slice(0,4));
    for(const year of spanish[3]?[Number(spanish[3])]:[currentYear,currentYear-1]){
      const candidate=`${year}-${month}-${date}`;
      if(isoDate(candidate)&&candidate<=browserDay)return candidate;
    }
  }
  const labelForDiagnosis=text.replace(/\s+/g,' ').slice(0,40);
  throw new Error(`Idealista muestra una fecha de actividad que no se puede interpretar: ${JSON.stringify(labelForDiagnosis)}. Revisa el listado y reintenta.`);
}
const madridParts = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const madridClock = instant => Object.fromEntries(madridParts.formatToParts(new Date(instant)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const validPeriodId = value => typeof value==='string' && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)||/^initial:[A-Za-z0-9_-]{1,100}$/.test(value));
function madridMinute(date,time){
  const match=String(time??'').trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!match||Number(match[1])>23||Number(match[2])>59)return null;
  const target=`${date} ${String(match[1]).padStart(2,'0')}:${match[2]}`;
  const local=Date.parse(`${date}T${String(match[1]).padStart(2,'0')}:${match[2]}:00.000Z`);
  const matches=[];
  for(const offset of [0,1,2]){
    const instant=new Date(local-offset*3600000);
    const parts=madridClock(instant);
    if(`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`===target)matches.push(instant.toISOString());
  }
  return matches.length===1?matches[0]:null;
}
function messageDay(label, referenceDay, latestDay){
  const text=String(label??'').trim();
  const yearless=text.toLocaleLowerCase('es-ES').match(/^(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sept|oct|nov|dic)\.?$/);
  if(!yearless)return parseActivityDate(text,referenceDay);
  const month=String(spanishMonths.get(yearless[2])).padStart(2,'0');
  const day=String(yearless[1]).padStart(2,'0');
  const candidates=[];
  for(let year=Number(referenceDay.slice(0,4));year>=Number(referenceDay.slice(0,4))-2;year--){
    const date=`${year}-${month}-${day}`;
    if(isoDate(date)&&date<=referenceDay&&date<=latestDay&&Date.parse(`${referenceDay}T00:00:00Z`)-Date.parse(`${date}T00:00:00Z`)<366*86400000)candidates.push(date);
  }
  if(candidates.length!==1)throw new Error(`No se puede verificar el año del mensaje con fecha ${JSON.stringify(text.slice(0,40))}. Revisa la conversación en Chrome y reintenta.`);
  return candidates[0];
}
export function resolveMessages(messages, referenceDay, latestDay, referenceAt){
  if(!isoDate(referenceDay)||!isoDate(latestDay))throw new Error('No se pudo determinar la fecha local de los mensajes.');
  const observedAt=referenceAt===undefined?null:Date.parse(referenceAt);
  if(referenceAt!==undefined&&!Number.isFinite(observedAt))throw new Error('No se pudo determinar la hora local de los mensajes.');
  let next=latestDay;
  const resolved=Array(messages.length);
  for(let i=messages.length-1;i>=0;i--){
    const message=messages[i];
    const date=messageDay(message.dateLabel,referenceDay,next);
    if(date>next)throw new Error('Las fechas de los mensajes no siguen el orden de la conversación. Revisa Chrome y reintenta.');
    next=date;
    const occurredAt=madridMinute(date,message.time);
    if(occurredAt&&observedAt!==null&&Date.parse(occurredAt)>observedAt+60000)throw new Error('Un mensaje aparece en el futuro respecto a la lectura del chat. Recarga Idealista y reintenta.');
    resolved[i]={...message,messageDate:date,occurredAt,datePrecision:'day',timePrecision:occurredAt?'minute':'uncertain'};
  }
  return resolved;
}
export function projectPeriodMessages(messages,{sinceDate,untilDate,activityStartsAt,includeLegacyHistory=false}){
  if(includeLegacyHistory)return messages;
  const cutoff=Date.parse(activityStartsAt);
  if(!Number.isFinite(cutoff))throw new Error('El inicio de actividad del periodo no es válido.');
  const localCutoff=madridClock(activityStartsAt);
  const cutoffDay=`${localCutoff.year}-${localCutoff.month}-${localCutoff.day}`;
  const selected=[];
  for(const message of messages){
    if(message.messageDate<sinceDate||message.messageDate>untilDate)continue;
    const instant=message.occurredAt?Date.parse(message.occurredAt):null;
    if(instant===null){
      if(message.messageDate>cutoffDay){selected.push(message);continue;}
      if(message.messageDate<cutoffDay)continue;
      throw new Error('La hora de un mensaje puede coincidir con el inicio de este periodo. Revisa la conversación en Chrome antes de sincronizar.');
    }
    if(instant>cutoff)selected.push(message);
    else if(instant+60000>cutoff)throw new Error('Un mensaje cae en el mismo minuto que el cierre del periodo anterior. No se puede asignar con certeza; revisa la conversación en Chrome.');
  }
  return selected;
}
const expressions = {
  draft: `(()=>({draft:[...document.querySelectorAll('textarea,[contenteditable="true"]')].some(e=>String(e.value??e.innerText??'').trim()),blocked:/Se ha detectado un uso indebido|El acceso se ha bloqueado|demasiadas peticiones/i.test(document.body?.innerText??'')}))()`,
  reload: `(()=>{location.reload();return true})()`,
  ready: `(()=>({ready:!!document.querySelector('ul[class*="conversation-list_"]'),login:!!document.querySelector('input[type="password"]')||/inicia sesión|iniciar sesión/i.test(document.body?.innerText??''),blocked:/Se ha detectado un uso indebido|El acceso se ha bloqueado|demasiadas peticiones/i.test(document.body?.innerText??'')}))()`,
  visibility: `document.visibilityState`,
  selectAll: `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='Todos');if(!b)return false;b.click();return true})()`,
  day: `new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())`,
  closeProfile: `(()=>{document.querySelector('dialog[open] [data-kiwi-modal-header] button')?.click();return true})()`,
  listTop: `(()=>{const list=document.querySelector('ul[class*="conversation-list_"]');if(!list)throw new Error('No hay listado');list.scrollTop=0;return true})()`,
  listStep: `(()=>{const list=document.querySelector('ul[class*="conversation-list_"]');if(!list)throw new Error('No hay listado');list.scrollTop=Math.min(list.scrollHeight,list.scrollTop+Math.max(1,list.clientHeight*0.8));return true})()`,
  cards: `(()=>{const list=document.querySelector('ul[class*="conversation-list_"]');return {referenceDay:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),cards:[...document.querySelectorAll('[data-conversation-id]')].map(e=>({id:e.dataset.conversationId,name:e.querySelector('[class*="card__meta"]>p')?.innerText,date:e.querySelector('[class*="card__date"] p')?.innerText,ad:e.querySelector('[class*="ad__price"]')?.innerText})),loading:!!list&&(!!list.closest('[aria-busy="true"]')||!!list.querySelector('[aria-busy="true"],[role="progressbar"]')||!!list.parentElement?.querySelector('[role="progressbar"]')),scroll:list?{top:list.scrollTop,height:list.clientHeight,total:list.scrollHeight}:null}})()`,
  snapshot: `(()=>{
    const observedAt=new Date();
    const referenceAt=observedAt.toISOString();
    const referenceDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(observedAt);
    const root=document.querySelector('[data-testid="conversation-detail-component"]');if(!root)return null;
    const list=root.querySelector('[class*="messages--container"]');if(!list)return null;
    const name=root.querySelector('[class*="header__user-name"]')?.innerText;let date=null;const messages=[];
    for(const child of list.children){
      if(child.className.includes('chat-day-divider'))date=child.innerText;
      for(const box of child.querySelectorAll('[data-testid="message-container"]')){
        const direction=box.className.includes('is-from-other')?'received':'sent';
        const content=box.querySelector('[class*="message-text__content"]');
        const profile=box.querySelector('[class*="message-profile_"]');
        messages.push({sequence:messages.length+1,dateLabel:date,time:box.querySelector('[class*="message-container__info"]')?.innerText??null,
          author:direction==='received'?name:'Propietario (tu cuenta)',direction,text:content?.innerText??null,
          embeddedProfile:profile?{text:profile.innerText,fields:[...profile.querySelectorAll('li')].map(e=>e.innerText)}:null,
          rawText:box.innerText,attachments:[...box.querySelectorAll('a[href]')].filter(a=>!a.getAttribute('href').startsWith('/inmueble/')).map(a=>({text:a.innerText,url:a.href})),
          media:[...box.querySelectorAll('img,video,audio')].filter(e=>!e.closest('a[href^="/inmueble/"]')).map(e=>({tag:e.tagName,alt:e.getAttribute('alt')})),domClass:box.className});
      }
    }
    return {referenceDay,referenceAt,activeId:document.querySelector('[data-conversation-id]:has([aria-current="true"])')?.dataset.conversationId,
      name,messages,historyText:list.innerText,properties:[...list.querySelectorAll('a[href^="/inmueble/"]')].map(a=>({url:a.href,text:a.innerText})),
      scroll:{top:list.scrollTop,height:list.clientHeight,total:list.scrollHeight},historyButtons:[...list.querySelectorAll('button')].map(b=>({text:b.innerText,label:b.getAttribute('aria-label')})),
      profileAvailable:[...root.querySelectorAll('button')].some(b=>b.innerText==='Ver perfil')};
  })()`,
  historyTop: `(()=>{const c=document.querySelector('[class*="messages--container"]');if(!c)throw new Error('Sin historial');c.scrollTop=0;return true})()`,
  historyBottom: `(()=>{const c=document.querySelector('[class*="messages--container"]');if(!c)throw new Error('Sin historial');c.scrollTop=c.scrollHeight;return true})()`,
  openProfile: `(()=>{[...document.querySelectorAll('[data-testid="conversation-detail-component"] button')].find(e=>e.innerText==='Ver perfil').click();return true})()`,
  profile: `(()=>{const d=document.querySelector('dialog[open]');if(!d)return null;return {title:d.querySelector('h2')?.innerText,text:d.innerText,fields:[...d.querySelectorAll('li')].map(e=>e.innerText),paragraphs:[...d.querySelectorAll('[class*="profile-modal__profile_"]>p')].map(e=>e.textContent),controls:[...d.querySelectorAll('button')].map(e=>({text:e.innerText,label:e.getAttribute('aria-label')}))}})()`,
};
export { expressions };

const codedError = (code,message) => Object.assign(new Error(message),{code});
const safeError = (error) => {
  const message = String(error?.message ?? error);
  if (/^Ya hay otra extracción|^La sesión de Idealista|^La lista de conversaciones|^El listado|^No se encontró el filtro|^No se pudo comprobar|^No se encontró el chat|^No se pudo verificar|^La conversación cambió|^El perfil no coincide|^No se pudo determinar|^No se puede verificar|^Las fechas de los mensajes|^La hora de un mensaje|^Un mensaje cae|^Un mensaje aparece|^Los datos del periodo|^El inicio de actividad|^Idealista muestra una fecha|^La fecha inicial|^La referencia del anuncio|^No se pudo mostrar/.test(message)) return error;
  if (/draft|borrador/i.test(message)) return new Error('Hay un mensaje sin enviar en la pestaña. Guárdalo o envíalo antes de sincronizar.');
  if (/bloqueado|uso indebido|demasiadas peticiones/i.test(message)) return new Error('Idealista ha bloqueado el acceso. Revisa la pestaña de Chrome antes de reintentar.');
  if (error?.code==='ETIMEDOUT'||/spawnSync\s+osascript\s+ETIMEDOUT|osascript.*(?:timed out|timeout)/i.test(message)) return codedError('CHROME_TIMEOUT','Chrome no respondió a tiempo durante la lectura. Comprueba que la pestaña esté abierta y visible y vuelve a sincronizar.');
  if (/Executing JavaScript through AppleScript is turned off|not (?:allowed|authorized) to send Apple events|automation permission|AppleScript.*(?:turned off|disabled)|\(-1743\)/i.test(message)) return codedError('CHROME_PERMISSION','Chrome no permite JavaScript desde eventos de Apple. Actívalo en Ver → Desarrollador y concede el permiso de automatización.');
  if (/pestaña|tab|window|chrome|application/i.test(message)) return new Error('No se encuentra la pestaña de conversaciones en Chrome. Ábrela e inicia sesión antes de sincronizar.');
  return new Error('La extracción se interrumpió. Revisa la pestaña de Chrome y reintenta.');
};

async function withLock(lockPath, work) {
  await mkdir(path.dirname(lockPath), {recursive:true,mode:0o700});
  let handle;
  try {
    for(let attempt=0;attempt<2;attempt++){
      try { handle=await open(lockPath,'wx',0o600); break; }
      catch(error){
        if(error.code!=='EEXIST')throw error;
        let pid;
        try { pid=Number((await readFile(lockPath,'utf8')).trim()); } catch { /* stale */ }
        if(pid>0){try{process.kill(pid,0);throw new Error('Ya hay otra extracción usando la pestaña de Chrome.');}catch(e){if(e.code!=='ESRCH')throw e;}}
        else if(Date.now()-(await stat(lockPath)).mtimeMs<5000)throw new Error('Ya hay otra extracción usando la pestaña de Chrome.');
        await unlink(lockPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
      }
    }
    if(!handle)throw new Error('Ya hay otra extracción usando la pestaña de Chrome.');
    await handle.writeFile(String(process.pid));
    return await work();
  } finally {if(handle){await handle.close();await unlink(lockPath).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
}
async function save(dir,name,value){
  const target=path.join(dir,name);
  await writeFile(target+'.tmp',typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await rename(target+'.tmp',target);
  return target;
}
const valid = c => c && /^\d+$/.test(c.id??'') && typeof c.date==='string' && c.date.trim().length>0;

async function discover(ev, wait, maxSteps, browserDay, sinceDate, untilDate, allProperties=false){
  const passes=allProperties?2:1;
  let first=null;
  for(let pass=0;pass<passes;pass++){
    ev(expressions.listTop);await wait(150);
    const found=new Map(),observed=new Map();
    let boundary=null,boundaryId=null,bottomChecks=0,incompleteStreak=0,head=null;
    for(let step=0;step<maxSteps;step++){
      const state=ev(expressions.cards);
      if(state.loading || state.cards?.some(c=>!valid(c))){
        if(++incompleteStreak>=20)throw new Error('El listado de Idealista no terminó de cargar las fechas de los chats. Revisa Chrome y reintenta.');
        bottomChecks=0;await wait(250);continue;
      }
      incompleteStreak=0;
      if(head===null && state.scroll?.top===0)head=headSignature(state,browserDay);
      const before=observed.size;
      for(const c of state.cards??[]){
        const observedDay=state.referenceDay??browserDay;
        const activityDate=parseActivityDate(c.date,observedDay);
        if(activityDate>observedDay)throw new Error('Idealista muestra una fecha de actividad que no se puede interpretar. Revisa el listado y reintenta.');
        if(activityDate<sinceDate){boundary=c.date;boundaryId=c.id;break;}
        observed.set(c.id,activityDate);
        if(activityDate<=untilDate)found.set(c.id,{...c,activityDate});
      }
      if(boundary)break;
      const scroll=state.scroll;
      if(scroll && scroll.top+scroll.height>=scroll.total-2){
        bottomChecks=observed.size>before?0:bottomChecks+1;
        if(bottomChecks>=10)break;
        await wait(1500);
      } else {bottomChecks=0;await wait(200);}
      ev(expressions.listStep);
    }
    if(!boundary && bottomChecks<10)throw new Error('No se pudo comprobar el final de los chats de hoy. Reintenta la sincronización.');
    if(allProperties && !boundary && !observed.size)throw new Error('El listado de Idealista no mostró chats ni confirmó que esté vacío. Revisa Chrome y reintenta.');
    const result={cards:[...found.values()].filter(c=>allProperties||c.ad===PROPERTY),boundary,discovered:found.size,
      listIntegrity:boundary?`Límite desde ${sinceDate} comprobado: la siguiente entrada muestra una fecha anterior.`:
        allProperties?'Final del listado estable en dos recorridos.':'Final del listado estable tras diez comprobaciones.',head};
    if(!allProperties)return result;
    const signature=JSON.stringify({cards:[...observed],boundaryId,boundary});
    if(first){
      if(signature!==first.signature || JSON.stringify(head)!==JSON.stringify(first.head))
        throw new Error('El listado de chats cambió durante la sincronización. Revisa Chrome y reintenta.');
      return result;
    }
    first={signature,head};
  }
}

// Each call starts at the head because opening a chat can move the virtualized list.
// The first unseen card is therefore still the next card in Idealista's DOM order.
async function nextRecentCard(ev,wait,maxSteps,browserDay,sinceDate,untilDate,seen,initialHead){
  ev(expressions.listTop);await wait(150);
  let incompleteStreak=0,bottomChecks=0,head=initialHead;
  for(let step=0;step<maxSteps;step++){
    const state=ev(expressions.cards);
    if(state.loading || state.cards?.some(c=>!valid(c))){
      if(++incompleteStreak>=20)throw new Error('El listado de Idealista no terminó de cargar las fechas de los chats. Revisa Chrome y reintenta.');
      bottomChecks=0;await wait(250);continue;
    }
    incompleteStreak=0;
    if(state.scroll?.top===0){
      const currentHead=headSignature(state,browserDay);
      if(head===null)head=currentHead;
      else if(JSON.stringify(head)!==JSON.stringify(currentHead))return {head,changed:true};
    }
    for(const card of state.cards??[]){
      const observedDay=state.referenceDay??browserDay;
      const activityDate=parseActivityDate(card.date,observedDay);
      if(activityDate>observedDay)throw new Error('Idealista muestra una fecha de actividad que no se puede interpretar. Revisa el listado y reintenta.');
      if(activityDate<sinceDate)return {head,card:null};
      if(seen.has(card.id))continue;
      seen.add(card.id);
      if(activityDate<=untilDate)return {head,card:{...card,activityDate}};
    }
    const scroll=state.scroll;
    if(scroll && scroll.top+scroll.height>=scroll.total-2){
      if(++bottomChecks>=10)return {head,card:null};
      await wait(1500);
    }else{bottomChecks=0;await wait(200);}
    ev(expressions.listStep);
  }
  throw new Error('No se pudo comprobar el final de los chats de hoy. Reintenta la sincronización.');
}

function headSignature(state,browserDay){
  if(!state?.cards?.length || state.scroll?.top!==0 || state.cards.some(c=>!valid(c)))return null;
  return state.cards.slice(0,8).map(c=>({id:c.id,date:parseActivityDate(c.date,state.referenceDay??browserDay),
    minute:/^\d{1,2}:\d{2}$/.test(c.date.trim())?c.date.trim().padStart(5,'0'):null}));
}

async function recheckHead(ev,wait,head,browserDay){
  if(!head)return false;
  ev(expressions.listTop);
  let previous=null,stable=0;
  for(let attempt=0;attempt<5;attempt++){
    await wait(150);
    const state=ev(expressions.cards);
    if(state?.loading || state?.scroll?.top!==0 || state?.cards?.some(c=>!valid(c)))continue;
    try {
      const current=JSON.stringify(headSignature(state,browserDay));
      if(current!==JSON.stringify(head))return false;
      stable=current===previous?stable+1:1;
      if(stable>=2)return true;
      previous=current;
    }
    catch {return false;}
  }
  return false;
}

function matchesProperty(url, propertyId){
  try {
    const parsed=new URL(url,'https://www.idealista.com');
    return parsed.hostname==='www.idealista.com' && parsed.pathname.replace(/\/$/,'')===`/inmueble/${propertyId}`;
  } catch {return false;}
}

async function seekAndOpen(ev,wait,id,maxSteps){
  ev(expressions.listTop);await wait(100);
  for(let step=0;step<maxSteps;step++){
    const state=ev(expressions.cards);
    if(state.cards?.some(c=>c.id===id)){
      const openCard=`(()=>{const c=[...document.querySelectorAll('[data-conversation-id]')].find(e=>e.dataset.conversationId===${JSON.stringify(id)})?.querySelector('button[data-testid="list-card-test-id"]');if(!c)throw new Error('Chat fuera del DOM');c.click();return true})()`;
      ev(openCard);return;
    }
    if(state.scroll && state.scroll.top+state.scroll.height>=state.scroll.total-2)break;
    ev(expressions.listStep);await wait(150);
  }
  throw new Error(`No se encontró el chat ${id} al recorrer el listado. Reintenta la sincronización.`);
}

async function verifiedSnapshot(ev,wait,entry){
  let current;
  for(let attempt=0;attempt<4;attempt++){
    current=ev(expressions.snapshot);
    if(current?.activeId===entry.id && current.name===entry.name)return current;
    if(current?.activeId && current.activeId!==entry.id)break;
    if(current?.name && current.name!==entry.name)break;
    if(attempt<3)await wait(400);
  }
  throw new Error(`La conversación cambió durante la lectura del chat ${entry.id} (selección visible: ${current?.activeId??'ninguna'}). Reintenta la sincronización.`);
}

async function extract(ev,wait,entry,maxSteps,propertyId,knownInPeriod=false){
  ev(expressions.closeProfile);await seekAndOpen(ev,wait,entry.id,maxSteps);
  let snapshot=null,observed=null;
  for(let attempt=0;attempt<20;attempt++){
    await wait(500);const current=ev(expressions.snapshot);
    observed=current;
    if(current?.activeId===entry.id && current.name===entry.name && current.messages?.length){snapshot=current;break;}
  }
  if(!snapshot)throw new Error(`No se pudo verificar la conversación ${entry.id} (selección visible: ${observed?.activeId??'ninguna'}). Reintenta la sincronización.`);
  const observedProperties=new Map(snapshot.properties.map(p=>[p.url,p]));
  let unchanged=0,lastText='',maximumCount=snapshot.messages.length,virtualized=false;
  for(let attempt=0;attempt<60 && unchanged<2;attempt++){
    ev(expressions.historyTop);await wait(650);snapshot=await verifiedSnapshot(ev,wait,entry);
    for(const property of snapshot.properties)observedProperties.set(property.url,property);
    virtualized ||= snapshot.messages.length<maximumCount;maximumCount=Math.max(maximumCount,snapshot.messages.length);
    unchanged=snapshot.historyText===lastText && snapshot.scroll.top===0?unchanged+1:0;lastText=snapshot.historyText;
  }
  const oldest=snapshot.historyText;
  ev(expressions.historyBottom);await wait(450);snapshot=await verifiedSnapshot(ev,wait,entry);
  for(const property of snapshot.properties)observedProperties.set(property.url,property);
  virtualized ||= snapshot.historyText!==oldest;
  if(propertyId){
    if(!observedProperties.size){
      if(!knownInPeriod)return {unverifiedProperty:true};
    }else if(![...observedProperties.values()].some(p=>matchesProperty(p.url,propertyId)))return null;
  }
  let profile=null;
  if(snapshot.profileAvailable){
    ev(expressions.openProfile);
    for(let attempt=0;attempt<15;attempt++){await wait(300);profile=ev(expressions.profile);if(profile)break;}
    if(profile && profile.title!==`Perfil de ${entry.name}`)throw new Error('El perfil no coincide con el chat. Reintenta la sincronización.');
    ev(expressions.closeProfile);
  }
  const hasAttachments=snapshot.messages.some(m=>m.attachments.length||m.media.length);
  const unexploredControls=snapshot.historyButtons.filter(b=>b.text!=='Traducir');
  const integrity={history:unchanged>=2&&!virtualized&&!unexploredControls.length&&!hasAttachments?'completo':'parcial',profile:profile&&profile.controls.length===1?'completo':snapshot.profileAvailable?'parcial':'no disponible',notes:[
    'Fechas y horas conservadas como las muestra Idealista; no se infieren fechas absolutas para mensajes.',
    'Historial desplazado al inicio hasta permanecer estable y verificado de nuevo al final.',
    ...(propertyId&&!observedProperties.size&&knownInPeriod?['El enlace del anuncio no está visible; se conserva la vinculación previamente guardada para este chat, anuncio y periodo.']:[]),
    ...(unchanged<2?['El historial no se estabilizó durante la carga; requiere revisión.']:[]),
    ...(virtualized?['El contenido cambió al recorrer el historial; requiere revisión.']:[]),
    ...(unexploredControls.length?['Hay controles en el historial; revisar si falta contenido.']:[]),
    ...(hasAttachments?['Adjuntos detectados: contenido pendiente de revisión, no descargado.']:[]),
    ...(!snapshot.profileAvailable?['No hay botón Ver perfil; se conservan los perfiles incluidos en mensajes si existen.']:[])],};
  return {id:entry.id,name:entry.name,listedDate:entry.date,activityDate:entry.activityDate,exportedAt:new Date().toISOString(),source:'Pestaña autenticada de Chrome; lectura del DOM mediante Apple Events',...snapshot,properties:[...observedProperties.values()],profile,integrity};
}

/** Browser and timing dependencies are injectable; the default uses the already open Chrome tab. */
export async function exportToday({knownIds=[],sinceDate,untilDate,propertyId,periodId,activityStartsAt,includeLegacyHistory=false,refreshExisting=false,sync=false,limit=Infinity,scanMode='full',canEarlyStop=false,baselineById={},unchangedThreshold=5,connectBrowser=connect,wait=sleep,root=ROOT,maxListSteps=200,onProgress=()=>{}}={}){
  if (!refreshExisting && !PROPERTY) throw new Error('El anuncio heredado no está configurado en los datos privados locales.');
  process.umask(0o077);
  return withLock(path.join(root,'extraction.lock'),async()=>{
    try {
      if(periodId!==undefined && (!validPeriodId(periodId)||!refreshExisting||!sync||!/^\d+$/.test(propertyId??'')||!isoDate(sinceDate)||!isoDate(untilDate)||typeof activityStartsAt!=='string'||!Number.isFinite(Date.parse(activityStartsAt))||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(activityStartsAt)||typeof includeLegacyHistory!=='boolean'))throw new Error('Los datos del periodo de sincronización no son válidos.');
      if(periodId===undefined && (activityStartsAt!==undefined||includeLegacyHistory))throw new Error('Los datos del periodo de sincronización no son válidos.');
      if(periodId && includeLegacyHistory!==periodId.startsWith('initial:'))throw new Error('Los datos del periodo de sincronización no son válidos.');
      if(!['full','incremental'].includes(scanMode)||typeof canEarlyStop!=='boolean'||
          !baselineById||typeof baselineById!=='object'||Array.isArray(baselineById)||
          !Object.entries(baselineById).every(([id,hash])=>/^\d+$/.test(id)&&(hash===null||typeof hash==='string'&&/^[0-9a-f]{64}$/.test(hash)))||
          unchangedThreshold!==5 || (!periodId && (scanMode!=='full'||canEarlyStop||Object.keys(baselineById).length)))
        throw new Error('Los datos del periodo de sincronización no son válidos.');
      if(periodId){const clock=madridClock(activityStartsAt);const startDay=`${clock.year}-${clock.month}-${clock.day}`;if(startDay<sinceDate||startDay>untilDate)throw new Error('El inicio de actividad del periodo no es válido.');}
      onProgress({phase:'connecting'});
      const ev=connectBrowser();
      const initial=ev(expressions.draft);
      if(initial?.blocked)throw new Error('Idealista ha bloqueado el acceso');
      if(initial?.draft)throw new Error('draft');
      onProgress({phase:'refreshing'});
      ev.activate?.();
      let visible=false;
      for(let i=0;i<10;i++){
        if(ev(expressions.visibility)==='visible'){visible=true;break;}
        await wait(500);
      }
      if(!visible)throw new Error('No se pudo mostrar la pestaña de Idealista en Chrome. Selecciónala y reintenta.');
      ev(expressions.reload);
      let ready=false;
      for(let i=0;i<30;i++){
        await wait(500);
        const state=ev(expressions.ready);
        if(state?.blocked)throw new Error('Idealista ha bloqueado el acceso');
        if(state?.login)throw new Error('La sesión de Idealista ha caducado. Inicia sesión en la pestaña de Chrome.');
        if(state?.ready){ready=true;break;}
      }
      if(!ready)throw new Error('La lista de conversaciones no terminó de cargar. Revisa Chrome y reintenta.');
      if(!ev(expressions.selectAll))throw new Error('No se encontró el filtro «Todos» en las conversaciones. Revisa Chrome y reintenta.');
      for(let i=0;i<10;i++){
        await wait(250);
        if(ev(expressions.ready)?.ready)break;
        if(i===9)throw new Error('El listado «Todos» no terminó de cargar. Revisa Chrome y reintenta.');
      }
      const day=ev(expressions.day);
      if(!isoDate(day))throw new Error('No se pudo determinar la fecha local del navegador.');
      const cutoff=sinceDate??day;
      const end=untilDate??day;
      if(!isoDate(cutoff)||!isoDate(end)||cutoff>end||end>day)throw new Error('La fecha inicial o final de sincronización no es válida.');
      if(refreshExisting && (!sync||typeof propertyId!=='string'||!/^\d+$/.test(propertyId)))throw new Error('La referencia del anuncio no es válida.');
      const dir=path.join(root,'exports',day,...(refreshExisting?[`property-${propertyId}`]:[]),...(periodId?[`period-${encodeURIComponent(periodId)}`]:[]));
      await mkdir(dir,{recursive:true,mode:0o700});
      ev(expressions.closeProfile);
      onProgress({phase:'discovering'});
      const streamIncremental=periodId && scanMode==='incremental' && canEarlyStop;
      const seen=new Set();
      let streaming=Boolean(streamIncremental);
      let scan=streaming?{cards:[],boundary:null,discovered:0,listIntegrity:'Recorrido reciente en curso.',head:null}:
        await discover(ev,wait,maxListSteps,day,cutoff,end,refreshExisting);
      if(streaming){
        const next=await nextRecentCard(ev,wait,maxListSteps,day,cutoff,end,seen,null);
        scan.head=next.head;
        if(next.card){scan.cards.push(next.card);scan.discovered=1;}
        else{streaming=false;scan=await discover(ev,wait,maxListSteps,day,cutoff,end,refreshExisting);}
      }
      const known=new Set(knownIds.map(String));
      let candidates=sync&&!refreshExisting?scan.cards.filter(c=>!known.has(c.id)):scan.cards;
      onProgress({phase:'exporting',discovered:scan.discovered,candidates:candidates.length,exported:0,examined:0});
      let index;
      try {index=JSON.parse(await readFile(path.join(dir,'index.json'),'utf8'));}catch{index=null;}
      if(!index || index.date!==day)index={date:day,timezone:'Europe/Madrid',criterion:'Conversaciones encontradas en las búsquedas ejecutadas este día; historial completo de cada chat guardado.',property:`https://www.idealista.com/inmueble/${refreshExisting?propertyId:DEFAULT_PROPERTY_ID}/`,startedAt:new Date().toISOString(),conversations:[]};
      index.property=`https://www.idealista.com/inmueble/${refreshExisting?propertyId:DEFAULT_PROPERTY_ID}/`;
      if(periodId)Object.assign(index,{periodId,propertyId,sinceDate:cutoff,untilDate:end,activityStartsAt,includeLegacyHistory});
      Object.assign(index,{scanStatus:'in_progress',fullCoverage:false,earlyStopped:false});
      index.criterion=`Conversaciones encontradas en las búsquedas ejecutadas el ${day}; última búsqueda de actividad desde ${cutoff} hasta ${end}. Historial completo de cada chat guardado.`;
      index.sinceDate=cutoff;index.untilDate=end;index.listIntegrity=scan.listIntegrity;index.boundaryDate=scan.boundary;
      const entries=new Map(index.conversations.map(c=>[c.id,c]));
      if(!refreshExisting)for(const card of scan.cards)entries.set(card.id,{...entries.get(card.id),...card,status:entries.get(card.id)?.status??'pendiente'});
      index.conversations=[...entries.values()];await save(dir,'index.json',index);
      let files=[];let exported=0,processed=0,skippedProperty=0,skippedUnverified=0,skippedNoPeriodActivity=0;
      let examined=0,earlyStopped=false,stopReason=null,unchangedStreak=0,finalVisited=0,headRechecked=false;
      let effectiveMode=streaming&&scan.head?'incremental':'full';
      let restarted=false;
      for(let cursor=0;;cursor++){
        if(cursor>=candidates.length){
          if(!streaming)break;
          const next=await nextRecentCard(ev,wait,maxListSteps,day,cutoff,end,seen,scan.head);
          if(next.card && !next.changed){
            scan.cards.push(next.card);scan.discovered=scan.cards.length;
          }else{
            const complete=await discover(ev,wait,maxListSteps,day,cutoff,end,refreshExisting);
            const completeCandidates=complete.cards;
            const prefixMatches=!next.changed&&candidates.every((card,i)=>
              completeCandidates[i]?.id===card.id && completeCandidates[i]?.activityDate===card.activityDate);
            streaming=false;scan=complete;candidates=completeCandidates;
            index.listIntegrity=scan.listIntegrity;index.boundaryDate=scan.boundary;
            if(!prefixMatches){
              if(restarted)throw new Error('El listado de chats cambió durante la sincronización. Revisa Chrome y reintenta.');
              restarted=true;effectiveMode='full';unchangedStreak=0;
              files=[];exported=0;processed=0;skippedProperty=0;skippedUnverified=0;skippedNoPeriodActivity=0;finalVisited=0;
              cursor=-1;continue;
            }
            if(cursor>=candidates.length)break;
          }
        }
        if(processed>=limit)break;
        const card=candidates[cursor];
        finalVisited++;
        const entry={...entries.get(card.id),...card};
        if(!sync){
          try {const prev=JSON.parse(await readFile(path.join(dir,`${entry.id}.json`),'utf8'));
            if(prev.listedDate===entry.date&&prev.integrity?.history==='completo'&&['completo','no disponible'].includes(prev.integrity.profile))continue;
          }catch{ /* pending */ }
        }
        examined++;
        const result=await extract(ev,wait,entry,maxListSteps,refreshExisting?propertyId:null,Boolean(periodId)&&known.has(card.id));
        onProgress({phase:'exporting',discovered:scan.discovered,candidates:candidates.length,exported,examined});
        if(!result){skippedProperty++;continue;}
        if(result.unverifiedProperty){
          if(!periodId)throw new Error(`No se pudo comprobar el anuncio del chat ${entry.id}. No muestra el enlace del anuncio en Chrome.`);
          skippedUnverified++;unchangedStreak=0;continue;
        }
        if(periodId){
          const incomplete=result.integrity.notes.some(note=>/virtualiz|contenido cambió|controles en el historial|estabiliz|historial.*carg/i.test(note));
          if(incomplete)throw new Error(`No se pudo verificar el historial completo del chat ${entry.id}. Revisa Chrome y reintenta.`);
          result.messages=resolveMessages(result.messages,result.referenceDay??day,result.activityDate,result.referenceAt);
          result.periodMessages=projectPeriodMessages(result.messages,{sinceDate:cutoff,untilDate:end,activityStartsAt,includeLegacyHistory});
          Object.assign(result,{periodId,propertyId,sinceDate:cutoff,untilDate:end,activityStartsAt,includeLegacyHistory});
          if(!includeLegacyHistory&&!result.periodMessages.length){skippedNoPeriodActivity++;unchangedStreak=0;continue;}
        }
        const fingerprint=periodId?fingerprintMessageHistory(result.periodMessages):null;
        const comparable=effectiveMode==='incremental'&&known.has(card.id)&&fingerprint!==null&&baselineById[card.id]===fingerprint;
        unchangedStreak=comparable?Math.min(unchangedStreak+1,unchangedThreshold):0;
        entries.set(card.id,entry);index.conversations=[...entries.values()];
        const file=await save(dir,`${entry.id}.json`,result);
        const md=[`# ${entry.name}`,`Chat: ${entry.id} · Extraído: ${result.exportedAt}`,`Historial: ${result.integrity.history} · Ficha: ${result.integrity.profile}`,`## Anuncio`,...result.properties.map(p=>`${p.text}\n${p.url}`),`## Conversación`,...result.messages.map(m=>`### ${m.dateLabel??'Fecha no disponible'} · ${m.time??'Hora no disponible'} · ${m.author}\n\n${m.rawText}`),`## Ficha de inquilino`,result.profile?.text??'No disponible en Ver perfil.',`## Integridad`,...result.integrity.notes.map(n=>`- ${n}`),`## Historial visible original`,result.historyText].join('\n\n')+'\n';
        await save(dir,`${entry.id}.md`,md);
        Object.assign(entry,{status:'guardado',messages:result.messages.length,profile:result.integrity.profile,history:result.integrity.history});
        await save(dir,'index.json',index);files.push(file);exported++;processed++;
        onProgress({phase:'exporting',discovered:scan.discovered,candidates:candidates.length,exported,examined});
        if(effectiveMode==='incremental'&&!skippedUnverified&&unchangedStreak>=unchangedThreshold&&(streaming||cursor<candidates.length-1)){
          if(await recheckHead(ev,wait,scan.head,day)){
            headRechecked=true;earlyStopped=true;stopReason='unchanged_streak';break;
          }
          // A moving or unverifiable head invalidates the shortcut. Rediscover once,
          // then reread every candidate, including those seen in the first pass.
          if(restarted)throw new Error('El listado de chats cambió durante la sincronización. Revisa Chrome y reintenta.');
          restarted=true;effectiveMode='full';unchangedStreak=0;
          streaming=false;
          scan=await discover(ev,wait,maxListSteps,day,cutoff,end,refreshExisting);
          candidates=sync&&!refreshExisting?scan.cards.filter(c=>!known.has(c.id)):scan.cards;
          files=[];exported=0;processed=0;skippedProperty=0;skippedUnverified=0;skippedNoPeriodActivity=0;finalVisited=0;
          index.listIntegrity=scan.listIntegrity;index.boundaryDate=scan.boundary;
          onProgress({phase:'exporting',discovered:scan.discovered,candidates:candidates.length,exported:0,examined});
          cursor=-1;
        }
      }
      if(restarted){
        if(!(await recheckHead(ev,wait,scan.head,day)))
          throw new Error('El listado de chats cambió durante la sincronización. Revisa Chrome y reintenta.');
        headRechecked=true;
      }
      if(!earlyStopped && !headRechecked && scan.head){
        if(!(await recheckHead(ev,wait,scan.head,day)))
          throw new Error('El listado de chats cambió durante la sincronización. Revisa Chrome y reintenta.');
        headRechecked=true;
      }
      const fullCoverage=!earlyStopped&&!skippedUnverified&&finalVisited===candidates.length;
      if(earlyStopped){
        index.listIntegrity='Recorrido reciente detenido tras cinco chats sin cambios; final del listado no comprobado.';
        index.boundaryDate=null;
      }
      if(skippedUnverified)index.listIntegrity+=` ${skippedUnverified} chats sin anuncio verificable; no se importaron y la cobertura no es completa.`;
      Object.assign(index,{scanStatus:'complete',requestedMode:scanMode,effectiveMode,examined,earlyStopped,stopReason,unchangedStreak,unchangedThreshold,fullCoverage,headRechecked,skippedUnverified});
      index.updatedAt=new Date().toISOString();await save(dir,'index.json',index);
      await save(dir,'index.md',`# Chats de ${day}\n\n${index.criterion}\n\n${index.listIntegrity}\n\n`+index.conversations.map(e=>`- [${e.name}](${e.id}.md) — ${e.date} — ${e.status}${e.messages!==undefined?` — ${e.messages} mensajes — ficha: ${e.profile}`:''}`).join('\n')+'\n');
      return {date:day,periodId:periodId??null,propertyId:refreshExisting?propertyId:null,sinceDate:cutoff,untilDate:end,activityStartsAt:activityStartsAt??null,includeLegacyHistory,files,discovered:scan.discovered,candidates:candidates.length,exported,skippedProperty,skippedUnverified,skippedNoPeriodActivity,requestedMode:scanMode,effectiveMode,examined,earlyStopped,stopReason,unchangedStreak,unchangedThreshold,fullCoverage,headRechecked,directory:dir};
    } catch(error){throw safeError(error);}
  });
}
