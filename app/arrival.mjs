const emptyArrival=()=>({arrivalDate:null,arrivalAt:null});
const madridFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',
  hourCycle:'h23'});

function validDay(value) {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value;
}

function validInstant(value) {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===
      (value.includes('.')?value:value.replace('Z','.000Z'));
}

function madridParts(value) {
  return Object.fromEntries(madridFormatter.formatToParts(new Date(value))
    .filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
}

function localDay(value) {
  const fields=madridParts(value);
  return `${fields.year}-${fields.month}-${fields.day}`;
}

/** A profile card or unexplained raw DOM text is not proof of a chat message. */
export function semanticMessageContent(message) {
  if((typeof message?.text==='string' && message.text.trim()) ||
    (Array.isArray(message?.attachments) && message.attachments.length)) return true;
  if(message?.embeddedProfile) return false;
  if(Array.isArray(message?.media) && message.media.length) return true;
  return typeof message?.rawText==='string' && message.rawText.trim() ? null : false;
}

/** inside/outside/uncertain relative to a Madrid period and optional closure. */
export function periodMessagePosition(message,periodStartDate,activityStartsAt,closedAt=null) {
  if(!message || !validDay(periodStartDate) || !validInstant(activityStartsAt) ||
    (closedAt!==null && !validInstant(closedAt)) || !validDay(message.messageDate) ||
    (message.datePrecision!==undefined && message.datePrecision!=='day')) return 'uncertain';
  const hasInstant=message.occurredAt!==null && message.occurredAt!==undefined;
  if(hasInstant && (!validInstant(message.occurredAt) ||
    localDay(message.occurredAt)!==message.messageDate ||
    Date.parse(message.occurredAt)%60000!==0 ||
    (message.timePrecision!==undefined && message.timePrecision!=='minute'))) return 'uncertain';
  const lower=Date.parse(activityStartsAt),lowerParts=madridParts(activityStartsAt);
  const lowerDay=`${lowerParts.year}-${lowerParts.month}-${lowerParts.day}`;
  if(message.messageDate<periodStartDate || message.messageDate<lowerDay) return 'outside';
  if(message.messageDate===lowerDay){
    if(hasInstant){
      const start=Date.parse(message.occurredAt);
      if(start+60_000<=lower) return 'outside';
      if(start<=lower) return 'uncertain';
    }else if(lowerParts.hour!=='00'||lowerParts.minute!=='00'||
      lowerParts.second!=='00'||lower%1000!==0) return 'uncertain';
  }
  if(closedAt!==null){
    const upper=Date.parse(closedAt),upperDay=localDay(closedAt);
    if(message.messageDate>upperDay) return 'outside';
    if(message.messageDate===upperDay){
      if(!hasInstant) return 'uncertain';
      const start=Date.parse(message.occurredAt);
      if(start>=upper) return 'outside';
      if(start+60_000>upper) return 'uncertain';
    }
  }
  return 'inside';
}

export function manualArrival(createdDate,createdAt) {
  if (!validDay(createdDate)) return emptyArrival();
  return {arrivalDate:createdDate,arrivalAt:validInstant(createdAt) &&
    localDay(createdAt)===createdDate ? createdAt : null};
}

/** The first verified incoming contact inside a search period, never latest list activity. */
export function importedArrival(messages,periodStartDate,activityStartsAt,closedAt=null) {
  if (!Array.isArray(messages) || !validDay(periodStartDate) ||
    !validInstant(activityStartsAt)) return emptyArrival();
  const candidates=[];
  for(const message of messages){
    if(!['received','incoming'].includes(message?.direction) ||
      semanticMessageContent(message)!==true ||
      periodMessagePosition(message,periodStartDate,activityStartsAt,closedAt)!=='inside') continue;
    candidates.push({day:message.messageDate,instant:message.occurredAt??null});
  }
  if(!candidates.length) return emptyArrival();
  const day=candidates.map(item=>item.day).sort()[0];
  const firstDay=candidates.filter(item=>item.day===day);
  return {arrivalDate:day,arrivalAt:firstDay.every(item=>item.instant!==null) ?
    firstDay.map(item=>item.instant).sort()[0] : null};
}
