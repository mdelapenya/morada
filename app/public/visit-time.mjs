const formatters=new Map();

function formatter(timezone) {
  let value=formatters.get(timezone);
  if(!value) {
    value=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',
      day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    formatters.set(timezone,value);
  }
  return value;
}

export function normalizeTimeZone(value) {
  if(typeof value!=='string'||!value||value.length>100||
    /^[+-]/.test(value)||/^(?:UTC|GMT)[+-]/i.test(value))
    throw new Error('Zona horaria no válida');
  try { return new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone; }
  catch { throw new Error('Zona horaria no válida'); }
}

function utcDate(year,month,day,hour=0,minute=0) {
  const date=new Date(0);
  date.setUTCFullYear(year,month-1,day);
  date.setUTCHours(hour,minute,0,0);
  return date.getTime();
}

function validateDate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error('Fecha no válida');
  const [year,month,day]=value.split('-').map(Number);
  const check=new Date(utcDate(year,month,day));
  if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day)
    throw new Error('Fecha no válida');
  return {year,month,day};
}

function zoneParts(instant,timezone) {
  const values=Object.fromEntries(formatter(timezone).formatToParts(new Date(instant))
    .filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  const date=`${String(values.year).padStart(4,'0')}-${String(values.month).padStart(2,'0')}-${String(values.day).padStart(2,'0')}`;
  const time=`${String(values.hour).padStart(2,'0')}:${String(values.minute).padStart(2,'0')}`;
  const local=utcDate(values.year,values.month,values.day,values.hour,values.minute)+values.second*1000;
  return {date,time,utcOffsetMinutes:Math.round((local-instant)/60000)};
}

export function localDateTimeParts(instant,timezone) {
  const zone=normalizeTimeZone(timezone);
  const milliseconds=typeof instant==='number'?instant:Date.parse(instant);
  if(!Number.isFinite(milliseconds)) throw new Error('Instante no válido');
  return zoneParts(milliseconds,zone);
}

export function localTimeCandidates(startLocal,timezone) {
  const zone=normalizeTimeZone(timezone);
  if(typeof startLocal!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startLocal))
    throw new Error('Fecha y hora no válidas');
  const {year,month,day}=validateDate(startLocal.slice(0,10));
  const hour=Number(startLocal.slice(11,13)),minute=Number(startLocal.slice(14,16));
  if(hour>23||minute>59) throw new Error('Fecha y hora no válidas');
  const base=utcDate(year,month,day,hour,minute);
  const offsets=new Set();
  for(let delta=-48;delta<=48;delta+=6)
    offsets.add(zoneParts(base+delta*3600000,zone).utcOffsetMinutes);
  const matches=[];
  for(const offset of offsets) {
    const milliseconds=base-offset*60000;
    const fields=zoneParts(milliseconds,zone);
    if(`${fields.date}T${fields.time}`===startLocal&&fields.utcOffsetMinutes===offset)
      matches.push({instant:new Date(milliseconds).toISOString(),utcOffsetMinutes:offset});
  }
  return matches.sort((a,b)=>a.instant.localeCompare(b.instant));
}

export function addCivilDays(date,amount) {
  const {year,month,day}=validateDate(date);
  if(!Number.isInteger(amount)) throw new Error('Número de días no válido');
  const result=new Date(utcDate(year,month,day)+amount*86400000);
  if(!Number.isFinite(result.getTime())||result.getUTCFullYear()<1||result.getUTCFullYear()>9999)
    throw new Error('Fecha fuera de rango');
  return `${String(result.getUTCFullYear()).padStart(4,'0')}-${String(result.getUTCMonth()+1).padStart(2,'0')}-${String(result.getUTCDate()).padStart(2,'0')}`;
}

function firstInstantOnOrAfter(date,zone) {
  const {year,month,day}=validateDate(date);
  const center=utcDate(year,month,day);
  let low=center-48*3600000,high=center+48*3600000;
  if(zoneParts(low,zone).date>=date||zoneParts(high,zone).date<date)
    throw new Error('Fecha fuera de rango');
  while(high-low>60000) {
    const middle=low+Math.floor((high-low)/120000)*60000;
    if(zoneParts(middle,zone).date>=date) high=middle;
    else low=middle;
  }
  return new Date(high).toISOString();
}

export function civilDayBounds(date,timezone) {
  const zone=normalizeTimeZone(timezone);
  return {startsAt:firstInstantOnOrAfter(date,zone),
    endsAt:firstInstantOnOrAfter(addCivilDays(date,1),zone)};
}
